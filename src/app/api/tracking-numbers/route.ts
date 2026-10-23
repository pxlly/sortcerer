import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  formatDbError,
  isDbUnreachableError,
  isMissingConflictTargetError,
} from '@/lib/supabase/dbErrors';
import {
  LEGACY_BATCH_ID,
  type TrackingBatch,
  type TrackingBatchGroup,
  type TrackingMeta,
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

type DbError = { message: string; code?: string | null; details?: string | null; hint?: string | null } | null;

/**
 * Every failure is logged with enough context to diagnose it from the Vercel runtime logs
 * (which step failed, for whom, how many rows) without exposing the tracking numbers themselves.
 */
function logFailure(step: string, context: Record<string, unknown>, error: NonNullable<DbError> | unknown) {
  const err =
    error && typeof error === 'object' && 'message' in error
      ? {
          message: String((error as { message: unknown }).message),
          code: (error as { code?: unknown }).code ?? null,
          details: (error as { details?: unknown }).details ?? null,
          hint: (error as { hint?: unknown }).hint ?? null,
        }
      : { message: String(error) };
  console.error(`[tracking-numbers] ${step} failed`, JSON.stringify({ ...context, error: err }));
}

function dbErrorResponse(error: NonNullable<DbError>) {
  const code = error.code ?? undefined;
  return NextResponse.json(
    { error: formatDbError(error.message, code), code: code ?? null },
    { status: isDbUnreachableError(error.message, code) ? 503 : 500 }
  );
}

/** Unexpected throw (missing env, Supabase unreachable, …) → JSON instead of an HTML 500 page. */
function unexpectedErrorResponse(method: string, err: unknown) {
  logFailure(`${method} unexpected`, {}, err);
  const message = err instanceof Error ? err.message : String(err);
  return dbErrorResponse({ message });
}

/** Resolve the auth user, mapping a dead Supabase connection to a clear 503 instead of a bare 401. */
async function requireUser(supabase: Awaited<ReturnType<typeof createClient>>, method: string) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (user) return { user, response: null as NextResponse | null };
  if (error && isDbUnreachableError(error.message, error.code)) {
    logFailure(`${method} auth`, {}, error);
    return { user: null, response: dbErrorResponse({ message: error.message, code: error.code }) };
  }
  console.warn(`[tracking-numbers] ${method} rejected: no session`, error?.message ?? '');
  return {
    user: null,
    response: NextResponse.json(
      { error: 'Your session has expired. Sign in again, then retry.', code: 'unauthorized' },
      { status: 401 }
    ),
  };
}

const CHUNK = 500;
function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Returns every batch (newest first) with its numbers, plus an "Earlier uploads" group for legacy
 * rows, and `meta` with raw per-table counts so the Tracking page can prove whether anything is
 * stored for this account even when the grouped list comes back empty.
 */
export async function GET() {
  try {
    return await handleGet();
  } catch (err) {
    return unexpectedErrorResponse('GET', err);
  }
}

async function handleGet() {
  const supabase = await createClient();
  const { user, response } = await requireUser(supabase, 'GET');
  if (!user) return response!;

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

  if (batchesRes.error) {
    logFailure('GET batches select', { userId: user.id }, batchesRes.error);
    return dbErrorResponse(batchesRes.error);
  }
  if (rowsRes.error) {
    logFailure('GET numbers select', { userId: user.id }, rowsRes.error);
    return dbErrorResponse(rowsRes.error);
  }

  const groups = new Map<string, TrackingBatchGroup>();
  for (const b of (batchesRes.data ?? []) as TrackingBatch[]) {
    groups.set(b.id, { ...b, rows: [] });
  }

  const legacyRows: TrackingNumberRow[] = [];
  let orphanedRows = 0;
  for (const row of (rowsRes.data ?? []) as TrackingNumberRow[]) {
    const group = row.batch_id ? groups.get(row.batch_id) : undefined;
    if (group) group.rows.push(row);
    else {
      if (row.batch_id) orphanedRows += 1;
      legacyRows.push(row);
    }
  }

  const meta: TrackingMeta = {
    numberCount: rowsRes.data?.length ?? 0,
    batchCount: batchesRes.data?.length ?? 0,
    unbatchedCount: legacyRows.length,
    orphanedCount: orphanedRows,
    emptyBatchCount: [...groups.values()].filter((g) => g.rows.length === 0).length,
  };

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

  return NextResponse.json({ batches, meta });
}

/**
 * Save tracking numbers for one Order Hub workflow session.
 * Body: { rows: TrackingNumberRow[], batch_id?: string, label?: string }
 * - Without `batch_id` (or with one that isn't ours) a new batch is created.
 * - With a valid `batch_id` the numbers join that batch (multiple files in one session).
 * Rows upsert by (user_id, tracking_number), so re-uploaded numbers move into this batch.
 */
export async function POST(request: Request) {
  try {
    return await handlePost(request);
  } catch (err) {
    return unexpectedErrorResponse('POST', err);
  }
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const { user, response } = await requireUser(supabase, 'POST');
  if (!user) return response!;

  let body: { rows?: TrackingNumberRow[]; batch_id?: string; label?: string };
  try {
    body = await request.json();
  } catch (err) {
    logFailure('POST body parse', { userId: user.id }, err);
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    console.warn('[tracking-numbers] POST rejected: rows[] empty', JSON.stringify({ userId: user.id }));
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
    console.warn(
      '[tracking-numbers] POST rejected: no valid numbers',
      JSON.stringify({ userId: user.id, rows: rows.length })
    );
    return NextResponse.json({ error: 'No valid tracking numbers' }, { status: 400 });
  }

  const requestedBatchId =
    typeof body.batch_id === 'string' && body.batch_id.trim() ? body.batch_id.trim() : null;
  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 200)
      : null;
  const logContext = {
    userId: user.id,
    rows: byTn.size,
    requestedBatchId,
    label,
  };

  // Which of these numbers does this user already have? Needed for the saved/moved counts and
  // for the fallback path when the (user_id, tracking_number) unique constraint is missing.
  const allTns = [...byTn.keys()];
  const existingIds = new Map<string, string>(); // tracking_number -> row id
  for (const part of chunk(allTns)) {
    const found = await supabase
      .from('tracking_numbers')
      .select('id, tracking_number')
      .eq('user_id', user.id)
      .in('tracking_number', part);
    if (found.error) {
      logFailure('POST existing-numbers select', logContext, found.error);
      return dbErrorResponse(found.error);
    }
    for (const r of (found.data ?? []) as { id: string; tracking_number: string }[]) {
      existingIds.set(r.tracking_number, r.id);
    }
  }

  // The batch row is created before any numbers so every saved number has a home.
  let batch: TrackingBatch | null = null;
  let createdBatch = false;
  if (requestedBatchId && requestedBatchId !== LEGACY_BATCH_ID) {
    const existing = await supabase
      .from('tracking_batches')
      .select(BATCH_COLS)
      .eq('id', requestedBatchId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existing.error) {
      logFailure('POST batch lookup', logContext, existing.error);
      return dbErrorResponse(existing.error);
    }
    batch = (existing.data as TrackingBatch | null) ?? null;
    if (!batch) {
      console.warn(
        '[tracking-numbers] POST: requested batch not found for user; creating a new one',
        JSON.stringify(logContext)
      );
    }
  }

  if (!batch) {
    const created = await supabase
      .from('tracking_batches')
      .insert({ user_id: user.id, label: label ?? 'Order Hub upload', tracking_count: 0 })
      .select(BATCH_COLS)
      .single();
    if (created.error) {
      logFailure('POST batch insert', logContext, created.error);
      return dbErrorResponse(created.error);
    }
    batch = created.data as TrackingBatch;
    createdBatch = true;
  }
  const batchId = batch.id;

  // If saving the numbers fails, don't leave an empty batch behind on the Tracking page.
  const failWith = async (step: string, error: NonNullable<DbError>) => {
    logFailure(step, { ...logContext, batchId, createdBatch }, error);
    if (createdBatch) {
      const removed = await supabase
        .from('tracking_batches')
        .delete()
        .eq('id', batchId)
        .eq('user_id', user.id);
      if (removed.error) logFailure('POST empty-batch cleanup', { ...logContext, batchId }, removed.error);
    }
    return dbErrorResponse(error);
  };

  const payload: UpsertRow[] = [...byTn.values()].map((r) => ({ ...r, batch_id: batchId }));
  const newRows = payload.filter((r) => !existingIds.has(r.tracking_number));
  const existingRows = payload.filter((r) => existingIds.has(r.tracking_number));

  // Preferred path: one upsert. Re-uploaded numbers move into this batch (and refresh the
  // recipient name) so the per-session "Track" button covers every label in the session.
  const upserted = await supabase
    .from('tracking_numbers')
    .upsert(payload, { onConflict: 'user_id,tracking_number' })
    .select(NUMBER_COLS);

  if (upserted.error && !isMissingConflictTargetError(upserted.error.message, upserted.error.code)) {
    return failWith('POST numbers upsert', upserted.error);
  }

  if (upserted.error) {
    // The database has no unique (user_id, tracking_number) constraint (table predates schema.sql
    // or the constraint was dropped), so ON CONFLICT cannot be used. Insert the new numbers and
    // update the existing ones by id instead — nothing is rejected as a duplicate.
    console.warn(
      '[tracking-numbers] POST: no unique (user_id, tracking_number) constraint; using insert+update fallback',
      JSON.stringify({ ...logContext, batchId })
    );
    if (newRows.length > 0) {
      for (const part of chunk(newRows)) {
        const inserted = await supabase.from('tracking_numbers').insert(part);
        if (inserted.error) return failWith('POST numbers insert (fallback)', inserted.error);
      }
    }
    for (const r of existingRows) {
      const id = existingIds.get(r.tracking_number)!;
      const updated = await supabase
        .from('tracking_numbers')
        .update({ batch_id: batchId, recipient_name: r.recipient_name })
        .eq('id', id)
        .eq('user_id', user.id);
      if (updated.error) return failWith('POST numbers update (fallback)', updated.error);
    }
  }

  // Read back what is actually attached to the batch. This is the number the Tracking page will
  // show, so it doubles as end-to-end verification that the write really landed (RLS can make an
  // insert "succeed" with zero visible rows, and that must not be reported as a save).
  const counted = await supabase
    .from('tracking_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('batch_id', batchId);
  if (counted.error) {
    logFailure('POST verification count', { ...logContext, batchId }, counted.error);
  }
  const verifiedCount = counted.error ? null : counted.count ?? null;
  if (verifiedCount === 0) {
    // Don't delete the batch here: the rows may exist but be hidden by a missing SELECT policy,
    // and an empty batch on the Tracking page is a useful breadcrumb for that case.
    const error = {
      message:
        'The database accepted the tracking numbers but reports none attached to this upload ' +
        '(0 rows visible for your account). This usually means the tracking_numbers table has a ' +
        'row-level security policy that hides or rejects your rows. Re-run supabase/schema.sql ' +
        'in the Supabase SQL Editor, then retry.',
      code: 'verification_failed',
    };
    logFailure('POST verification', { ...logContext, batchId, createdBatch }, error);
    return dbErrorResponse(error);
  }
  const trackingCount = verifiedCount ?? payload.length;

  const updatedBatch = await supabase
    .from('tracking_batches')
    .update({ tracking_count: trackingCount })
    .eq('id', batchId)
    .eq('user_id', user.id)
    .select(BATCH_COLS)
    .single();
  if (!updatedBatch.error && updatedBatch.data) {
    batch = updatedBatch.data as TrackingBatch;
  } else {
    if (updatedBatch.error) {
      logFailure('POST batch count update (non-fatal)', { ...logContext, batchId }, updatedBatch.error);
    }
    batch = { ...batch, tracking_count: trackingCount };
  }

  let savedRows: TrackingNumberRow[] = (upserted.data ?? []) as TrackingNumberRow[];
  if (upserted.error || savedRows.length === 0) {
    const reread = await supabase
      .from('tracking_numbers')
      .select(NUMBER_COLS)
      .eq('user_id', user.id)
      .eq('batch_id', batchId)
      .in('tracking_number', allTns.slice(0, CHUNK));
    if (reread.error) logFailure('POST reread (non-fatal)', { ...logContext, batchId }, reread.error);
    savedRows = (reread.data ?? []) as TrackingNumberRow[];
  }

  console.info(
    '[tracking-numbers] POST saved',
    JSON.stringify({
      ...logContext,
      batchId,
      createdBatch,
      saved: newRows.length,
      moved: existingRows.length,
      verifiedCount,
    })
  );

  return NextResponse.json({
    rows: savedRows,
    /** Total numbers from this request now attached to the batch (new + moved). */
    upserted: payload.length,
    /** Numbers this user had never saved before. */
    saved: newRows.length,
    /** Numbers already saved earlier; they were moved into this batch rather than rejected. */
    moved: existingRows.length,
    /** Rows the database reports attached to this batch after the write (null if the count failed). */
    verified_count: verifiedCount,
    batch,
    batch_id: batchId,
  });
}

/**
 * Delete one batch (cascades to its tracking numbers): `?batch_id=<uuid>`.
 * `?batch_id=legacy` deletes the user's numbers that have no batch.
 */
export async function DELETE(request: Request) {
  try {
    return await handleDelete(request);
  } catch (err) {
    return unexpectedErrorResponse('DELETE', err);
  }
}

async function handleDelete(request: Request) {
  const supabase = await createClient();
  const { user, response } = await requireUser(supabase, 'DELETE');
  if (!user) return response!;

  const batchId = new URL(request.url).searchParams.get('batch_id')?.trim();
  if (!batchId) return NextResponse.json({ error: 'batch_id required' }, { status: 400 });
  const logContext = { userId: user.id, batchId };

  if (batchId === LEGACY_BATCH_ID) {
    const { error } = await supabase
      .from('tracking_numbers')
      .delete()
      .eq('user_id', user.id)
      .is('batch_id', null);
    if (error) {
      logFailure('DELETE legacy numbers', logContext, error);
      return dbErrorResponse(error);
    }
    return NextResponse.json({ ok: true, batch_id: batchId });
  }

  // Delete the numbers explicitly: tables created before the batch_id foreign key existed have
  // no ON DELETE CASCADE, and orphaned numbers would otherwise reappear under "Earlier uploads".
  const numbers = await supabase
    .from('tracking_numbers')
    .delete()
    .eq('user_id', user.id)
    .eq('batch_id', batchId);
  if (numbers.error) {
    logFailure('DELETE batch numbers', logContext, numbers.error);
    return dbErrorResponse(numbers.error);
  }

  const { error } = await supabase
    .from('tracking_batches')
    .delete()
    .eq('id', batchId)
    .eq('user_id', user.id);
  if (error) {
    logFailure('DELETE batch', logContext, error);
    return dbErrorResponse(error);
  }
  return NextResponse.json({ ok: true, batch_id: batchId });
}
