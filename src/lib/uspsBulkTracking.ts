/** USPS multi-track pages accept this many labels per request. */
export const USPS_BULK_CHUNK_SIZE = 35;

/**
 * Build a USPS bulk tracking URL for a chunk of tracking numbers.
 * Format matches the USPS tools.usps.com/tracking full-page multi-label link:
 * `?tRef=fullpage&tLc=N&text28777=&tLabels=TN1%2CTN2%2C…%2C&tABt=false`
 */
export function buildUspsBulkTrackingUrl(trackingNumbers: string[]): string {
  const labels = trackingNumbers.map((tn) => tn.trim()).filter((tn) => tn.length > 0);
  // Trailing comma is part of the USPS fullpage link pattern.
  const tLabels = encodeURIComponent(labels.join(',') + (labels.length ? ',' : ''));
  const tLc = String(labels.length);
  return (
    `https://tools.usps.com/tracking/?tRef=fullpage&tLc=${tLc}` +
    `&text28777=&tLabels=${tLabels}&tABt=false`
  );
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
