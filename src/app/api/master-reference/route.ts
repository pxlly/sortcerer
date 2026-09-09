import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { formatDbError } from '@/lib/supabase/dbErrors';
import { capMaxQtyByWeight } from '@/lib/packing';

export type MasterRefRow = {
  id?: string;
  /** Optional: SKU is the identity. Null/empty when unknown. */
  asin: string | null;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
  updated_at?: string;
};

type UpsertRow = {
  user_id: string;
  /** Empty ASIN is stored as null so pre-migration unique(user_id, asin) allows many blank rows. */
  asin: string | null;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
  updated_at: string;
};

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const SELECT_COLS = 'id, asin, sku, weight_lb, max_qty_per_box, product_name, updated_at';

const ASIN_NOT_NULL = /null value in column ["']?asin["']?/i;

/**
 * Prefer select-then-update/insert by SKU so saves work even when the live DB still
 * lacks unique (user_id, sku) or still has unique (user_id, asin).
 * Empty ASINs use null (multiple NULLs are allowed under unique); if asin is still
 * NOT NULL, retry that row with ''.
 */
async function upsertBySku(
  supabase: SupabaseServerClient,
  userId: string,
  payload: UpsertRow[]
): Promise<{ rows: MasterRefRow[]; error?: never } | { rows?: never; error: string }> {
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
    let written = id
      ? await supabase
          .from('master_reference')
          .update(row)
          .eq('id', id)
          .eq('user_id', userId)
          .select(SELECT_COLS)
      : await supabase.from('master_reference').insert(row).select(SELECT_COLS);

    // Pre-migration: asin may still be NOT NULL — retry with '' for blank ASINs only.
    if (
      written.error &&
      ASIN_NOT_NULL.test(written.error.message) &&
      (row.asin == null || row.asin === '')
    ) {
      const withEmpty = { ...row, asin: '' };
      written = id
        ? await supabase
            .from('master_reference')
            .update(withEmpty)
            .eq('id', id)
            .eq('user_id', userId)
            .select(SELECT_COLS)
        : await supabase.from('master_reference').insert(withEmpty).select(SELECT_COLS);
    }

    if (written.error) {
      return { error: written.error.message };
    }
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
    // ASIN is optional. Prefer null over '' so unique(user_id, asin) still allows
    // multiple blank-ASIN rows before the SKU-uniqueness migration runs.
    const asinRaw = String(r.asin ?? '').trim().toUpperCase();
    const asin = asinRaw || null;
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
