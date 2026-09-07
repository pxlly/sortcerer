/** Max distinct SKUs that may share one non-blank ASIN (per user). */
export const MAX_SKUS_PER_SHARED_ASIN = 2;

/** Max ASINs that may be shared by 2 SKUs on one account. */
export const MAX_SHARED_ASINS_PER_USER = 10;

export const ASIN_SHARE_CAP_MESSAGE = 'Contact the admin for help';

export type AsinCapRow = {
  sku: string;
  /** Normalized ASIN, or '' when blank/unknown. */
  asin: string;
};

function normalizeAsin(asin: string | null | undefined): string {
  return String(asin ?? '')
    .trim()
    .toUpperCase();
}

function buildSkusByAsin(rows: AsinCapRow[]): Map<string, Set<string>> {
  const skusByAsin = new Map<string, Set<string>>();
  for (const row of rows) {
    const sku = String(row.sku ?? '').trim();
    const asin = normalizeAsin(row.asin);
    if (!sku || !asin) continue;
    let set = skusByAsin.get(asin);
    if (!set) {
      set = new Set();
      skusByAsin.set(asin, set);
    }
    set.add(sku);
  }
  return skusByAsin;
}

function countSharedAsins(skusByAsin: Map<string, Set<string>>): number {
  let shared = 0;
  for (const skus of skusByAsin.values()) {
    if (skus.size >= 2) shared += 1;
  }
  return shared;
}

function violatesCaps(skusByAsin: Map<string, Set<string>>): boolean {
  for (const skus of skusByAsin.values()) {
    if (skus.size > MAX_SKUS_PER_SHARED_ASIN) return true;
  }
  return countSharedAsins(skusByAsin) > MAX_SHARED_ASINS_PER_USER;
}

/**
 * Simulate applying `payload` over `existing`, then enforce:
 * - at most 2 SKUs per non-blank ASIN
 * - at most 10 ASINs that have 2+ SKUs
 * Blank ASINs are ignored. Pure weight/max/name updates on an existing
 * SKU (same ASIN) are always allowed. Callers should skip this for admins.
 */
export function wouldExceedAsinShareCaps(
  existing: AsinCapRow[],
  payload: AsinCapRow[]
): string | null {
  const existingBySku = new Map<string, string>();
  const nextRows = new Map<string, AsinCapRow>();

  for (const row of existing) {
    const sku = String(row.sku ?? '').trim();
    if (!sku) continue;
    const asin = normalizeAsin(row.asin);
    existingBySku.set(sku, asin);
    nextRows.set(sku, { sku, asin });
  }

  let changesAsinAssignment = false;
  for (const row of payload) {
    const sku = String(row.sku ?? '').trim();
    if (!sku) continue;
    const asin = normalizeAsin(row.asin);
    const prev = existingBySku.get(sku);
    if (prev === undefined || prev !== asin) {
      changesAsinAssignment = true;
    }
    nextRows.set(sku, { sku, asin });
  }

  if (!violatesCaps(buildSkusByAsin([...nextRows.values()]))) {
    return null;
  }

  // Already over cap (e.g. admin-created) — still allow in-place field updates.
  if (!changesAsinAssignment) return null;

  return ASIN_SHARE_CAP_MESSAGE;
}
