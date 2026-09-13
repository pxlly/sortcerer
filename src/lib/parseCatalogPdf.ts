/**
 * Parse Amazon Seller Central "Manage Inventory" PDF text into SKU / ASIN / title rows.
 * Example layout (from Seller Central print/save):
 *   Active
 *   <title lines>
 *   ASIN          B08SVRZF9L
 *   SKU           1CUW-IWSN-EC0C
 *   Aug 12, 2025  4  $19.99  Fix listing ...
 *
 * The text handed to this parser usually has NO line breaks inside a page (pdf.js
 * items are joined with spaces; only page boundaries become "\n"), so nothing here
 * may depend on the title being on its own line. Instead, listings are located by
 * their ASIN/SKU anchors and the title is recovered from the prose left over in the
 * text between consecutive listings once dates, prices, status words and UI labels
 * are stripped away.
 */

import { normalizeSku } from './masterRefKeys';

export interface CatalogPdfRow {
  asin: string;
  sku: string;
  productName: string;
}

export interface CatalogPdfParseResult {
  rows: CatalogPdfRow[];
  /** Listings in the PDF that repeated a SKU already seen earlier in the same file. */
  duplicatesCollapsed: number;
}

const ASIN_RE = /\bASIN\b\s*[:#]?\s*([A-Z0-9]{10})\b/gi;
const SKU_RE = /\bSKU\b\s*[:#]?\s*(\S+)/gi;

/** Words that can follow a bare "SKU" label in a table header; never a real SKU. */
const SKU_LABEL_WORDS = new Set([
  'condition',
  'product',
  'name',
  'title',
  'asin',
  'fnsku',
  'status',
  'price',
  'quantity',
  'qty',
  'available',
  'date',
  'image',
  'and',
  'or',
  'the',
  'a',
  'an',
  'of',
  '-',
  '—',
  '|',
  ':',
]);

/** Listing status badges; the title normally follows the status of its own row. */
const STATUS_RE =
  /\b(?:Active|Inactive|Incomplete|Suppressed|Search\s+Suppressed|Detail\s+page\s+removed)\b(?:\s*\([^()]{0,40}\))?/gi;

/** Tokens that cannot be part of a title and therefore break a prose run. */
const RUN_BREAKERS: RegExp[] = [
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/gi,
  /[$€£]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d+(?:\.\d+)?\s?%/g,
  /\bPage\s+\d+\s+of\s+\d+\b/gi,
  /\b(?:Fix\s+listing|Units\s+sold|Page\s+views|Sales\s+rank|Featured\s+Offer|Business\s+Price|View\s+reference|Fulfilled\s+by(?:\s+(?:Amazon|Merchant))?|Date\s+created|Status\s+changed|Fee\s+preview|Estimated\s+fee|Min(?:imum)?\s+price|Max(?:imum)?\s+price|Buy\s+Box(?:\s+Eligible)?|Add\s+another\s+condition|Copy\s+listing|Delete\s+product\s+and\s+listing|Close\s+listing|Match\s+low\s+price|Manage\s+Inventory|Manage\s+Pricing|Manage\s+All\s+Inventory|All\s+inventory|Print\s+item\s+labels|Send\/Replenish\s+Inventory|Save\s+all|Product\s+Name|Learn\s+more|Show\s+more|Show\s+less|Ships\s+from|Sold\s+by|Edit\s+listing|Advertise\s+listing)\b/gi,
];

/** Single UI words that are safe to trim from the START of a prose run. */
const LEADING_NOISE = new Set([
  'active',
  'inactive',
  'incomplete',
  'suppressed',
  'blocked',
  'status',
  'image',
  'sku',
  'asin',
  'fnsku',
  'condition',
  'edit',
  'actions',
  'action',
]);

/** Single UI words that are safe to trim from the END of a prose run. */
const TRAILING_NOISE = new Set([
  'active',
  'inactive',
  'incomplete',
  'suppressed',
  'blocked',
  'status',
  'image',
  'sku',
  'asin',
  'fnsku',
  'condition',
  'new',
  'used',
  'refurbished',
  'collectible',
  'edit',
  'actions',
  'action',
  'fix',
  'available',
  'price',
  'sales',
  'fulfilled',
  'by',
  'amazon',
  'merchant',
  'qty',
  'quantity',
  'date',
  'created',
  'units',
  'sold',
  'page',
  'views',
  'rank',
]);

const PUNCT_ONLY_TOKEN = /^[^\p{L}\p{N}]*$/u;

interface Anchor {
  kind: 'asin' | 'sku';
  value: string;
  start: number;
  end: number;
}

interface Listing {
  asin: string;
  sku: string;
  /** Span of text covered by the ASIN + SKU anchors (and anything between them). */
  start: number;
  end: number;
  productName: string;
}

/**
 * Extract catalog rows from plain text extracted from a PDF.
 */
export function parseCatalogInventoryText(text: string): CatalogPdfRow[] {
  return parseCatalogInventory(text).rows;
}

/**
 * Like parseCatalogInventoryText, but also reports how many repeated SKUs
 * (compared case-insensitively, ignoring whitespace) were collapsed.
 */
export function parseCatalogInventory(text: string): CatalogPdfParseResult {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[\u00a0\t\f\v]/g, ' ');
  const listings = pairAnchors(findAnchors(normalized));
  assignTitles(normalized, listings);

  const rows: CatalogPdfRow[] = [];
  const bySku = new Map<string, CatalogPdfRow>();
  let duplicatesCollapsed = 0;

  for (const l of listings) {
    const key = normalizeSku(l.sku);
    const existing = bySku.get(key);
    if (existing) {
      duplicatesCollapsed++;
      // A repeated listing may carry the title the first occurrence lacked.
      if (!existing.productName && l.productName) existing.productName = l.productName;
      continue;
    }
    const row: CatalogPdfRow = { asin: l.asin, sku: l.sku, productName: l.productName };
    bySku.set(key, row);
    rows.push(row);
  }

  return { rows, duplicatesCollapsed };
}

function findAnchors(text: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const m of text.matchAll(ASIN_RE)) {
    anchors.push({ kind: 'asin', value: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(SKU_RE)) {
    const raw = m[1].replace(/[,;.)]+$/, '');
    if (!raw || SKU_LABEL_WORDS.has(raw.toLowerCase())) continue;
    // "SKU ASIN B0..." (header text) would otherwise swallow the ASIN label.
    if (/^ASIN$/i.test(raw)) continue;
    anchors.push({ kind: 'sku', value: raw, start: m.index, end: m.index + m[0].length });
  }
  anchors.sort((a, b) => a.start - b.start);
  return anchors;
}

/**
 * Pair each ASIN anchor with the SKU anchor that belongs to the same listing.
 * Anchors may appear in either order (ASIN then SKU, or SKU then ASIN); a SKU is
 * claimed by the ASIN it is closest to, and never by an ASIN on the far side of
 * another ASIN.
 */
function pairAnchors(anchors: Anchor[]): Listing[] {
  const listings: Listing[] = [];
  const asins = anchors.filter((a) => a.kind === 'asin');
  const skus = anchors.filter((a) => a.kind === 'sku');
  const usedSku = new Set<Anchor>();
  let firstCandidate = 0;

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    const prevAsin = asins[i - 1];
    const nextAsin = asins[i + 1];
    // Candidate SKUs: after the previous ASIN and before the next ASIN.
    while (prevAsin && firstCandidate < skus.length && skus[firstCandidate].start < prevAsin.end) {
      firstCandidate++;
    }
    let best: Anchor | null = null;
    let bestDist = Infinity;
    for (let j = firstCandidate; j < skus.length; j++) {
      const sku = skus[j];
      if (nextAsin && sku.start >= nextAsin.start) break;
      if (usedSku.has(sku)) continue;
      // A SKU sitting between two ASINs is ambiguous; give it to the closer one.
      const dist = sku.start >= asin.end ? sku.start - asin.end : asin.start - sku.end;
      if (sku.start < asin.start && prevAsin) {
        const prevDist = sku.start - prevAsin.end;
        if (prevDist < dist) continue;
      }
      if (sku.start >= asin.end && nextAsin) {
        const nextDist = nextAsin.start - sku.end;
        if (nextDist < dist) continue;
      }
      if (dist < bestDist) {
        best = sku;
        bestDist = dist;
      }
    }
    if (!best) continue;
    usedSku.add(best);
    listings.push({
      asin: asin.value,
      sku: best.value,
      start: Math.min(asin.start, best.start),
      end: Math.max(asin.end, best.end),
      productName: '',
    });
  }

  listings.sort((a, b) => a.start - b.start);
  return listings;
}

/**
 * Recover titles from the text between consecutive listings.
 *
 * gap(i) = text between listing i-1's anchors and listing i's anchors. In the
 * documented layout it holds "[metadata of i-1] [status of i] [title of i]"; in a
 * title-after-SKU layout it holds "[title of i-1] [metadata of i-1] [status of i]".
 * The last status badge in the gap tells the two apart: prose after it belongs to
 * listing i, prose before it belongs to listing i-1.
 */
function assignTitles(text: string, listings: Listing[]): void {
  for (let i = 0; i <= listings.length; i++) {
    const prev = i > 0 ? listings[i - 1] : null;
    const cur = i < listings.length ? listings[i] : null;
    const gapStart = prev ? prev.end : 0;
    const gapEnd = cur ? cur.start : text.length;
    if (gapEnd <= gapStart) continue;
    const gap = text.slice(gapStart, gapEnd);

    const { before, after, hasStatus } = splitAtLastStatus(gap);

    if (cur) {
      // Title normally sits between the row's status badge and its ASIN.
      let title = bestProseRun(after, 1);
      if (!title && !hasStatus && (!prev || prev.productName)) {
        // No status badge to orient on: fall back to the whole gap, but do not
        // steal prose that clearly belongs to a still-untitled previous row.
        title = bestProseRun(gap, 2);
      }
      if (title) cur.productName = title;
    }

    if (prev && !prev.productName) {
      // Title-after-SKU layout (or a trailing title after the last listing).
      // This text is mostly metadata, so demand something clearly prose-like.
      const candidate = bestProseRun(hasStatus ? before : gap, 2);
      if (candidate) prev.productName = candidate;
    }
  }
}

function splitAtLastStatus(gap: string): { before: string; after: string; hasStatus: boolean } {
  let last: RegExpExecArray | null = null;
  for (const m of gap.matchAll(STATUS_RE)) last = m as RegExpExecArray;
  if (!last) return { before: gap, after: '', hasStatus: false };
  return {
    before: gap.slice(0, last.index),
    after: gap.slice(last.index + last[0].length),
    hasStatus: true,
  };
}

/**
 * Split a chunk of extracted text into prose runs (separated by status badges,
 * dates, prices and known UI labels) and return the most title-like one: the
 * longest run after trimming noise from both ends. Line breaks are treated as
 * spaces so that a title wrapped over several lines (or a page break) is kept
 * whole; `minContentTokens` is the number of non-noise, non-numeric words a run
 * must contain to count as a title.
 */
function bestProseRun(chunk: string, minContentTokens: number): string {
  if (!chunk.trim()) return '';
  let marked = chunk.replace(STATUS_RE, ' \u0000 ');
  for (const re of RUN_BREAKERS) marked = marked.replace(re, ' \u0000 ');

  let best = '';
  for (const raw of marked.split('\u0000')) {
    const run = trimRun(raw);
    if (!run) continue;
    if (!looksLikeTitle(run, minContentTokens)) continue;
    if (run.length > best.length) best = run;
  }
  return best.slice(0, 500);
}

function trimRun(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  let start = 0;
  let end = tokens.length;
  while (start < end && isEdgeNoise(tokens[start], LEADING_NOISE)) start++;
  while (end > start && isEdgeNoise(tokens[end - 1], TRAILING_NOISE)) end--;
  return tokens.slice(start, end).join(' ');
}

function isEdgeNoise(token: string, words: Set<string>): boolean {
  if (PUNCT_ONLY_TOKEN.test(token)) return true;
  // Numbers are deliberately kept: "2 Pack ..." and "... Set of 12" are real title text.
  const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return words.has(bare.toLowerCase());
}

function looksLikeTitle(run: string, minContentTokens: number): boolean {
  if (run.length < 3) return false;
  const tokens = run.split(' ');
  // A lone code (ASIN-like or SKU-like token) is not a title.
  if (tokens.length === 1 && /^[A-Z0-9][A-Z0-9\-_.]*$/.test(run) && !/[a-z]/.test(run)) return false;
  let content = 0;
  for (const token of tokens) {
    if (!/\p{L}/u.test(token)) continue;
    const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
    if (LEADING_NOISE.has(bare) || TRAILING_NOISE.has(bare)) continue;
    content++;
  }
  return content >= minContentTokens;
}
