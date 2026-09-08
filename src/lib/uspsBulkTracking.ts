/** USPS multi-track pages accept this many labels per request (matches WeShop Tracking Center). */
export const USPS_BULK_CHUNK_SIZE = 35;

/**
 * Build a USPS bulk tracking URL for a chunk of tracking numbers.
 * Matches WeShop's TrackConfirmAction pattern (comma-separated tLabels).
 */
export function buildUspsBulkTrackingUrl(trackingNumbers: string[]): string {
  const labels = trackingNumbers
    .map((tn) => tn.trim())
    .filter((tn) => tn.length > 0)
    .join(',');
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(labels)}`;
}

/** Split a list into chunks of `size` (default 35). */
export function chunkTrackingNumbers<T>(items: T[], size = USPS_BULK_CHUNK_SIZE): T[][] {
  const chunkSize = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}
