'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const SIGNUP_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = createClient();
      const emailRedirectTo = `${window.location.origin}/auth/callback?next=/billing`;
      const { data, error: err } = await withTimeout(
        supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo },
        }),
        SIGNUP_TIMEOUT_MS,
        'Sign up timed out. Check NEXT_PUBLIC_SUPABASE_URL / ANON_KEY on Vercel, and that your Supabase project is reachable.'
      );
      if (err) {
        setError(err.message);
        return;
      }
      // Supabase returns a user with empty identities when the email is already registered
      // and Confirm email is enabled (avoids leaking account existence).
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        setError('An account with this email may already exist. Try signing in.');
        return;
      }
      if (data.session) {
        router.push('/billing');
        router.refresh();
        return;
      }
      setInfo(
        'Check your email to confirm your account, then sign in. New accounts stay locked until payment.'
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sc-auth-card">
      <h1>Create account</h1>
      <p>$100/month via Trybit. Account unlocks after payment.</p>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {error && <div className="order-hub-error">{error}</div>}
        {info && <div className="order-hub-success">{info}</div>}
        <button type="submit" className="order-hub-btn order-hub-btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Sign up'}
        </button>
      </form>
      <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}
