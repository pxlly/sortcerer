import { NextResponse } from 'next/server';
import { isAdminEmail } from '@/lib/adminEmails';
import { invoiceAmountUsd, MONTHLY_USD, SETUP_FEE_USD } from '@/lib/pricing';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (isAdminEmail(user.email)) {
    return NextResponse.json({
      active: true,
      admin: true,
      status: 'active',
      setup_paid: true,
      next_amount_usd: MONTHLY_USD,
      setup_fee_usd: SETUP_FEE_USD,
      monthly_usd: MONTHLY_USD,
      current_period_end: null,
      last_invoice_id: null,
      configured: Boolean(process.env.TRYBIT_API_KEY && process.env.TRYBIT_SHOP_ID),
    });
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('status, setup_paid, current_period_end, last_invoice_id, last_order_id, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  const now = Date.now();
  const active =
    sub?.status === 'active' &&
    !!sub.current_period_end &&
    new Date(sub.current_period_end).getTime() > now;
  const setupPaid = Boolean(sub?.setup_paid);

  return NextResponse.json({
    active,
    admin: false,
    status: active ? 'active' : 'locked',
    setup_paid: setupPaid,
    next_amount_usd: invoiceAmountUsd(setupPaid),
    setup_fee_usd: SETUP_FEE_USD,
    monthly_usd: MONTHLY_USD,
    current_period_end: sub?.current_period_end ?? null,
    last_invoice_id: sub?.last_invoice_id ?? null,
    configured: Boolean(process.env.TRYBIT_API_KEY && process.env.TRYBIT_SHOP_ID),
  });
}
