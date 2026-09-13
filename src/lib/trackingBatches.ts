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

/** Pseudo batch id for numbers with no `batch_id` (saved before batches existed). */
export const LEGACY_BATCH_ID = 'legacy';
