/** Map browser/network/auth failures to actionable UI copy. */
export function formatAuthError(err: unknown): string {
  if (err == null) return 'Authentication failed.';

  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = String((err as { message: unknown }).message ?? '');
    const lower = message.toLowerCase();

    if (
      lower === 'failed to fetch' ||
      lower.includes('networkerror') ||
      lower.includes('load failed') ||
      lower.includes('network request failed')
    ) {
      return (
        'Could not reach Supabase (network). Confirm NEXT_PUBLIC_SUPABASE_URL is correct ' +
        '(https://YOUR_REF.supabase.co, no quotes/trailing slash), the project is not paused/deleted, ' +
        'then redeploy. Also try incognito / disable blockers, and open that URL + /auth/v1/health in a tab.'
      );
    }

    if (message.includes('Auth is not configured') || message.includes('Invalid NEXT_PUBLIC_SUPABASE')) {
      return message;
    }

    if (message.includes('timed out') || message.includes('Sign up timed out')) {
      return message;
    }

    return message || 'Authentication failed.';
  }

  if (err instanceof Error) {
    return formatAuthError({ message: err.message });
  }

  return 'Authentication failed.';
}
