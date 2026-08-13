import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/admin';

const MONTHLY_USD = 100;

export async function POST() {
  const apiKey = process.env.TRYBIT_API_KEY;
  const shopId = process.env.TRYBIT_SHOP_ID;

  if (!apiKey || !shopId) {
    return NextResponse.json(
      {
        error:
          'Trybit is not configured. Set TRYBIT_API_KEY and TRYBIT_SHOP_ID (see README).',
        configured: false,
      },
      { status: 503 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const orderId = `sortcerer-${user.id.slice(0, 8)}-${Date.now()}`;

  const res = await fetch('https://api.trybit.com/v2/invoice/create', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shop_id: shopId,
      amount: MONTHLY_USD,
      currency: 'USD',
      order_id: orderId,
      email: user.email ?? undefined,
      add_fields: {
        time_to_pay: { hours: 24, minutes: 0 },
      },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.status !== 'success') {
    return NextResponse.json(
      {
        error: 'Failed to create Trybit invoice',
        details: data,
      },
      { status: 502 }
    );
  }

  const result = data.result as { uuid?: string; link?: string; invoice_id?: string };
  const invoiceId = result.uuid || result.invoice_id || null;

  // Service role: users cannot self-activate; only store pending invoice metadata.
  try {
    const admin = createServiceClient();
    await admin.from('subscriptions').upsert({
      user_id: user.id,
      status: 'locked',
      last_invoice_id: invoiceId,
      last_order_id: orderId,
      updated_at: new Date().toISOString(),
    });
  } catch {
    // Still return payment link even if metadata write fails (misconfigured service key).
  }

  return NextResponse.json({
    orderId,
    invoiceId,
    link: result.link,
    amountUsd: MONTHLY_USD,
  });
}
