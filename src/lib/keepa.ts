import { capMaxQtyByWeight, gramsToWeightLb, maxUnitsPerBox } from './packing';

export interface KeepaEnrichResult {
  asin: string;
  weightLb?: number;
  maxQtyPerBox?: number;
  productName?: string;
  error?: string;
  /** True when the failure is transient (rate limit, network, Keepa 5xx) and worth retrying later. */
  retryable?: boolean;
  /** Keepa token bucket state, when Keepa reported it. */
  tokensLeft?: number;
  /** Milliseconds until Keepa's next token refill, when Keepa reported it. */
  refillIn?: number;
}

interface KeepaProduct {
  asin?: string;
  title?: string;
  packageLength?: number;
  packageWidth?: number;
  packageHeight?: number;
  packageWeight?: number;
}

interface KeepaResponse {
  products?: KeepaProduct[];
  /** Keepa sends an object (`{ type, message, details }`); tolerate a plain string too. */
  error?: string | { type?: string; message?: string; details?: string };
  tokensLeft?: number;
  refillIn?: number;
}

const keepaErrorMessage = (error: KeepaResponse['error']): string | undefined =>
  typeof error === 'string' ? error : error?.message || error?.type || undefined;

const tokenHints = (data: KeepaResponse | null): Pick<KeepaEnrichResult, 'tokensLeft' | 'refillIn'> => ({
  ...(typeof data?.tokensLeft === 'number' ? { tokensLeft: data.tokensLeft } : {}),
  ...(typeof data?.refillIn === 'number' ? { refillIn: data.refillIn } : {}),
});

/**
 * Fetch Keepa product data and compute weight (lb) + max units per box.
 * Never call from the client — API key stays server-side.
 * Never throws: transport and Keepa-side failures come back as `{ error, retryable }`.
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
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: unknown) {
    return {
      asin: clean,
      error: `Keepa request failed: ${err instanceof Error ? err.message : 'network error'}`,
      retryable: true,
    };
  }

  let data: KeepaResponse | null = null;
  try {
    data = (await res.json()) as KeepaResponse;
  } catch {
    data = null;
  }
  const hints = tokenHints(data);

  if (!res.ok) {
    const message = keepaErrorMessage(data?.error);
    return {
      asin: clean,
      error: message ? `Keepa HTTP ${res.status}: ${message}` : `Keepa HTTP ${res.status}`,
      retryable: res.status === 429 || res.status >= 500,
      ...hints,
    };
  }

  if (!data) {
    return { asin: clean, error: 'Keepa returned an unreadable response', retryable: true };
  }

  const dataError = keepaErrorMessage(data.error);
  if (dataError) {
    return {
      asin: clean,
      error: dataError,
      retryable: /token|rate.?limit|too many/i.test(dataError),
      ...hints,
    };
  }

  const product = data.products?.[0];
  if (!product) {
    return { asin: clean, error: 'ASIN not found in Keepa', ...hints };
  }

  const result: KeepaEnrichResult = {
    asin: clean,
    productName: product.title?.trim() || undefined,
    ...hints,
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
