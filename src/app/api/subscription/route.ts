import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('status, current_period_end, last_invoice_id, last_order_id, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  const now = Date.now();
  const active =
    sub?.status === 'active' &&
    !!sub.current_period_end &&
    new Date(sub.current_period_end).getTime() > now;

  return NextResponse.json({
    active,
    status: active ? 'active' : 'locked',
    current_period_end: sub?.current_period_end ?? null,
    last_invoice_id: sub?.last_invoice_id ?? null,
    configured: Boolean(process.env.TRYBIT_API_KEY && process.env.TRYBIT_SHOP_ID),
  });
}
