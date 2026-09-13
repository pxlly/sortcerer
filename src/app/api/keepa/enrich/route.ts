import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { enrichAsinWithKeepa, type KeepaEnrichResult } from '@/lib/keepa';

// Up to 20 sequential Keepa calls per request; the platform default of 10s can cut a batch off.
export const maxDuration = 60;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.KEEPA_API_KEY) {
    return NextResponse.json(
      {
        error: 'Keepa is not configured. Set KEEPA_API_KEY in the server environment.',
        configured: false,
      },
      { status: 503 }
    );
  }

  let body: { asins?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const asins = Array.isArray(body.asins)
    ? [...new Set(body.asins.map((a) => String(a).trim().toUpperCase()).filter(Boolean))]
    : [];

  if (asins.length === 0) {
    return NextResponse.json({ error: 'asins[] required' }, { status: 400 });
  }
  if (asins.length > 20) {
    return NextResponse.json({ error: 'Max 20 ASINs per request' }, { status: 400 });
  }

  // One bad ASIN must never turn the whole batch into a 500; report it per ASIN instead.
  const results: KeepaEnrichResult[] = [];
  for (const asin of asins) {
    try {
      results.push(await enrichAsinWithKeepa(asin));
    } catch (err: unknown) {
      results.push({
        asin,
        error: err instanceof Error ? err.message : 'Keepa lookup failed',
        retryable: true,
      });
    }
  }

  const refillIn = results.reduce<number | undefined>(
    (max, r) => (typeof r.refillIn === 'number' ? Math.max(max ?? 0, r.refillIn) : max),
    undefined
  );

  return NextResponse.json({ results, ...(refillIn != null ? { refillIn } : {}) });
}
