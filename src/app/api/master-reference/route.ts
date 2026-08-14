import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { formatDbError } from '@/lib/supabase/dbErrors';

export type MasterRefRow = {
  id?: string;
  asin: string;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
  updated_at?: string;
};

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

/** Upsert by ASIN (unique per user). Body: { rows: MasterRefRow[] } */
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
  // Catalog PDFs / CSVs often repeat ASINs — keep the last occurrence per ASIN.
  const byAsin = new Map<
    string,
    {
      user_id: string;
      asin: string;
      sku: string;
      weight_lb: number | null;
      max_qty_per_box: number | null;
      product_name: string | null;
      updated_at: string;
    }
  >();

  for (const r of rows) {
    const asin = String(r.asin || '').trim().toUpperCase();
    const sku = String(r.sku || '').trim();
    if (!asin || !sku) continue;
    byAsin.set(asin, {
      user_id: user.id,
      asin,
      sku,
      weight_lb: r.weight_lb == null || r.weight_lb === ('' as unknown) ? null : Number(r.weight_lb),
      max_qty_per_box:
        r.max_qty_per_box == null || r.max_qty_per_box === ('' as unknown)
          ? null
          : Math.max(1, parseInt(String(r.max_qty_per_box), 10) || 1),
      product_name: r.product_name ? String(r.product_name).trim() : null,
      updated_at: now,
    });
  }

  const payload = [...byAsin.values()];
  const duplicatesCollapsed = rows.length - payload.length;

  if (payload.length === 0) {
    return NextResponse.json({ error: 'No valid rows (ASIN + SKU required)' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('master_reference')
    .upsert(payload, { onConflict: 'user_id,asin' })
    .select('id, asin, sku, weight_lb, max_qty_per_box, product_name, updated_at');

  if (error) return NextResponse.json({ error: formatDbError(error.message) }, { status: 500 });
  return NextResponse.json({
    rows: data ?? [],
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
  const asin = searchParams.get('asin')?.trim().toUpperCase();
  if (!asin) return NextResponse.json({ error: 'asin required' }, { status: 400 });

  const { error } = await supabase
    .from('master_reference')
    .delete()
    .eq('user_id', user.id)
    .eq('asin', asin);

  if (error) return NextResponse.json({ error: formatDbError(error.message) }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
