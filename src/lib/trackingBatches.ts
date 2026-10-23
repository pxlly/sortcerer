/** Shared types for tracking batches (one batch = one Order Hub workflow session). */

export type TrackingNumberRow = {
  id?: string;
  tracking_number: string;
  recipient_name?: string | null;
  batch_id?: string | null;
  created_at?: string;
};

export type TrackingBatch = {
  id: string;
  label: string | null;
  tracking_count: number;
  created_at: string;
};

/** A batch with its tracking numbers, as served by GET /api/tracking-numbers. */
export type TrackingBatchGroup = TrackingBatch & {
  /** `true` for the synthetic group of rows saved before batches existed. */
  legacy?: boolean;
  rows: TrackingNumberRow[];
};

/**
 * Raw per-account counts returned by GET /api/tracking-numbers alongside the grouped batches, so
 * the Tracking page can show what is actually stored even when the grouped list is empty.
 */
export type TrackingMeta = {
  /** tracking_numbers rows visible to this account. */
  numberCount: number;
  /** tracking_batches rows visible to this account. */
  batchCount: number;
  /** Numbers with no batch, or whose batch no longer exists (shown under "Earlier uploads"). */
  unbatchedCount: number;
  /** Subset of `unbatchedCount` that still points at a batch id that was not returned. */
  orphanedCount: number;
  /** Batches that have no visible numbers. */
  emptyBatchCount: number;
};

/** Pseudo batch id for numbers with no `batch_id` (saved before batches existed). */
export const LEGACY_BATCH_ID = 'legacy';
