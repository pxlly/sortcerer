import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { createServiceClient } from '@/lib/supabase/admin';

const PERIOD_DAYS = 30;

function getSecret() {
  const secret = process.env.TRYBIT_SECRET_KEY;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

async function validateToken(token: unknown): Promise<boolean> {
  if (token == null || token === '') return true;
  if (typeof token !== 'string') return false;
  const key = getSecret();
  if (!key) return false;
  try {
    await jwtVerify(token.trim(), key, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!process.env.TRYBIT_SECRET_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: 'Trybit postback not configured (TRYBIT_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 }
    );
  }

  const contentType = request.headers.get('content-type') || '';
  let data: Record<string, unknown>;

  try {
    if (contentType.includes('application/json')) {
      data = (await request.json()) as Record<string, unknown>;
    } else {
      const form = await request.formData();
      data = Object.fromEntries(form.entries()) as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const invoiceId = data.invoice_id != null ? String(data.invoice_id) : '';
  const orderId = data.order_id != null ? String(data.order_id) : '';
  const status = data.status != null ? String(data.status) : '';

  if (!invoiceId || !orderId) {
    return NextResponse.json({ error: 'Missing invoice_id or order_id' }, { status: 400 });
  }

  if (!(await validateToken(data.token))) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  if (status && status !== 'success') {
    return NextResponse.json({ message: 'Ignored non-success status' }, { status: 200 });
  }

  // order_id format: sortcerer-<userPrefix>-<timestamp>
  // Prefer matching last_order_id on subscriptions
  const admin = createServiceClient();

  const { data: byOrder } = await admin
    .from('subscriptions')
    .select('user_id, setup_paid')
    .eq('last_order_id', orderId)
    .maybeSingle();

  let userId = byOrder?.user_id as string | undefined;

  if (!userId) {
    const { data: byInvoice } = await admin
      .from('subscriptions')
      .select('user_id, setup_paid')
      .eq('last_invoice_id', invoiceId.startsWith('INV-') ? invoiceId : `INV-${invoiceId}`)
      .maybeSingle();
    userId = byInvoice?.user_id as string | undefined;
  }

  if (!userId && orderId.startsWith('sortcerer-')) {
    // Fallback: look up profiles if we stored nothing (shouldn't happen)
    return NextResponse.json({ error: 'Unknown order_id' }, { status: 404 });
  }

  if (!userId) {
    return NextResponse.json({ error: 'Subscription not found for order' }, { status: 404 });
  }

  const periodEnd = new Date(Date.now() + PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const invStored = invoiceId.startsWith('INV-') ? invoiceId : `INV-${invoiceId}`;

  // Any successful payment marks setup as paid (first invoice is the $300 setup fee).
  const { error } = await admin.from('subscriptions').upsert({
    user_id: userId,
    status: 'active',
    setup_paid: true,
    current_period_end: periodEnd,
    last_invoice_id: invStored,
    last_order_id: orderId,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: 'Postback received', status: 'active', current_period_end: periodEnd });
}
