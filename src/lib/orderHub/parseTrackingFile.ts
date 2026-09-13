import { parseCsvLine } from '@/lib/parseMasterReferenceCsv';

export interface ParsedTrackingEntry {
  trackingNumber: string;
  /** Recipient name supplied by the file itself (CSV column or "Name : tracking" line). */
  recipientName?: string;
}

export type TrackingFileFormat = 'txt' | 'name-colon-tracking' | 'csv-columns' | 'csv-regex';

export interface ParseTrackingFileResult {
  entries: ParsedTrackingEntry[];
  format: TrackingFileFormat;
  /** Number of repeated tracking numbers dropped (order of first occurrence is kept). */
  duplicatesRemoved: number;
}

/** 13-char international format, e.g. LZ123456789US. */
const INTL_TRACKING_RE = /\b([A-Z]{2}\d{9}[A-Z]{2})\b/i;
/** USPS domestic: 20–22 digits, optionally space-separated in groups. */
const USPS_DIGITS_RE = /(?<!\d)(\d(?:[ \t]?\d){19,21})(?!\d)/;

const SORTCERER_HEADER_RE = /^tracking\s*numbers?\s*:?$/i;
const NAME_COLON_TRACKING_RE = /^(.*\S)\s*:\s*(\S+)$/;

function normalizeTracking(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** Pull a single tracking-number-looking token out of arbitrary text, or null. */
export function extractTrackingToken(text: string): string | null {
  const intl = text.match(INTL_TRACKING_RE);
  if (intl) return intl[1].toUpperCase();
  const digits = text.match(USPS_DIGITS_RE);
  if (digits) {
    const compact = digits[1].replace(/\s+/g, '');
    if (compact.length >= 20 && compact.length <= 22) return compact;
  }
  return null;
}

function looksLikeTracking(token: string): boolean {
  const compact = normalizeTracking(token);
  return /^\d{20,22}$/.test(compact) || /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(compact);
}

function splitLines(text: string): string[] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isTrackingHeader(cell: string): boolean {
  const n = cell.trim().toLowerCase();
  return /track/.test(n);
}

function isNameHeader(cell: string): boolean {
  const n = cell.trim().toLowerCase();
  if (/track/.test(n)) return false;
  return /(recipient|name|ship\s*to|customer|buyer|consignee)/.test(n);
}

const CSV_HEADER_WORD_RE = /(track|recipient|name|ship|customer|buyer|order)/i;

function looksLikeCsv(lines: string[], filename: string): boolean {
  if (/\.csv$/i.test(filename.trim())) return true;
  const first = lines[0] ?? '';
  return first.includes(',') && CSV_HEADER_WORD_RE.test(first);
}

function dedupe(entries: ParsedTrackingEntry[]): { entries: ParsedTrackingEntry[]; removed: number } {
  const seen = new Set<string>();
  const out: ParsedTrackingEntry[] = [];
  let removed = 0;
  for (const e of entries) {
    const key = normalizeTracking(e.trackingNumber);
    if (!key) continue;
    if (seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  return { entries: out, removed };
}

function parseNameColonTracking(lines: string[]): ParsedTrackingEntry[] {
  const out: ParsedTrackingEntry[] = [];
  for (const line of lines) {
    // Split on the LAST colon so recipient names containing ':' survive intact.
    const idx = line.lastIndexOf(':');
    if (idx === -1) {
      const token = extractTrackingToken(line);
      if (token) out.push({ trackingNumber: token });
      continue;
    }
    const name = line.slice(0, idx).trim();
    const tn = line.slice(idx + 1).trim();
    if (!tn) continue;
    out.push({
      trackingNumber: looksLikeTracking(tn) ? normalizeTracking(tn) : tn,
      recipientName: name || undefined,
    });
  }
  return out;
}

/** True when every line is "something : token" and most tokens look like tracking numbers. */
function isNameColonTrackingBody(lines: string[]): boolean {
  if (!lines.length) return false;
  let matches = 0;
  for (const line of lines) {
    const m = line.match(NAME_COLON_TRACKING_RE);
    if (!m) return false;
    if (looksLikeTracking(m[2])) matches++;
  }
  return matches >= Math.ceil(lines.length * 0.8);
}

function parseCsvBody(lines: string[]): { entries: ParsedTrackingEntry[]; format: TrackingFileFormat } {
  const headerCells = parseCsvLine(lines[0]);
  const trackingIdx = headerCells.findIndex(isTrackingHeader);
  const nameIdx = headerCells.findIndex(isNameHeader);

  if (trackingIdx !== -1) {
    const entries: ParsedTrackingEntry[] = [];
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const rawTn = (cells[trackingIdx] ?? '').trim();
      const tn = rawTn ? (looksLikeTracking(rawTn) ? normalizeTracking(rawTn) : rawTn) : extractTrackingToken(line);
      if (!tn) continue;
      const name = nameIdx !== -1 ? (cells[nameIdx] ?? '').trim() : '';
      entries.push({ trackingNumber: tn, recipientName: name || undefined });
    }
    return { entries, format: 'csv-columns' };
  }

  // Header not recognised: scan every row (including the first, in case there is no header)
  // for a tracking-number token. Any other non-empty cell is treated as the recipient name.
  const entries: ParsedTrackingEntry[] = [];
  for (const line of lines) {
    const tn = extractTrackingToken(line);
    if (!tn) continue;
    const cells = parseCsvLine(line);
    const nameCell = cells.find((c) => c && extractTrackingToken(c) !== tn && !/^\d[\d\s]*$/.test(c));
    entries.push({ trackingNumber: tn, recipientName: nameCell?.trim() || undefined });
  }
  return { entries, format: 'csv-regex' };
}

/**
 * Parse an uploaded tracking-numbers file into an ordered list.
 *
 * Supported inputs:
 * - Plain .txt: one tracking number per line (trimmed, blanks skipped) — legacy behaviour.
 * - Sortcerer's own "Tracking Numbers:" export: `Recipient Name : tracking` per line.
 * - CSV with a header row containing a tracking column (and optionally a name/recipient column).
 * - Any other CSV: a USPS/international tracking token is regex-extracted from each row.
 *
 * Format is chosen by content first and file extension second, so a mislabelled file still works.
 * Repeated tracking numbers are removed, keeping first-occurrence order.
 */
export function parseTrackingFile(text: string, filename = ''): ParseTrackingFileResult {
  const lines = splitLines(text);
  if (!lines.length) return { entries: [], format: 'txt', duplicatesRemoved: 0 };

  const hasSortcererHeader = SORTCERER_HEADER_RE.test(lines[0]);
  const body = hasSortcererHeader ? lines.slice(1) : lines;

  let entries: ParsedTrackingEntry[];
  let format: TrackingFileFormat;

  if (hasSortcererHeader || isNameColonTrackingBody(body)) {
    entries = parseNameColonTracking(body);
    format = 'name-colon-tracking';
  } else if (looksLikeCsv(lines, filename)) {
    ({ entries, format } = parseCsvBody(lines));
  } else {
    entries = lines.map((l) => ({ trackingNumber: l }));
    format = 'txt';
  }

  const deduped = dedupe(entries);
  return { entries: deduped.entries, format, duplicatesRemoved: deduped.removed };
}
