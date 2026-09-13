'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseMasterReferenceCsv } from '@/lib/parseMasterReferenceCsv';
import { parseCatalogInventory } from '@/lib/parseCatalogPdf';
import { capMaxQtyByWeight } from '@/lib/packing';
import { masterRefDuplicateKey, normalizeSku } from '@/lib/masterRefKeys';
import type { KeepaEnrichResult } from '@/lib/keepa';

type Row = {
  id?: string;
  /** Optional: SKU is the identity. May be '' or null for rows without an ASIN. */
  asin: string | null;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
  updated_at?: string;
};

/** 'merge': nulls never overwrite existing values (imports). 'replace': write as-is (row editor). */
type WriteMode = 'merge' | 'replace';

const hasValue = (v: unknown) => v != null && v !== '';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Look up rows whose SKU matches ignoring case/whitespace; an exact SKU match is listed first. */
function indexBySku(existing: Row[]): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  for (const row of existing) {
    const key = normalizeSku(row.sku);
    const list = index.get(key) || [];
    list.push(row);
    index.set(key, list);
  }
  return index;
}

function findExisting(index: Map<string, Row[]>, sku: string): Row | undefined {
  const matches = index.get(normalizeSku(sku));
  if (!matches?.length) return undefined;
  return matches.find((m) => m.sku === sku) ?? matches[0];
}

/** Collapse repeated SKUs (case/whitespace-insensitive) within one file, keeping the last occurrence. */
function collapseBySku<T extends { sku: string }>(items: T[]): { items: T[]; collapsed: number } {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(normalizeSku(item.sku), item);
  return { items: [...byKey.values()], collapsed: items.length - byKey.size };
}

const completeness = (row: Row) =>
  [row.weight_lb, row.max_qty_per_box, row.product_name, row.asin].filter(hasValue).length;

/** Fill the keeper's blank fields from the duplicates; the keeper's own values always win. */
function fillMissing(keeper: Row, others: Row[]): Row {
  const merged: Row = { ...keeper };
  for (const other of others) {
    if (!hasValue(merged.asin) && hasValue(other.asin)) merged.asin = other.asin;
    if (merged.weight_lb == null && other.weight_lb != null) merged.weight_lb = other.weight_lb;
    if (merged.max_qty_per_box == null && other.max_qty_per_box != null) {
      merged.max_qty_per_box = other.max_qty_per_box;
    }
    if (!hasValue(merged.product_name) && hasValue(other.product_name)) {
      merged.product_name = other.product_name;
    }
  }
  return merged;
}

const sameValues = (a: Row, b: Row) =>
  (a.asin || null) === (b.asin || null) &&
  a.weight_lb === b.weight_lb &&
  a.max_qty_per_box === b.max_qty_per_box &&
  (a.product_name || null) === (b.product_name || null);

type DuplicateGroup = { keeper: Row; merged: Row; remove: Row[] };

/**
 * True 1-to-1 duplicates: same SKU AND same ASIN once trimmed/uppercased.
 * Keep the most complete row (latest updated_at on ties) and merge the rest into it.
 */
function findExactDuplicates(all: Row[]): DuplicateGroup[] {
  const groups = new Map<string, Row[]>();
  for (const row of all) {
    const key = masterRefDuplicateKey(row.sku, row.asin);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const result: DuplicateGroup[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) =>
        completeness(b) - completeness(a) ||
        (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    );
    const [keeper, ...remove] = sorted;
    result.push({ keeper, merged: fillMissing(keeper, remove), remove });
  }
  return result;
}

type EnrichProgress = {
  completed: number;
  total: number;
  enriched: number;
  failed: number;
  status: string;
};

type QueueItem = { asin: string; attempts: number };

/** Everything needed to continue an enrichment run after it pauses or fails. */
type EnrichRun = {
  queue: QueueItem[];
  total: number;
  completed: number;
  enriched: number;
  failed: number;
  summaryParts: string[];
  dedupeNote: string;
  sourceRows: Map<string, Row[]>;
};

type RunStop = { reason: 'paused' | 'error'; message?: string };

type BatchResponse =
  | { ok: true; results: KeepaEnrichResult[] }
  | { ok: false; error: string; paused: boolean };

type EnrichResponseBody = {
  results?: KeepaEnrichResult[];
  error?: string;
  configured?: boolean;
  refillIn?: number;
};

const ENRICH_BATCH_SIZE = 10;
const ENRICH_BATCH_DELAY_MS = 35_000;
const MAX_RATE_LIMIT_RETRIES = 3;
/** Backoff between attempts when a whole batch request fails transiently (network, 5xx, 429). */
const BATCH_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
/** Longest we honour a Keepa refill hint before trying again. */
const MAX_REFILL_WAIT_MS = 120_000;
const PAUSE_POLL_MS = 500;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (message: unknown) =>
  /(?:429|rate.?limit|token|refill|too many requests)/i.test(String(message || ''));

const isRetryableResult = (result: KeepaEnrichResult) =>
  result.retryable === true || isRateLimitError(result.error);

/** Turn a Keepa `refillIn` hint into a wait (with a little slack), capped so a bad hint can't hang the run. */
const refillWaitMs = (refillIn: number | undefined) =>
  typeof refillIn === 'number' && refillIn > 0 ? Math.min(refillIn + 1_000, MAX_REFILL_WAIT_MS) : 0;

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;

function buildSourceRows(all: Row[]): Map<string, Row[]> {
  const sourceRows = new Map<string, Row[]>();
  for (const row of all) {
    if (!row.asin) continue;
    const matches = sourceRows.get(row.asin) || [];
    matches.push(row);
    sourceRows.set(row.asin, matches);
  }
  return sourceRows;
}

export default function SettingsMasterRef() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [keepaBusy, setKeepaBusy] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);
  const [pausedRun, setPausedRun] = useState<EnrichRun | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const pauseRequestedRef = useRef(false);
  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const showToast = (m: string, durationMs = 4000) => {
    setToast(m);
    setTimeout(() => setToast(null), durationMs);
  };

  const fetchRows = useCallback(async (): Promise<Row[]> => {
    const res = await fetch('/api/master-reference');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load');
    return (json.rows || []) as Row[];
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchRows());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [fetchRows]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Freshest copy of the master list for duplicate checks; falls back to what is on screen. */
  const currentRows = async (): Promise<Row[]> => {
    try {
      return await fetchRows();
    } catch {
      return rows;
    }
  };

  const upsertRows = async (incoming: Row[], reloadAfter = true, mode: WriteMode = 'merge') => {
    const res = await fetch('/api/master-reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: incoming, mode }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upsert failed');
    if (reloadAfter) await load();
    return {
      upserted: json.upserted as number,
      duplicatesCollapsed: (json.duplicatesCollapsed as number) || 0,
    };
  };

  const deleteRow = async (row: Row) => {
    const param = row.id
      ? `id=${encodeURIComponent(row.id)}`
      : `sku=${encodeURIComponent(row.sku)}`;
    const res = await fetch(`/api/master-reference?${param}`, { method: 'DELETE' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error((json as { error?: string }).error || 'Delete failed');
    }
  };

  const importCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = parseMasterReferenceCsv(String(reader.result));
        const { items: parsedRows, collapsed } = collapseBySku(result.rows.filter((r) => r.sku));
        if (parsedRows.length === 0) {
          showToast('No rows with a SKU. SKU is required for every row.');
          return;
        }

        const existingIndex = indexBySku(await currentRows());
        let newCount = 0;
        let existingCount = 0;
        const mapped: Row[] = parsedRows.map((r) => {
          const match = findExisting(existingIndex, r.sku);
          if (match) existingCount++;
          else newCount++;
          return {
            asin: r.asin ?? null,
            // Reuse the stored SKU so a case/whitespace variant updates that row instead of adding one.
            sku: match ? match.sku : r.sku,
            weight_lb: r.weight,
            max_qty_per_box: r.maxQtyPerBox,
            product_name: r.productName ?? null,
          };
        });
        const { upserted: n } = await upsertRows(mapped);
        showToast(
          `Imported ${plural(n, 'row')}: ${newCount} new, ${existingCount} already in master reference (updated with CSV values).` +
            (collapsed ? ` Collapsed ${plural(collapsed, 'repeated SKU')} in the file.` : '') +
            (result.rejected.length ? ` ${result.rejected.length} rejected.` : ''),
          8000
        );
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Import failed');
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const importPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPdfBusy(true);
    setError(null);
    try {
      const pdfjs = await import('pdfjs-dist');
      // Use CDN worker matching installed pdfjs version
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      const buf = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ');
        text += pageText + '\n';
      }
      const { rows: parsed, duplicatesCollapsed } = parseCatalogInventory(text);
      if (parsed.length === 0) {
        showToast('No ASIN/SKU pairs found in PDF. Export Manage Inventory from Seller Central.');
        return;
      }

      // Compare against the current master list: new SKUs are added; SKUs already present
      // keep every existing value and only get blank ASIN / product name filled in.
      const existingIndex = indexBySku(await currentRows());
      const toWrite: Row[] = [];
      let newCount = 0;
      let existingCount = 0;
      let filledCount = 0;
      for (const r of parsed) {
        const match = findExisting(existingIndex, r.sku);
        if (!match) {
          newCount++;
          toWrite.push({
            asin: r.asin,
            sku: r.sku,
            weight_lb: null,
            max_qty_per_box: null,
            product_name: r.productName || null,
          });
          continue;
        }
        existingCount++;
        const fillAsin = !hasValue(match.asin) && !!r.asin;
        const fillName = !hasValue(match.product_name) && !!r.productName;
        if (fillAsin || fillName) {
          filledCount++;
          toWrite.push({
            asin: fillAsin ? r.asin : match.asin,
            sku: match.sku,
            weight_lb: match.weight_lb,
            max_qty_per_box: match.max_qty_per_box,
            product_name: fillName ? r.productName : match.product_name,
          });
        }
      }

      if (toWrite.length > 0) await upsertRows(toWrite);

      const kept =
        existingCount > 0
          ? ` (kept existing values${filledCount ? `; filled in blank ASIN/name on ${filledCount}` : ''})`
          : '';
      const inFile = duplicatesCollapsed
        ? ` Collapsed ${plural(duplicatesCollapsed, 'repeated SKU')} in the PDF.`
        : '';
      showToast(
        newCount === 0
          ? `Catalog PDF: no new products — all ${plural(existingCount, 'SKU')} are already in the master reference${kept}.${inFile}`
          : `Imported ${plural(parsed.length, 'row')} from catalog PDF: ${newCount} new, ${existingCount} already in master reference${kept}.${inFile} Use API Enrich for missing weight/max.`,
        10000
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'PDF parse failed');
    } finally {
      setPdfBusy(false);
    }
  };

  /**
   * Remove true 1-to-1 duplicates (same normalized SKU + ASIN). The keeper is written
   * first with fields merged from the others, then the others are deleted, so a failure
   * midway never loses data. Per-group failures are reported but do not stop the caller.
   */
  const removeExactDuplicates = async (
    all: Row[]
  ): Promise<{ rows: Row[]; removed: number; failures: string[] }> => {
    const groups = findExactDuplicates(all);
    if (groups.length === 0) return { rows: all, removed: 0, failures: [] };

    const removedRows = new Set<Row>();
    const replacements = new Map<Row, Row>();
    const failures: string[] = [];

    for (const group of groups) {
      try {
        if (!sameValues(group.keeper, group.merged)) {
          await upsertRows([group.merged], false);
        }
        replacements.set(group.keeper, group.merged);
        for (const dup of group.remove) {
          if (!dup.id && dup.sku === group.keeper.sku) {
            throw new Error(`Cannot safely delete duplicate of ${dup.sku} without a row id`);
          }
          await deleteRow(dup);
          removedRows.add(dup);
        }
      } catch (err: unknown) {
        failures.push(
          `${group.keeper.sku}: ${err instanceof Error ? err.message : 'duplicate cleanup failed'}`
        );
      }
    }

    return {
      rows: all.filter((row) => !removedRows.has(row)).map((row) => replacements.get(row) ?? row),
      removed: removedRows.size,
      failures,
    };
  };

  const requestPause = () => {
    pauseRequestedRef.current = true;
    setPauseRequested(true);
    setEnrichProgress((progress) =>
      progress ? { ...progress, status: 'Pausing after the current batch…' } : progress
    );
  };

  /** Sleep in short slices so a Pause click is honoured promptly. Resolves true if a pause was requested. */
  const waitUnlessPaused = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pauseRequestedRef.current) return true;
      await wait(Math.min(PAUSE_POLL_MS, end - Date.now()));
    }
    return pauseRequestedRef.current;
  };

  const reportProgress = (run: EnrichRun, status: string) =>
    setEnrichProgress({
      completed: run.completed,
      total: run.total,
      enriched: run.enriched,
      failed: run.failed,
      status,
    });

  /**
   * POST one batch to the enrich route, retrying transient failures (network, 5xx, 429,
   * rate-limit messages, unreadable bodies) with backoff. Honours Keepa's refill hint when present.
   */
  const fetchEnrichBatch = async (
    asins: string[],
    onRetry: (status: string) => void
  ): Promise<BatchResponse> => {
    let lastError = 'API enrichment failed';
    for (let attempt = 0; ; attempt++) {
      let retryable = false;
      let refillIn: number | undefined;
      try {
        const res = await fetch('/api/keepa/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asins }),
        });
        let json: EnrichResponseBody | null = null;
        try {
          json = (await res.json()) as EnrichResponseBody;
        } catch {
          json = null;
        }
        if (res.ok && Array.isArray(json?.results)) {
          return { ok: true, results: json.results };
        }
        lastError =
          json?.error ||
          (res.ok
            ? 'API enrichment returned an unexpected response'
            : `API enrichment failed (HTTP ${res.status})`);
        refillIn = typeof json?.refillIn === 'number' ? json.refillIn : undefined;
        // A missing key (configured: false), bad request, or expired session won't fix itself.
        retryable =
          json?.configured !== false &&
          (json == null || res.status === 429 || res.status >= 500 || isRateLimitError(lastError));
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : 'Network error';
        retryable = true;
      }

      if (!retryable || attempt >= BATCH_RETRY_DELAYS_MS.length) {
        return { ok: false, error: lastError, paused: false };
      }
      const delay = Math.max(BATCH_RETRY_DELAYS_MS[attempt], refillWaitMs(refillIn));
      onRetry(
        `Retrying in ${seconds(delay)} (attempt ${attempt + 2} of ${BATCH_RETRY_DELAYS_MS.length + 1}) — ${lastError}`
      );
      if (await waitUnlessPaused(delay)) {
        return { ok: false, error: lastError, paused: true };
      }
    }
  };

  /** Publish the final state of a run: either complete, or paused with the remaining queue kept for Resume. */
  const finishRun = (run: EnrichRun, stop: RunStop | null, completeStatus: string) => {
    let status = completeStatus;
    if (stop) {
      const remaining = run.queue.length;
      status = `${stop.reason === 'error' ? 'Paused after an error' : 'Paused'} — ${run.completed}/${run.total} done, ${remaining} remaining.${remaining > 0 ? ' Click Resume to continue.' : ''}`;
      if (stop.message) setError(stop.message);
      setPausedRun(remaining > 0 ? { ...run, queue: [...run.queue] } : null);
    }
    pauseRequestedRef.current = false;
    setPauseRequested(false);
    setKeepaBusy(false);
    reportProgress(run, status);
  };

  /** Drain the run's queue batch by batch. Mutates `run` so a paused run can be resumed where it left off. */
  const runEnrichQueue = async (run: EnrichRun) => {
    pauseRequestedRef.current = false;
    setPauseRequested(false);
    setPausedRun(null);
    setKeepaBusy(true);
    setError(null);

    let stop: RunStop | null = null;
    let completeStatus = 'Complete';

    try {
      while (run.queue.length > 0) {
        // Leave the batch in the queue until the request succeeds so a failed batch is what Resume retries.
        const batch = run.queue.slice(0, ENRICH_BATCH_SIZE);
        reportProgress(run, `Processing ${plural(batch.length, 'ASIN')}…`);

        const response = await fetchEnrichBatch(
          batch.map((item) => item.asin),
          (status) => reportProgress(run, status)
        );
        if (!response.ok) {
          stop = response.paused ? { reason: 'paused' } : { reason: 'error', message: response.error };
          break;
        }
        run.queue.splice(0, batch.length);

        const resultsByAsin = new Map(
          response.results.map((result) => [String(result.asin).trim().toUpperCase(), result])
        );
        const updates: Row[] = [];
        let requeued = 0;
        let tokensLeft: number | undefined;
        let refillIn: number | undefined;

        for (const item of batch) {
          const result = resultsByAsin.get(item.asin.trim().toUpperCase());
          const existingRows = run.sourceRows.get(item.asin);
          if (!result || !existingRows?.length) {
            run.completed++;
            run.failed++;
            continue;
          }
          if (typeof result.tokensLeft === 'number') tokensLeft = result.tokensLeft;
          if (typeof result.refillIn === 'number') refillIn = result.refillIn;

          // Transient per-ASIN failures go back on the queue; they are only counted once they resolve.
          if (isRetryableResult(result) && item.attempts + 1 < MAX_RATE_LIMIT_RETRIES) {
            run.queue.push({ asin: item.asin, attempts: item.attempts + 1 });
            requeued++;
            continue;
          }

          const hasUsableData = result.weightLb != null || result.maxQtyPerBox != null;
          if (!hasUsableData) {
            run.completed++;
            run.failed++;
            continue;
          }

          for (const existing of existingRows) {
            if (existing.weight_lb != null && existing.max_qty_per_box != null) continue;
            const nextWeight =
              typeof result.weightLb === 'number' ? result.weightLb : existing.weight_lb;
            const uncappedNextMax =
              typeof result.maxQtyPerBox === 'number'
                ? result.maxQtyPerBox
                : existing.max_qty_per_box;
            const nextMax =
              nextWeight != null && uncappedNextMax != null
                ? capMaxQtyByWeight(uncappedNextMax, nextWeight)
                : uncappedNextMax;

            updates.push({
              asin: existing.asin,
              sku: existing.sku,
              weight_lb: nextWeight,
              max_qty_per_box: nextMax,
              product_name:
                typeof result.productName === 'string' && result.productName
                  ? result.productName
                  : existing.product_name,
            });
          }
          run.completed++;
          run.enriched++;
        }

        if (updates.length > 0) await upsertRows(updates, false);

        if (run.queue.length === 0) break;
        if (pauseRequestedRef.current) {
          stop = { reason: 'paused' };
          break;
        }

        // Keepa refills tokens once a minute; if we were throttled or the bucket is nearly empty, wait for it.
        const nextBatchSize = Math.min(ENRICH_BATCH_SIZE, run.queue.length);
        const lowTokens = typeof tokensLeft === 'number' && tokensLeft < nextBatchSize;
        const delay = Math.max(
          ENRICH_BATCH_DELAY_MS,
          requeued > 0 || lowTokens ? refillWaitMs(refillIn) : 0
        );
        reportProgress(
          run,
          `Waiting ${seconds(delay)} for API capacity before the next ${nextBatchSize}…`
        );
        if (await waitUnlessPaused(delay)) {
          stop = { reason: 'paused' };
          break;
        }
      }
    } catch (err: unknown) {
      stop = { reason: 'error', message: err instanceof Error ? err.message : 'API enrichment failed' };
    }

    await load();
    if (!stop) {
      const resultParts = [
        ...run.summaryParts,
        `${run.enriched} enriched`,
        ...(run.failed ? [`${run.failed} unavailable`] : []),
      ];
      completeStatus = `Complete — ${resultParts.join(', ')}`;
      showToast(
        `API enrichment complete: ${resultParts.join(', ')}.${run.dedupeNote}`,
        run.dedupeNote ? 8000 : 4000
      );
    }
    finishRun(run, stop, completeStatus);
  };

  /** Continue a paused run from its remaining queue, skipping the dedupe/40 lb validation pass. */
  const resumeEnrich = async () => {
    if (!pausedRun || pausedRun.queue.length === 0 || keepaBusy) return;
    setKeepaBusy(true);
    setError(null);
    reportProgress(pausedRun, 'Resuming…');
    // Rows may have been edited while paused; look them up fresh but keep the queue and counters.
    const fresh = await currentRows();
    await runEnrichQueue({ ...pausedRun, queue: [...pausedRun.queue], sourceRows: buildSourceRows(fresh) });
  };

  const enrichMissing = async () => {
    setKeepaBusy(true);
    setError(null);
    setPausedRun(null);
    setEnrichProgress({
      completed: 0,
      total: 0,
      enriched: 0,
      failed: 0,
      status: 'Scanning master reference for duplicate rows…',
    });

    // Step 1: quick duplicate scan. Never let this abort enrichment.
    let baseRows = await currentRows();
    let removedDuplicates = 0;
    let dedupeNote = '';
    try {
      const dedupe = await removeExactDuplicates(baseRows);
      baseRows = dedupe.rows;
      removedDuplicates = dedupe.removed;
      if (dedupe.failures.length > 0) {
        console.warn('Master reference duplicate cleanup issues:', dedupe.failures);
        dedupeNote = ` Duplicate cleanup skipped for ${plural(dedupe.failures.length, 'row')}: ${dedupe.failures[0]}`;
      }
    } catch (err: unknown) {
      console.warn('Master reference duplicate cleanup failed:', err);
      dedupeNote = ` Duplicate cleanup skipped: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
    const summaryParts: string[] = [];
    if (removedDuplicates > 0) summaryParts.push(`removed ${plural(removedDuplicates, 'duplicate row')}`);

    const corrections: Row[] = [];
    const validatedRows = baseRows.map((row) => {
      if (row.weight_lb == null || row.max_qty_per_box == null) return row;
      const cappedMax = capMaxQtyByWeight(row.max_qty_per_box, row.weight_lb);
      if (cappedMax === row.max_qty_per_box) return row;
      const corrected = { ...row, max_qty_per_box: cappedMax };
      corrections.push(corrected);
      return corrected;
    });
    // Enrichment is ASIN-driven; rows without an ASIN can only be filled in by hand.
    const need = [
      ...new Set(
        validatedRows
          .filter((row) => row.asin && (row.weight_lb == null || row.max_qty_per_box == null))
          .map((row) => row.asin as string)
      ),
    ];

    setEnrichProgress({
      completed: 0,
      total: need.length,
      enriched: 0,
      failed: 0,
      status: 'Checking current values against the 40 lb box limit…',
    });

    const run: EnrichRun = {
      queue: need.map((asin) => ({ asin, attempts: 0 })),
      total: need.length,
      completed: 0,
      enriched: 0,
      failed: 0,
      summaryParts,
      dedupeNote,
      sourceRows: buildSourceRows(validatedRows),
    };

    try {
      if (corrections.length > 0) {
        await upsertRows(corrections, false);
        summaryParts.push(`corrected ${plural(corrections.length, 'max/box value')}`);
      }
    } catch (err: unknown) {
      // Nothing has been enriched yet; keep the full queue so Resume can still run it.
      await load();
      finishRun(
        run,
        { reason: 'error', message: err instanceof Error ? err.message : 'API enrichment failed' },
        ''
      );
      return;
    }

    if (need.length === 0) {
      await load();
      showToast(
        (summaryParts.length > 0
          ? `Validation complete: ${summaryParts.join(', ')}.`
          : 'All rows have complete values and pass the 40 lb limit.') + dedupeNote,
        dedupeNote ? 8000 : 4000
      );
      finishRun(
        run,
        null,
        summaryParts.length > 0
          ? `Complete — ${summaryParts.join(', ')}`
          : 'Complete — all values already pass'
      );
      return;
    }

    await runEnrichQueue(run);
  };

  const exportCsv = () => {
    const header = 'ASIN,SKU,WEIGHT,MAX QTY PER BOX,PRODUCT NAME';
    const body = rows.map((r) =>
      [r.asin ?? '', r.sku, r.weight_lb ?? '', r.max_qty_per_box ?? '', r.product_name ?? '']
        .map((v) => (String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(',')
    );
    const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'master-reference.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveEdit = async (row: Row) => {
    setError(null);
    try {
      // Explicit edits may intentionally clear a field, so write the row as-is.
      await upsertRows([row], true, 'replace');
      showToast('Saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const remove = async (row: Row) => {
    try {
      await deleteRow(row);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      return;
    }
    await load();
  };

  return (
    <div className="settings-page">
      <h1 className="order-hub-title">Settings</h1>
      <p className="order-hub-min-orders-desc">
        Master reference lives here (hidden from Order Hub). Each SKU is unique; ASIN is optional
        and may be shared by any number of SKUs.
      </p>
      {toast && (
        <div className="order-hub-toast" role="alert">
          {toast}
        </div>
      )}
      {error && <div className="order-hub-error">{error}</div>}

      <section className="order-hub-section">
        <h3>Master reference</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <input ref={csvRef} type="file" accept=".csv" onChange={importCsv} style={{ display: 'none' }} />
          <input ref={pdfRef} type="file" accept="application/pdf" onChange={importPdf} style={{ display: 'none' }} />
          <button type="button" className="order-hub-btn" onClick={() => csvRef.current?.click()}>
            Import CSV
          </button>
          <button
            type="button"
            className="order-hub-btn"
            disabled={pdfBusy}
            onClick={() => pdfRef.current?.click()}
          >
            {pdfBusy ? 'Parsing PDF…' : 'Import catalog PDF'}
          </button>
          <button type="button" className="order-hub-btn" onClick={exportCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
          <button
            type="button"
            className="order-hub-btn order-hub-btn-primary"
            disabled={keepaBusy}
            onClick={enrichMissing}
          >
            {keepaBusy ? 'Enriching…' : 'API Enrich'}
          </button>
          {keepaBusy && (
            <button
              type="button"
              className="order-hub-btn"
              disabled={pauseRequested}
              onClick={requestPause}
            >
              {pauseRequested ? 'Pausing…' : 'Pause'}
            </button>
          )}
          {!keepaBusy && pausedRun && pausedRun.queue.length > 0 && (
            <button
              type="button"
              className="order-hub-btn order-hub-btn-primary"
              onClick={resumeEnrich}
            >
              Resume ({pausedRun.queue.length} remaining)
            </button>
          )}
        </div>
        {enrichProgress && (
          <div className="settings-enrich-progress" role="status" aria-live="polite">
            <div className="settings-enrich-progress-copy">
              <span>{enrichProgress.status}</span>
              {enrichProgress.total > 0 && (
                <span>
                  {enrichProgress.completed}/{enrichProgress.total} ({enrichProgress.enriched} enriched
                  {enrichProgress.failed ? `, ${enrichProgress.failed} unavailable` : ''})
                </span>
              )}
            </div>
            <progress
              value={enrichProgress.completed}
              max={Math.max(1, enrichProgress.total)}
              aria-label="API enrichment progress"
            />
          </div>
        )}
        {loading ? (
          <p>Loading…</p>
        ) : (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>ASIN</th>
                  <th>Weight</th>
                  <th>Max/box</th>
                  <th>Product</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <EditableRow key={r.sku} row={r} onSave={saveEdit} onDelete={remove} />
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="order-hub-meta">No entries yet. Import a CSV or Seller Central inventory PDF.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function EditableRow({
  row,
  onSave,
  onDelete,
}: {
  row: Row;
  onSave: (r: Row) => void;
  onDelete: (r: Row) => void;
}) {
  const [draft, setDraft] = useState(row);
  useEffect(() => setDraft(row), [row]);

  return (
    <tr>
      <td>
        {draft.sku}
      </td>
      <td>
        <input
          value={draft.asin ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, asin: e.target.value.toUpperCase() }))}
        />
      </td>
      <td>
        <input
          type="number"
          value={draft.weight_lb ?? ''}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              weight_lb: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        />
      </td>
      <td>
        <input
          type="number"
          value={draft.max_qty_per_box ?? ''}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              max_qty_per_box: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        />
      </td>
      <td>
        <input
          value={draft.product_name ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, product_name: e.target.value }))}
        />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="order-hub-btn" onClick={() => onSave(draft)}>
          Save
        </button>{' '}
        <button type="button" className="order-hub-btn" onClick={() => onDelete(row)}>
          Del
        </button>
      </td>
    </tr>
  );
}
