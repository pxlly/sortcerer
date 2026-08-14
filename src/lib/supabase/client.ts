import { createBrowserClient } from '@supabase/ssr';

function requirePublicSupabaseEnv(): { url: string; anon: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anon) {
    throw new Error(
      'Auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY on Vercel (Production), then redeploy.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'Invalid NEXT_PUBLIC_SUPABASE_URL. Use https://YOUR_PROJECT_REF.supabase.co with no quotes or trailing slash.'
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL must use https://');
  }

  // Reject accidental quotes pasted from docs
  if (url.includes('"') || url.includes("'") || anon.includes('"') || anon.includes("'")) {
    throw new Error(
      'Supabase URL/key must not include quote characters. Paste the bare value from the API settings page.'
    );
  }

  return { url: parsed.origin, anon };
}

export function createClient() {
  const { url, anon } = requirePublicSupabaseEnv();
  return createBrowserClient(url, anon);
}
