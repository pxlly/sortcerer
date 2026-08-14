import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { formatDbError } from '@/lib/supabase/dbErrors';
import { capMaxQtyByWeight } from '@/lib/packing';

export type MasterRefRow = {
  id?: string;
  /** Optional: SKU is the identity. Stored as '' when unknown. */
  asin: string | null;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
  updated_at?: string;
};

type UpsertRow = {
  user_id: string;
  asin: string;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
  updated_at: string;
};

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const SELECT_COLS = 'id, asin, sku, weight_lb, max_qty_per_box, product_name, updated_at';

const MISSING_CONFLICT_TARGET = /no unique or exclusion constraint matching the on conflict/i;

/**
 * Upsert on (user_id, sku). Databases created before the SKU-uniqueness migration
 * have no matching constraint, so emulate the upsert row by row instead of failing.
 */
async function upsertBySku(
  supabase: SupabaseServerClient,
  userId: string,
  payload: UpsertRow[]
): Promise<{ rows: MasterRefRow[]; error?: never } | { rows?: never; error: string }> {
  const upserted = await supabase
    .from('master_reference')
    .upsert(payload, { onConflict: 'user_id,sku' })
    .select(SELECT_COLS);

  if (!upserted.error) return { rows: (upserted.data ?? []) as MasterRefRow[] };
  if (
    upserted.error.code !== '42P10' &&
    !MISSING_CONFLICT_TARGET.test(upserted.error.message)
  ) {
    return { error: upserted.error.message };
  }

  const existing = await supabase
    .from('master_reference')
    .select('id, sku')
    .eq('user_id', userId)
    .in(
      'sku',
      payload.map((r) => r.sku)
    );
  if (existing.error) return { error: existing.error.message };

  const idBySku = new Map<string, string>(
    (existing.data ?? []).map((r) => [r.sku as string, r.id as string])
  );
  const rows: MasterRefRow[] = [];

  for (const row of payload) {
    const id = idBySku.get(row.sku);
    const written = id
      ? await supabase
          .from('master_reference')
          .update(row)
          .eq('id', id)
          .eq('user_id', userId)
          .select(SELECT_COLS)
      : await supabase.from('master_reference').insert(row).select(SELECT_COLS);
    if (written.error) return { error: written.error.message };
    rows.push(...((written.data ?? []) as MasterRefRow[]));
  }

  return { rows };
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('master_reference')
    .select('id, asin, sku, weight_lb, max_qty_per_box, product_name, updated_at')
    .eq('user_id', user.id)
    .order('sku', { ascending: true });

  if (error) return NextResponse.json({ error: formatDbError(error.message) }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

/** Upsert by SKU (unique per user). Body: { rows: MasterRefRow[] } */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { rows?: MasterRefRow[] };
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
  // Postgres rejects a single INSERT…ON CONFLICT that targets the same row twice.
  // Catalog PDFs / CSVs can repeat SKUs — keep the last occurrence per SKU.
  // An ASIN may legitimately be used by multiple SKUs in one seller catalog.
  const bySku = new Map<string, UpsertRow>();

  for (const r of rows) {
    // ASIN is optional; '' keeps pre-migration `asin text not null` columns writable.
    const asin = String(r.asin ?? '').trim().toUpperCase();
    const sku = String(r.sku || '').trim();
    if (!sku) continue;
    const weightLb =
      r.weight_lb == null || r.weight_lb === ('' as unknown) ? null : Number(r.weight_lb);
    const requestedMaxQty =
      r.max_qty_per_box == null || r.max_qty_per_box === ('' as unknown)
        ? null
        : Math.max(1, parseInt(String(r.max_qty_per_box), 10) || 1);
    const maxQtyPerBox =
      weightLb != null && requestedMaxQty != null
        ? capMaxQtyByWeight(requestedMaxQty, weightLb)
        : requestedMaxQty;

    bySku.set(sku, {
      user_id: user.id,
      asin,
      sku,
      weight_lb: weightLb,
      max_qty_per_box: maxQtyPerBox,
      product_name: r.product_name ? String(r.product_name).trim() : null,
      updated_at: now,
    });
  }

  const payload = [...bySku.values()];
  const duplicatesCollapsed = rows.length - payload.length;

  if (payload.length === 0) {
    return NextResponse.json({ error: 'No valid rows (SKU required)' }, { status: 400 });
  }

  const result = await upsertBySku(supabase, user.id, payload);
  if (result.error) {
    return NextResponse.json({ error: formatDbError(result.error) }, { status: 500 });
  }

  return NextResponse.json({
    rows: result.rows,
    upserted: payload.length,
    duplicatesCollapsed: Math.max(0, duplicatesCollapsed),
  });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const sku = searchParams.get('sku')?.trim();
  if (!sku) return NextResponse.json({ error: 'sku required' }, { status: 400 });

  const { error } = await supabase
    .from('master_reference')
    .delete()
    .eq('user_id', user.id)
    .eq('sku', sku);

  if (error) return NextResponse.json({ error: formatDbError(error.message) }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
