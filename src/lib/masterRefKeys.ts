/**
 * Shared identity normalization for master reference rows.
 * SKUs that differ only by surrounding whitespace or letter case are treated as
 * the same product everywhere (imports, duplicate cleanup, server merges).
 */

export function normalizeSku(sku: string | null | undefined): string {
  return String(sku ?? '').trim().toUpperCase();
}

export function normalizeAsin(asin: string | null | undefined): string {
  return String(asin ?? '').trim().toUpperCase();
}

/**
 * Key for "true 1-to-1 duplicate" detection: same normalized SKU AND same
 * normalized ASIN (blank ASINs compare equal to each other).
 */
export function masterRefDuplicateKey(
  sku: string | null | undefined,
  asin: string | null | undefined
): string {
  return `${normalizeSku(sku)}\u0000${normalizeAsin(asin)}`;
}
