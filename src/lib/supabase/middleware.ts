import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic =
    path === '/' ||
    path.startsWith('/login') ||
    path.startsWith('/signup') ||
    path.startsWith('/auth/') ||
    path.startsWith('/api/trybit/postback');

  if (!user && !isPublic) {
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
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = '/billing';
      return NextResponse.redirect(redirectUrl);
    }
  }

  return supabaseResponse;
}
