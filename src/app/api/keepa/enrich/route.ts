import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { enrichAsinWithKeepa } from '@/lib/keepa';

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

  const results = [];
  for (const asin of asins) {
    results.push(await enrichAsinWithKeepa(asin));
  }

  return NextResponse.json({ results });
}
