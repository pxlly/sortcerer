'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type SubStatus = {
  active: boolean;
  admin?: boolean;
  status: string;
  setup_paid?: boolean;
  next_amount_usd?: number;
  setup_fee_usd?: number;
  monthly_usd?: number;
  current_period_end: string | null;
  configured: boolean;
};

export default function BillingPage() {
  const [status, setStatus] = useState<SubStatus | null>(null);
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

  const setupFee = status?.setup_fee_usd ?? 300;
  const monthly = status?.monthly_usd ?? 175;
  const setupPaid = Boolean(status?.setup_paid);
  const nextAmount = status?.next_amount_usd ?? (setupPaid ? monthly : setupFee);
  const payLabel = setupPaid
    ? `Renew $${monthly} with Trybit`
    : `Pay setup $${setupFee} with Trybit`;

  return (
    <div className="billing-card">
      <h1>Billing</h1>
      <p className="order-hub-min-orders-desc">
        <span className="billing-price">Setup ${setupFee}</span> (one-time, first payment), then{' '}
        <span className="billing-price">Renew ${monthly}/mo</span>. Your account stays locked until
        paid (Trybit crypto invoice). Postback unlocks ~30 days of access.
      </p>
      {status && !status.admin && (
        <p className="order-hub-meta">
          Next invoice:{' '}
          <strong>
            {setupPaid ? `Renew $${nextAmount}` : `Setup $${nextAmount}`}
          </strong>
        </p>
      )}
      {status && (
        <p>
          Status:{' '}
          <strong>
            {status.admin
              ? 'Admin / complimentary access'
              : status.active
                ? 'Active'
                : 'Locked'}
          </strong>
          {!status.admin && status.current_period_end && (
            <> · period ends {new Date(status.current_period_end).toLocaleString()}</>
          )}
        </p>
      )}
      {error && <div className="order-hub-error">{error}</div>}
      {devUnlockNote && <p className="order-hub-meta">{devUnlockNote}</p>}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
        {status?.admin ? (
          <span className="order-hub-meta" style={{ alignSelf: 'center' }}>
            Admin / complimentary access — no payment required
          </span>
        ) : (
          <button
            type="button"
            className="order-hub-btn order-hub-btn-primary"
            disabled={busy || status?.active}
            onClick={pay}
          >
            {busy ? 'Creating invoice…' : status?.active ? 'Already active' : payLabel}
          </button>
        )}
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
