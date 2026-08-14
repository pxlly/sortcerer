import { capMaxQtyByWeight, gramsToWeightLb, maxUnitsPerBox } from './packing';

export interface KeepaEnrichResult {
  asin: string;
  weightLb?: number;
  maxQtyPerBox?: number;
  productName?: string;
  error?: string;
}

interface KeepaProduct {
  asin?: string;
  title?: string;
  packageLength?: number;
  packageWidth?: number;
  packageHeight?: number;
  packageWeight?: number;
}

/**
 * Fetch Keepa product data and compute weight (lb) + max units per box.
 * Never call from the client — API key stays server-side.
 */
export async function enrichAsinWithKeepa(asin: string): Promise<KeepaEnrichResult> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) {
    return { asin, error: 'KEEPA_API_KEY is not configured' };
  }

  const clean = asin.trim().toUpperCase();
  if (!/^B0[A-Z0-9]{8}$/i.test(clean) && !/^[A-Z0-9]{10}$/.test(clean)) {
    return { asin: clean, error: 'Invalid ASIN' };
  }

  const url = `https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=1&asin=${encodeURIComponent(clean)}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { asin: clean, error: `Keepa HTTP ${res.status}` };
  }

  const data = (await res.json()) as {
    products?: KeepaProduct[];
    error?: string;
  };

  if (data.error) {
    return { asin: clean, error: data.error };
  }

  const product = data.products?.[0];
  if (!product) {
    return { asin: clean, error: 'ASIN not found in Keepa' };
  }

  const result: KeepaEnrichResult = {
    asin: clean,
    productName: product.title?.trim() || undefined,
  };

  const weight = gramsToWeightLb(Number(product.packageWeight));
  if (typeof weight === 'number') {
    result.weightLb = weight;
  }

  const packing = maxUnitsPerBox({
    lengthMm: Number(product.packageLength),
    widthMm: Number(product.packageWidth),
    heightMm: Number(product.packageHeight),
  });
  if ('maxQtyPerBox' in packing) {
    result.maxQtyPerBox = packing.maxQtyPerBox;
  }

  if (result.weightLb != null && result.maxQtyPerBox != null) {
    result.maxQtyPerBox = capMaxQtyByWeight(result.maxQtyPerBox, result.weightLb);
  }

  if (result.weightLb == null && result.maxQtyPerBox == null) {
    result.error =
      ('error' in packing ? packing.error : null) ||
      (typeof weight === 'object' ? weight.error : null) ||
      'Missing package dimensions/weight in Keepa';
  }

  return result;
}
