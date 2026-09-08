import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { formatDbError } from '@/lib/supabase/dbErrors';

export type TrackingNumberRow = {
  id?: string;
  tracking_number: string;
  recipient_name?: string | null;
  batch_id?: string | null;
  uploaded_at?: string;
  created_at?: string;
  updated_at?: string;
};

type UpsertRow = {
  user_id: string;
  tracking_number: string;
  recipient_name: string | null;
  batch_id: string | null;
  uploaded_at: string;
  updated_at: string;
};

const SELECT_COLS =
  'id, tracking_number, recipient_name, batch_id, uploaded_at, created_at, updated_at';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('tracking_numbers')
    .select(SELECT_COLS)
    .eq('user_id', user.id)
    .order('uploaded_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: formatDbError(error.message) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

/** Batch upsert by (user_id, tracking_number). Body: { rows: TrackingNumberRow[], batch_id?: string } */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { rows?: TrackingNumberRow[]; batch_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'rows[] required' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const batchId =
    typeof body.batch_id === 'string' && body.batch_id.trim()
      ? body.batch_id.trim()
      : crypto.randomUUID();

  // Collapse duplicate tracking numbers in one request (keep last).
  const byTn = new Map<string, UpsertRow>();
  for (const r of rows) {
    const trackingNumber = String(r.tracking_number || '').trim();
    if (!trackingNumber) continue;
    const recipientName = r.recipient_name ? String(r.recipient_name).trim() : null;
    byTn.set(trackingNumber, {
      user_id: user.id,
      tracking_number: trackingNumber,
      recipient_name: recipientName || null,
      batch_id: batchId,
      uploaded_at: now,
      updated_at: now,
    });
  }

  const payload = [...byTn.values()];
  if (payload.length === 0) {
    return NextResponse.json({ error: 'No valid tracking numbers' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('tracking_numbers')
    .upsert(payload, { onConflict: 'user_id,tracking_number' })
    .select(SELECT_COLS);

  if (error) {
    return NextResponse.json({ error: formatDbError(error.message) }, { status: 500 });
  }

  return NextResponse.json({
    rows: data ?? [],
    upserted: payload.length,
    batch_id: batchId,
  });
}
