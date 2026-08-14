/**
 * Parse Amazon Seller Central "Manage Inventory" PDF text into SKU / ASIN / title rows.
 * Example layout (from Seller Central print/save):
 *   <title lines>
 *   ASIN          B08SVRZF9L
 *   SKU           1CUW-IWSN-EC0C
 */

export interface CatalogPdfRow {
  asin: string;
  sku: string;
  productName: string;
}

const ASIN_RE = /\bASIN\s+([A-Z0-9]{10})\b/gi;
const SKU_RE = /\bSKU\s+(\S+)/gi;

/**
 * Extract catalog rows from plain text extracted from a PDF.
 */
export function parseCatalogInventoryText(text: string): CatalogPdfRow[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
  const blocks = splitListingBlocks(normalized);
  const rows: CatalogPdfRow[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const asinMatch = /ASIN\s+([A-Z0-9]{10})/i.exec(block);
    const skuMatch = /SKU\s+(\S+)/i.exec(block);
    if (!asinMatch || !skuMatch) continue;

    const asin = asinMatch[1].toUpperCase();
    const sku = skuMatch[1].trim();
    if (!asin || !sku) continue;

    // Unique key is ASIN per user — same ASIN with different SKUs still collapses.
    if (seen.has(asin)) continue;
    seen.add(asin);

    const beforeAsin = block.slice(0, asinMatch.index).trim();
    const productName = extractTitle(beforeAsin);

    rows.push({ asin, sku, productName });
  }

  // Fallback: pairwise scan if block split missed rows
  if (rows.length === 0) {
    const asins = [...normalized.matchAll(ASIN_RE)].map((m) => m[1].toUpperCase());
    const skus = [...normalized.matchAll(SKU_RE)].map((m) => m[1].trim());
    const n = Math.min(asins.length, skus.length);
    for (let i = 0; i < n; i++) {
      if (seen.has(asins[i])) continue;
      seen.add(asins[i]);
      rows.push({ asin: asins[i], sku: skus[i], productName: '' });
    }
  }

  return rows;
}

function splitListingBlocks(text: string): string[] {
  // Seller Central inventory lines often start with Active / Inactive
  const parts = text.split(/(?=(?:Active|Inactive)\b)/i);
  if (parts.length > 1) return parts.filter((p) => /ASIN\s+/i.test(p) && /SKU\s+/i.test(p));

  // Alternate: split on ASIN markers with lookbehind content
  const asinIdx: number[] = [];
  const re = /\bASIN\s+[A-Z0-9]{10}\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) asinIdx.push(m.index);
  if (asinIdx.length === 0) return [text];

  const blocks: string[] = [];
  for (let i = 0; i < asinIdx.length; i++) {
    const start = i === 0 ? 0 : asinIdx[i - 1];
    // Include some lead-in for title (previous block end → this ASIN)
    const leadStart = Math.max(0, asinIdx[i] - 400);
    const end = i + 1 < asinIdx.length ? asinIdx[i + 1] : text.length;
    blocks.push(text.slice(Math.min(start, leadStart), end));
  }
  return blocks;
}

function extractTitle(beforeAsin: string): string {
  const lines = beforeAsin
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(Active|Inactive)\s+/i, '').trim());

  // Drop status / date / noise lines
  const noise =
    /^(Aug |Sep |Oct |Nov |Dec |Jan |Feb |Mar |Apr |May |Jun |Jul |\d{1,2}\/\d{1,2}\/\d{2}|Fix listing|Sales|Units sold|Page views|Sales rank|Available|Price|Shipping|Featured|Business|View reference|Fulfilled|Manage|Search|SKU|ASIN)/i;

  const candidates = lines.filter((l) => l.length > 3 && !noise.test(l) && !/^\d+$/.test(l));
  if (candidates.length === 0) return '';

  // Prefer longer contiguous title near the end (closest to ASIN)
  const tail = candidates.slice(-4);
  return tail.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}
