'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseMasterReferenceCsv } from '@/lib/parseMasterReferenceCsv';
import { parseCatalogInventoryText } from '@/lib/parseCatalogPdf';
import { capMaxQtyByWeight } from '@/lib/packing';

type Row = {
  id?: string;
  asin: string;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
};

type EnrichProgress = {
  completed: number;
  total: number;
  enriched: number;
  failed: number;
  status: string;
};

const ENRICH_BATCH_SIZE = 10;
const ENRICH_BATCH_DELAY_MS = 35_000;
const MAX_RATE_LIMIT_RETRIES = 3;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimitError = (message: unknown) =>
  /(?:429|rate.?limit|token|refill|too many requests)/i.test(String(message || ''));

export default function SettingsMasterRef() {
  const [rows, setRows] = useState<Row[]>([]);
  const [storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [keepaBusy, setKeepaBusy] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/master-reference');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setRows(json.rows || []);

      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('store_name')
          .eq('user_id', user.id)
          .maybeSingle();
        setStoreName(data?.store_name || '');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveStore = async () => {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error: err } = await supabase.from('profiles').upsert({
      user_id: user.id,
      store_name: storeName.trim() || null,
    });
    if (err) setError(err.message);
    else showToast('Store name saved (one Amazon store per account).');
  };

  const upsertRows = async (incoming: Row[], reloadAfter = true) => {
    const res = await fetch('/api/master-reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: incoming }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upsert failed');
    if (reloadAfter) await load();
    return {
      upserted: json.upserted as number,
      duplicatesCollapsed: (json.duplicatesCollapsed as number) || 0,
    };
  };

  const importCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = parseMasterReferenceCsv(String(reader.result));
        const mapped: Row[] = result.rows
          .filter((r) => r.asin)
          .map((r) => ({
            asin: r.asin!,
            sku: r.sku,
            weight_lb: r.weight,
            max_qty_per_box: r.maxQtyPerBox,
            product_name: r.productName ?? null,
          }));
        if (mapped.length === 0) {
          showToast('No rows with ASIN. ASIN is required (unique per account).');
          return;
        }
        const { upserted: n, duplicatesCollapsed } = await upsertRows(mapped);
        showToast(
          `Imported ${n} rows.${duplicatesCollapsed ? ` Collapsed ${duplicatesCollapsed} duplicate ASIN(s).` : ''}${result.rejected.length ? ` ${result.rejected.length} rejected.` : ''}`
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
      const parsed = parseCatalogInventoryText(text);
      if (parsed.length === 0) {
        showToast('No ASIN/SKU pairs found in PDF. Export Manage Inventory from Seller Central.');
        return;
      }
      const mapped: Row[] = parsed.map((r) => ({
        asin: r.asin,
        sku: r.sku,
        weight_lb: null,
        max_qty_per_box: null,
        product_name: r.productName || null,
      }));
      const { upserted: n, duplicatesCollapsed } = await upsertRows(mapped);
      showToast(
        `Catalog PDF: upserted ${n} SKUs.${duplicatesCollapsed ? ` Collapsed ${duplicatesCollapsed} duplicate ASIN(s).` : ''} Use Keepa enrich for missing weight/max.`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'PDF parse failed');
    } finally {
      setPdfBusy(false);
    }
  };

  const enrichMissing = async () => {
    setKeepaBusy(true);
    setError(null);

    const corrections: Row[] = [];
    const validatedRows = rows.map((row) => {
      if (row.weight_lb == null || row.max_qty_per_box == null) return row;
      const cappedMax = capMaxQtyByWeight(row.max_qty_per_box, row.weight_lb);
      if (cappedMax === row.max_qty_per_box) return row;
      const corrected = { ...row, max_qty_per_box: cappedMax };
      corrections.push(corrected);
      return corrected;
    });
    const need = validatedRows
      .filter((row) => row.weight_lb == null || row.max_qty_per_box == null)
      .map((row) => row.asin);

    setEnrichProgress({
      completed: 0,
      total: need.length,
      enriched: 0,
      failed: 0,
      status: 'Checking current values against the 40 lb box limit…',
    });

    const sourceRows = new Map(validatedRows.map((row) => [row.asin, row]));
    const queue = need.map((asin) => ({ asin, attempts: 0 }));
    let completed = 0;
    let enriched = 0;
    let failed = 0;
    let finalStatus = 'Complete';

    try {
      if (corrections.length > 0) {
        await upsertRows(corrections, false);
      }

      if (need.length === 0) {
        await load();
        finalStatus =
          corrections.length > 0
            ? `Complete — corrected ${corrections.length} max/box value${corrections.length === 1 ? '' : 's'}`
            : 'Complete — all values already pass';
        showToast(
          corrections.length > 0
            ? `Validation complete: corrected ${corrections.length} max/box value${corrections.length === 1 ? '' : 's'} for the 40 lb limit.`
            : 'All rows have complete values and pass the 40 lb limit.'
        );
        return;
      }

      while (queue.length > 0) {
        const batch = queue.splice(0, ENRICH_BATCH_SIZE);
        setEnrichProgress({
          completed,
          total: need.length,
          enriched,
          failed,
          status: `Processing ${batch.length} ASIN${batch.length === 1 ? '' : 's'}…`,
        });

        const res = await fetch('/api/keepa/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asins: batch.map((item) => item.asin) }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'API enrichment failed');

        const updates: Row[] = [];
        const resultsByAsin = new Map<string, Record<string, unknown>>(
          (json.results || []).map((result: Record<string, unknown>) => [
            String(result.asin),
            result,
          ])
        );

        for (const item of batch) {
          const result = resultsByAsin.get(item.asin);
          const existing = sourceRows.get(item.asin);
          if (!result || !existing) {
            completed++;
            failed++;
            continue;
          }

          if (
            isRateLimitError(result.error) &&
            item.attempts + 1 < MAX_RATE_LIMIT_RETRIES
          ) {
            queue.push({ asin: item.asin, attempts: item.attempts + 1 });
            continue;
          }

          const hasUsableData = result.weightLb != null || result.maxQtyPerBox != null;
          if (!hasUsableData) {
            completed++;
            failed++;
            continue;
          }

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
          completed++;
          enriched++;
        }

        if (updates.length > 0) await upsertRows(updates, false);

        setEnrichProgress({
          completed,
          total: need.length,
          enriched,
          failed,
          status:
            queue.length > 0
              ? `Waiting for API capacity before the next ${Math.min(ENRICH_BATCH_SIZE, queue.length)}…`
              : 'Finishing…',
        });

        if (queue.length > 0) await wait(ENRICH_BATCH_DELAY_MS);
      }

      await load();
      finalStatus = `Complete — ${enriched} enriched${corrections.length ? `, ${corrections.length} corrected` : ''}${failed ? `, ${failed} unavailable` : ''}`;
      showToast(
        `API enrichment complete: ${enriched} enriched${corrections.length ? `, ${corrections.length} corrected for 40 lb limit` : ''}${failed ? `, ${failed} unavailable` : ''}.`
      );
    } catch (err: unknown) {
      finalStatus = 'Stopped due to an error';
      setError(err instanceof Error ? err.message : 'API enrichment failed');
      await load();
    } finally {
      setKeepaBusy(false);
      setEnrichProgress((progress) =>
        progress ? { ...progress, completed, enriched, failed, status: finalStatus } : null
      );
    }
  };

  const exportCsv = () => {
    const header = 'ASIN,SKU,WEIGHT,MAX QTY PER BOX,PRODUCT NAME';
    const body = rows.map((r) =>
      [r.asin, r.sku, r.weight_lb ?? '', r.max_qty_per_box ?? '', r.product_name ?? '']
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
    try {
      await upsertRows([row]);
      showToast('Saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const remove = async (asin: string) => {
    const res = await fetch(`/api/master-reference?asin=${encodeURIComponent(asin)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const json = await res.json();
      setError(json.error || 'Delete failed');
      return;
    }
    await load();
  };

  return (
    <div className="settings-page">
      <h1 className="order-hub-title">Settings</h1>
      <p className="order-hub-min-orders-desc">
        Master reference lives here (hidden from Order Hub). One Amazon store per account; ASIN is
        unique per user.
      </p>
      {toast && (
        <div className="order-hub-toast" role="alert">
          {toast}
        </div>
      )}
      {error && <div className="order-hub-error">{error}</div>}

      <section className="order-hub-section">
        <h3>Amazon store</h3>
        <div className="order-hub-form-row">
          <label>
            Store name (optional)
            <input value={storeName} onChange={(e) => setStoreName(e.target.value)} />
          </label>
        </div>
        <button type="button" className="order-hub-btn order-hub-btn-primary" onClick={saveStore}>
          Save store
        </button>
      </section>

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
                  <EditableRow key={r.asin} row={r} onSave={saveEdit} onDelete={remove} />
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
  onDelete: (asin: string) => void;
}) {
  const [draft, setDraft] = useState(row);
  useEffect(() => setDraft(row), [row]);

  return (
    <tr>
      <td>
        <input
          value={draft.sku}
          onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))}
        />
      </td>
      <td>{draft.asin}</td>
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
        <button type="button" className="order-hub-btn" onClick={() => onDelete(row.asin)}>
          Del
        </button>
      </td>
    </tr>
  );
}
