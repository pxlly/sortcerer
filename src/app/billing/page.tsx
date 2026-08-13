'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

export default function BillingPage() {
  const [status, setStatus] = useState<{
    active: boolean;
    status: string;
    current_period_end: string | null;
    configured: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devUnlockNote, setDevUnlockNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/subscription');
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || 'Failed to load subscription');
      return;
    }
    setStatus(json);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    setDevUnlockNote(null);
    try {
      const res = await fetch('/api/trybit/create-invoice', { method: 'POST' });
      const json = await res.json();
      if (res.status === 503 && json.configured === false) {
        setError(json.error);
        setDevUnlockNote(
          'Dev tip: configure Trybit env vars, or temporarily set a subscription to active in Supabase SQL for testing.'
        );
        return;
      }
      if (!res.ok) throw new Error(json.error || 'Invoice failed');
      if (json.link) {
        window.location.href = json.link as string;
        return;
      }
      throw new Error('No payment link returned');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Payment failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="billing-card">
      <h1>Billing</h1>
      <p className="order-hub-min-orders-desc">
        Sortcerer is <span className="billing-price">$100 USD / month</span>. Your account stays locked
        until the month is paid (Trybit crypto invoice). Postback unlocks ~30 days of access.
      </p>
      {status && (
        <p>
          Status:{' '}
          <strong>{status.active ? 'Active' : 'Locked'}</strong>
          {status.current_period_end && (
            <> · period ends {new Date(status.current_period_end).toLocaleString()}</>
          )}
        </p>
      )}
      {error && <div className="order-hub-error">{error}</div>}
      {devUnlockNote && <p className="order-hub-meta">{devUnlockNote}</p>}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
        <button
          type="button"
          className="order-hub-btn order-hub-btn-primary"
          disabled={busy || status?.active}
          onClick={pay}
        >
          {busy ? 'Creating invoice…' : status?.active ? 'Already active' : 'Pay $100 with Trybit'}
        </button>
        <button type="button" className="order-hub-btn" onClick={refresh}>
          Refresh status
        </button>
        {status?.active && (
          <Link href="/hub" className="order-hub-btn">
            Go to Order Hub
          </Link>
        )}
      </div>
    </div>
  );
}
