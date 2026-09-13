import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { formatDbError } from '@/lib/supabase/dbErrors';
import {
  LEGACY_BATCH_ID,
  type TrackingBatch,
  type TrackingBatchGroup,
  type TrackingNumberRow,
} from '@/lib/trackingBatches';

type UpsertRow = {
  user_id: string;
  tracking_number: string;
  recipient_name: string | null;
  batch_id: string;
};

const NUMBER_COLS = 'id, tracking_number, recipient_name, batch_id, created_at';
const BATCH_COLS = 'id, label, tracking_count, created_at';

type DbError = { message: string; code?: string | null } | null;

function dbErrorResponse(error: NonNullable<DbError>) {
  return NextResponse.json(
    { error: formatDbError(error.message, error.code ?? undefined) },
    { status: 500 }
  );
}

/** Returns every batch (newest first) with its numbers, plus an "Earlier uploads" group for legacy rows. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [batchesRes, rowsRes] = await Promise.all([
    supabase
      .from('tracking_batches')
      .select(BATCH_COLS)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('tracking_numbers')
      .select(NUMBER_COLS)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .order('tracking_number', { ascending: true }),
  ]);

  if (batchesRes.error) return dbErrorResponse(batchesRes.error);
  if (rowsRes.error) return dbErrorResponse(rowsRes.error);

  const groups = new Map<string, TrackingBatchGroup>();
  for (const b of (batchesRes.data ?? []) as TrackingBatch[]) {
    groups.set(b.id, { ...b, rows: [] });
  }

  const legacyRows: TrackingNumberRow[] = [];
  for (const row of (rowsRes.data ?? []) as TrackingNumberRow[]) {
    const group = row.batch_id ? groups.get(row.batch_id) : undefined;
    if (group) group.rows.push(row);
    else legacyRows.push(row);
  }

  const batches: TrackingBatchGroup[] = [...groups.values()].map((g) => ({
    ...g,
    tracking_count: g.rows.length || g.tracking_count,
  }));

  if (legacyRows.length > 0) {
    // Numbers saved before batches existed (or whose batch was orphaned) stay reachable in one group.
    const newest = legacyRows.reduce<string>(
      (max, r) => (r.created_at && r.created_at > max ? r.created_at : max),
      legacyRows[0]?.created_at ?? new Date(0).toISOString()
    );
    batches.push({
      id: LEGACY_BATCH_ID,
      legacy: true,
      label: 'Earlier uploads',
      tracking_count: legacyRows.length,
      created_at: newest,
      rows: legacyRows,
    });
  }

  return NextResponse.json({ batches });
}

/**
 * Save tracking numbers for one Order Hub workflow session.
 * Body: { rows: TrackingNumberRow[], batch_id?: string, label?: string }
 * - Without `batch_id` (or with one that isn't ours) a new batch is created.
 * - With a valid `batch_id` the numbers join that batch (multiple files in one session).
 * Rows upsert by (user_id, tracking_number), so re-uploaded numbers move into this batch.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { rows?: TrackingNumberRow[]; batch_id?: string; label?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'rows[] required' }, { status: 400 });
  }

  // Collapse duplicate tracking numbers in one request (keep last).
  const byTn = new Map<string, Omit<UpsertRow, 'batch_id'>>();
  for (const r of rows) {
    const trackingNumber = String(r.tracking_number || '').trim();
    if (!trackingNumber) continue;
    const recipientName = r.recipient_name ? String(r.recipient_name).trim() : null;
    byTn.set(trackingNumber, {
      user_id: user.id,
      tracking_number: trackingNumber,
      recipient_name: recipientName || null,
    });
  }
  if (byTn.size === 0) {
    return NextResponse.json({ error: 'No valid tracking numbers' }, { status: 400 });
  }

  const requestedBatchId =
    typeof body.batch_id === 'string' && body.batch_id.trim() ? body.batch_id.trim() : null;
  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 200)
      : null;

  let batch: TrackingBatch | null = null;
  if (requestedBatchId && requestedBatchId !== LEGACY_BATCH_ID) {
    const existing = await supabase
      .from('tracking_batches')
      .select(BATCH_COLS)
      .eq('id', requestedBatchId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existing.error) return dbErrorResponse(existing.error);
    batch = (existing.data as TrackingBatch | null) ?? null;
  }

  if (!batch) {
    const created = await supabase
      .from('tracking_batches')
      .insert({ user_id: user.id, label: label ?? 'Order Hub upload', tracking_count: 0 })
      .select(BATCH_COLS)
      .single();
    if (created.error) return dbErrorResponse(created.error);
    batch = created.data as TrackingBatch;
  }

  const payload: UpsertRow[] = [...byTn.values()].map((r) => ({ ...r, batch_id: batch!.id }));

  const upserted = await supabase
    .from('tracking_numbers')
    .upsert(payload, { onConflict: 'user_id,tracking_number' })
    .select(NUMBER_COLS);
  if (upserted.error) return dbErrorResponse(upserted.error);

  // Keep the denormalised count in sync (a session may upload more than one file).
  const counted = await supabase
    .from('tracking_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('batch_id', batch.id);
  const trackingCount = counted.error ? payload.length : counted.count ?? payload.length;

  const updatedBatch = await supabase
    .from('tracking_batches')
    .update({ tracking_count: trackingCount })
    .eq('id', batch.id)
    .eq('user_id', user.id)
    .select(BATCH_COLS)
    .single();
  if (!updatedBatch.error && updatedBatch.data) {
    batch = updatedBatch.data as TrackingBatch;
  } else {
    batch = { ...batch, tracking_count: trackingCount };
  }

  return NextResponse.json({
    rows: upserted.data ?? [],
    upserted: payload.length,
    batch,
    batch_id: batch.id,
  });
}

/**
 * Delete one batch (cascades to its tracking numbers): `?batch_id=<uuid>`.
 * `?batch_id=legacy` deletes the user's numbers that have no batch.
 */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const batchId = new URL(request.url).searchParams.get('batch_id')?.trim();
  if (!batchId) return NextResponse.json({ error: 'batch_id required' }, { status: 400 });

  if (batchId === LEGACY_BATCH_ID) {
    const { error } = await supabase
      .from('tracking_numbers')
      .delete()
      .eq('user_id', user.id)
      .is('batch_id', null);
    if (error) return dbErrorResponse(error);
    return NextResponse.json({ ok: true, batch_id: batchId });
  }

  const { error } = await supabase
    .from('tracking_batches')
    .delete()
    .eq('id', batchId)
    .eq('user_id', user.id);
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ ok: true, batch_id: batchId });
}
