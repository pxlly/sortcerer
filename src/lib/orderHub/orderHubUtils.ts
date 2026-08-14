/**
 * Order Hub: parse unshipped .txt, convert to CSV rows, sort, and box-split logic.
 */

import { normalizeState, normalizeZip } from '@/lib/addressNormalize';
import { capMaxQtyByWeight } from '@/lib/packing';

export interface MasterRefEntry {
  sku: string;
  asin?: string;
  weight: number;
  maxQtyPerBox: number;
  productName?: string;
}

export interface ParsedOrderRow {
  sku: string;
  productName: string;
  qty: number;
  recipientName: string;
  shipAddress1: string;
  shipAddress2: string;
  shipCity: string;
  shipState: string;
  shipPostalCode: string;
  /** Amazon order ID (e.g. 113-8399518-6172204) for bulk-confirm-shipment link; optional. */
  orderId?: string;
}

export interface CsvOutputRow {
  WEIGHT: number;
  fromName: string;
  fromCompany: string;
  fromPhone: string;
  fromAddress1: string;
  fromAddress2: string;
  fromCity: string;
  fromState: string;
  fromZip: string;
  toName: string;
  toCompany: string;
  toPhone: string;
  toAddress1: string;
  toAddress2: string;
  toCity: string;
  toState: string;
  toZip: string;
  NOTES: string;
  // internal for PDF/report
  sku: string;
  productName: string;
  unitsInThisBox: number;
}

const REQUIRED_TXT_HEADERS = [
  'sku',
  'product-name',
  'quantity-purchased',
  'recipient-name',
  'ship-address-1',
  'ship-city',
  'ship-state',
  'ship-postal-code'
];

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * Parse tab-delimited unshipped orders .txt. Returns rows and list of missing column names.
 */
export function parseUnshippedTxt(
  text: string
): { rows: ParsedOrderRow[]; missingColumns: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], missingColumns: [] };
  const headerLine = lines[0];
  const headers = headerLine.split(/\t/).map(normalizeHeader);
  const headerIndex: Record<string, number> = {};
  headers.forEach((h, i) => {
    headerIndex[h] = i;
  });
  const missingColumns = REQUIRED_TXT_HEADERS.filter((c) => headerIndex[c] === undefined);
  if (missingColumns.length > 0) return { rows: [], missingColumns };

  const get = (row: string[], key: string): string => {
    const i = headerIndex[key];
    if (i === undefined) return '';
    const val = row[i];
    return val != null ? String(val).trim() : '';
  };

  const rows: ParsedOrderRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(/\t/);
    const qty = parseInt(get(cells, 'quantity-purchased'), 10) || 0;
    if (qty < 1) continue;
    const orderId = get(cells, 'order-id') || get(cells, 'amazon-order-id') || undefined;
    rows.push({
      sku: get(cells, 'sku'),
      productName: get(cells, 'product-name'),
      qty,
      recipientName: get(cells, 'recipient-name'),
      shipAddress1: get(cells, 'ship-address-1'),
      shipAddress2: get(cells, 'ship-address-2') ?? '',
      shipCity: get(cells, 'ship-city'),
      shipState: get(cells, 'ship-state'),
      shipPostalCode: get(cells, 'ship-postal-code'),
      ...(orderId ? { orderId } : {})
    });
  }
  return { rows, missingColumns: [] };
}

/**
 * For one order row, expand into 1 or more CSV lines (box split).
 * maxPerBox 1 and qty 2 => 2 lines each weight = unitWeight.
 */
export function expandOrderToCsvLines(
  order: ParsedOrderRow,
  ref: MasterRefEntry,
  from: {
    fromName: string;
    fromAddress1: string;
    fromAddress2: string;
    fromCity: string;
    fromState: string;
    fromZip: string;
  }
): CsvOutputRow[] {
  const unitWeight = ref.weight;
  const maxPerBox = capMaxQtyByWeight(ref.maxQtyPerBox, unitWeight);
  const productName = (ref.productName && ref.productName.trim()) || order.productName || ref.sku;
  const lines: CsvOutputRow[] = [];

  if (maxPerBox === 1) {
    for (let i = 0; i < order.qty; i++) {
      lines.push({
        WEIGHT: unitWeight,
        fromName: from.fromName,
        fromCompany: '',
        fromPhone: '',
        fromAddress1: from.fromAddress1,
        fromAddress2: from.fromAddress2,
        fromCity: from.fromCity,
        fromState: from.fromState,
        fromZip: from.fromZip,
        toName: order.recipientName,
        toCompany: '',
        toPhone: '',
        toAddress1: order.shipAddress1,
        toAddress2: order.shipAddress2,
        toCity: order.shipCity,
        toState: normalizeState(order.shipState),
        toZip: normalizeZip(order.shipPostalCode),
        NOTES: '',
        sku: ref.sku,
        productName,
        unitsInThisBox: 1
      });
    }
    return lines;
  }

  const fullBoxes = Math.floor(order.qty / maxPerBox);
  const remainder = order.qty % maxPerBox;
  for (let i = 0; i < fullBoxes; i++) {
    lines.push({
      WEIGHT: Math.round(unitWeight * maxPerBox * 10) / 10,
      fromName: from.fromName,
      fromCompany: '',
      fromPhone: '',
      fromAddress1: from.fromAddress1,
      fromAddress2: from.fromAddress2,
      fromCity: from.fromCity,
      fromState: from.fromState,
      fromZip: from.fromZip,
      toName: order.recipientName,
      toCompany: '',
      toPhone: '',
      toAddress1: order.shipAddress1,
      toAddress2: order.shipAddress2,
      toCity: order.shipCity,
      toState: normalizeState(order.shipState),
      toZip: normalizeZip(order.shipPostalCode),
      NOTES: '',
      sku: ref.sku,
      productName,
      unitsInThisBox: maxPerBox
    });
  }
  if (remainder > 0) {
    lines.push({
      WEIGHT: Math.round(unitWeight * remainder * 10) / 10,
      fromName: from.fromName,
      fromCompany: '',
      fromPhone: '',
      fromAddress1: from.fromAddress1,
      fromAddress2: from.fromAddress2,
      fromCity: from.fromCity,
      fromState: from.fromState,
      fromZip: from.fromZip,
      toName: order.recipientName,
      toCompany: '',
      toPhone: '',
      toAddress1: order.shipAddress1,
      toAddress2: order.shipAddress2,
      toCity: order.shipCity,
      toState: normalizeState(order.shipState),
      toZip: normalizeZip(order.shipPostalCode),
      NOTES: '',
      sku: ref.sku,
      productName,
      unitsInThisBox: remainder
    });
  }
  return lines;
}

/**
 * Sort CSV rows: by SKU (alpha), then multi-unit boxes first (unitsInThisBox DESC), then single-unit,
 * then WEIGHT DESC, then toName ASC.
 */
export function sortCsvRows(rows: CsvOutputRow[]): CsvOutputRow[] {
  return [...rows].sort((a, b) => {
    if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
    const aMulti = a.unitsInThisBox > 1 ? 1 : 0;
    const bMulti = b.unitsInThisBox > 1 ? 1 : 0;
    if (bMulti !== aMulti) return bMulti - aMulti; // multi first
    if (a.unitsInThisBox !== b.unitsInThisBox) return b.unitsInThisBox - a.unitsInThisBox;
    if (a.WEIGHT !== b.WEIGHT) return b.WEIGHT - a.WEIGHT;
    return (a.toName || '').localeCompare(b.toName || '');
  });
}

const CSV_HEADER =
  'WEIGHT,FROM NAME,FROM COMPANY,FROM PHONE,FROM ADDRESS 1,FROM ADDRESS 2,FROM CITY,FROM STATE,FROM ZIP,TO NAME,TO COMPANY,TO PHONE,TO ADDRESS 1,TO ADDRESS 2,TO CITY,TO STATE,TO ZIP,NOTES';

function escapeCsv(val: string | number): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRowsToCsvString(rows: CsvOutputRow[]): string {
  const body = rows.map(
    (r) =>
      [
        r.WEIGHT,
        r.fromName,
        r.fromCompany,
        r.fromPhone,
        r.fromAddress1,
        r.fromAddress2,
        r.fromCity,
        r.fromState,
        r.fromZip,
        r.toName,
        r.toCompany,
        r.toPhone,
        r.toAddress1,
        r.toAddress2,
        r.toCity,
        r.toState,
        r.toZip,
        r.NOTES
      ].map(escapeCsv).join(',')
  );
  return [CSV_HEADER, ...body].join('\n');
}

/**
 * Generate multi-unit report TXT: only products with at least one multi-unit box.
 * Format: <Product Name>\n<N> pack:\n<Recipient1>\n...
 */
export function generateMultiUnitReportTxt(rows: CsvOutputRow[]): string {
  const byProduct: Record<
    string,
    { productName: string; byUnits: Record<number, string[]> }
  > = {};
  for (const r of rows) {
    if (r.unitsInThisBox <= 1) continue;
    const key = r.sku;
    if (!byProduct[key]) byProduct[key] = { productName: r.productName, byUnits: {} };
    if (!byProduct[key].byUnits[r.unitsInThisBox]) byProduct[key].byUnits[r.unitsInThisBox] = [];
    byProduct[key].byUnits[r.unitsInThisBox].push(r.toName.trim());
  }
  const lines: string[] = [];
  for (const key of Object.keys(byProduct).sort()) {
    const { productName, byUnits } = byProduct[key];
    lines.push(productName || key);
    const units = Object.keys(byUnits)
      .map(Number)
      .sort((a, b) => b - a);
    for (const u of units) {
      lines.push(`${u} pack:`);
      for (const name of byUnits[u]) lines.push(name);
      lines.push('');
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** One line per row: "RecipientName : tracking" (same order as CSV / label PDF pages). */
export function buildTrackingNumbersCsv(rows: CsvOutputRow[], trackingNumbers: string[]): string {
  const lines: string[] = ['Tracking Numbers:'];
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i].toName || '').trim();
    const tn = (trackingNumbers[i] || '').trim();
    lines.push(`${name} : ${tn}`);
  }
  return lines.join('\n');
}

/** Sanitize product name for use as filename (no path, no control chars). */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?*:|\0]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Unknown';
}

/**
 * From ZIP entry paths, keep only real .pdf files (skip .txt, macOS junk, non-PDFs),
 * sorted alphabetically by basename for a stable merge order.
 */
export function selectPdfEntriesForCombine(entryNames: string[]): string[] {
  const pdfs = entryNames.filter((name) => {
    const normalized = name.replace(/\\/g, '/');
    if (normalized.includes('__MACOSX/') || normalized.split('/').pop()?.startsWith('._')) {
      return false;
    }
    const base = normalized.split('/').pop() || normalized;
    return /\.pdf$/i.test(base);
  });
  return pdfs.sort((a, b) => {
    const baseA = (a.replace(/\\/g, '/').split('/').pop() || a).toLowerCase();
    const baseB = (b.replace(/\\/g, '/').split('/').pop() || b).toLowerCase();
    return baseA.localeCompare(baseB);
  });
}
