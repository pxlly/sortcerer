import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isAdminEmail } from '@/lib/adminEmails';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  // Allow boot without env (docs / first clone)
  if (!url || !anon) {
    return supabaseResponse;
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // JSON API calls (fetch from the app) must never be answered with an HTML redirect:
  // `fetch` follows the redirect, lands on /login or /billing with status 200, and the
  // caller mistakes that page for a successful save.
  const isApi = path.startsWith('/api/');
  const isPublic =
    path === '/' ||
    path.startsWith('/login') ||
    path.startsWith('/signup') ||
    path.startsWith('/auth/') ||
    path.startsWith('/api/trybit/postback');

  if (!user && !isPublic) {
    if (isApi) {
      const detail = authError?.message?.toLowerCase() ?? '';
      const unreachable =
        detail.includes('fetch failed') ||
        detail.includes('network') ||
        detail.includes('timed out') ||
        detail.includes('econnrefused') ||
        detail.includes('paused') ||
        detail.includes('unavailable');
      return NextResponse.json(
        {
          error: unreachable
            ? 'Could not reach the database/auth server (Supabase). If the project is on the free tier it may be paused — open the Supabase dashboard and click Restore, then retry.'
            : 'Your session has expired. Sign in again, then retry.',
          code: unreachable ? 'db_unreachable' : 'unauthorized',
        },
        { status: unreachable ? 503 : 401 }
      );
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('next', path);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && (path.startsWith('/login') || path.startsWith('/signup'))) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/hub';
    return NextResponse.redirect(redirectUrl);
  }

  // Subscription gate: active required for app pages (billing + auth + webhook exempt)
  const subscriptionExempt =
    isPublic ||
    path.startsWith('/billing') ||
    path.startsWith('/api/trybit/') ||
    path.startsWith('/api/subscription');

  if (user && !subscriptionExempt) {
    if (isAdminEmail(user.email)) {
      return supabaseResponse;
    }

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', user.id)
      .maybeSingle();

    const now = Date.now();
    const periodOk =
      sub?.status === 'active' &&
      sub.current_period_end &&
      new Date(sub.current_period_end).getTime() > now;

    if (!periodOk) {
      if (isApi) {
        return NextResponse.json(
          {
            error: 'Your Sortcerer subscription is not active. Open Billing to renew, then retry.',
            code: 'subscription_inactive',
          },
          { status: 402 }
        );
      }
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = '/billing';
      return NextResponse.redirect(redirectUrl);
    }
  }

  return supabaseResponse;
}
