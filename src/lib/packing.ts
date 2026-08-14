/** Default FBM packing box (inches). */
export const DEFAULT_BOX_IN = {
  length: 8.5,
  width: 12,
  height: 12.25,
} as const;

const MM_TO_IN = 1 / 25.4;
const G_TO_LB = 1 / 453.59237;

export interface UnitDimsMm {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface PackingResult {
  maxQtyPerBox: number;
  orientationUsed: { l: number; w: number; h: number };
}

/**
 * Convert Keepa package dims (mm) → inches and try all axis orientations of the unit prism.
 * maxQty = max over orientations of floor(boxL/uL)*floor(boxW/uW)*floor(boxH/uH)
 */
export function maxUnitsPerBox(
  dimsMm: UnitDimsMm,
  box = DEFAULT_BOX_IN
): PackingResult | { error: string } {
  const { lengthMm, widthMm, heightMm } = dimsMm;
  if (
    !Number.isFinite(lengthMm) ||
    !Number.isFinite(widthMm) ||
    !Number.isFinite(heightMm) ||
    lengthMm <= 0 ||
    widthMm <= 0 ||
    heightMm <= 0
  ) {
    return { error: 'Missing or invalid package dimensions' };
  }

  const l = lengthMm * MM_TO_IN;
  const w = widthMm * MM_TO_IN;
  const h = heightMm * MM_TO_IN;

  const orientations: Array<[number, number, number]> = [
    [l, w, h],
    [l, h, w],
    [w, l, h],
    [w, h, l],
    [h, l, w],
    [h, w, l],
  ];

  let best = 0;
  let bestOri = { l, w, h };

  for (const [uL, uW, uH] of orientations) {
    const qty =
      Math.floor(box.length / uL) * Math.floor(box.width / uW) * Math.floor(box.height / uH);
    if (qty > best) {
      best = qty;
      bestOri = { l: uL, w: uW, h: uH };
    }
  }

  // Unfit in any orientation: still store 1 (not 0/null) for master reference.
  if (best < 1) {
    return { maxQtyPerBox: 1, orientationUsed: bestOri };
  }

  return { maxQtyPerBox: best, orientationUsed: bestOri };
}

/** Keepa packageWeight is grams → lb, round UP to whole lb, minimum 1. */
export function gramsToWeightLb(grams: number): number | { error: string } {
  if (!Number.isFinite(grams) || grams <= 0) {
    return { error: 'Missing or invalid package weight' };
  }
  const lb = grams * G_TO_LB;
  return Math.max(1, Math.ceil(lb));
}
