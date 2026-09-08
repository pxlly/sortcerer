'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  USPS_BULK_CHUNK_SIZE,
  buildUspsBulkTrackingUrl,
  chunkTrackingNumbers,
} from '@/lib/uspsBulkTracking';
import type { TrackingNumberRow } from '@/app/api/tracking-numbers/route';
import './TrackingPage.css';

function formatWhen(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function TrackingPage() {
  const [rows, setRows] = useState<TrackingNumberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tracking-numbers');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to load tracking numbers');
        setRows([]);
        return;
      }
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setError('Failed to load tracking numbers');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chunks = chunkTrackingNumbers(rows, USPS_BULK_CHUNK_SIZE);

  return (
    <div className="tracking-page">
      <h1 className="tracking-page-title">Tracking</h1>
      <p className="tracking-page-desc">
        Tracking numbers saved from Order Hub uploads. Newest first. After every{' '}
        {USPS_BULK_CHUNK_SIZE} numbers, open a USPS bulk tracking link for that chunk.
      </p>
      <p className="tracking-page-hint">
        Upload tracking files in <Link href="/hub">Order Hub</Link> (Step 2/3) to add more.
      </p>

      {loading && <p className="tracking-page-meta">Loading…</p>}
      {error && <div className="tracking-page-error">{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div className="tracking-page-empty">
          No tracking numbers yet. Generate a CSV in Order Hub, then upload the tracking .txt file.
        </div>
      )}

      {!loading && chunks.length > 0 && (
        <div className="tracking-page-list">
          {chunks.map((chunk, chunkIndex) => {
            const numbers = chunk.map((r) => r.tracking_number);
            const uspsUrl = buildUspsBulkTrackingUrl(numbers);
            const start = chunkIndex * USPS_BULK_CHUNK_SIZE + 1;
            const end = start + chunk.length - 1;
            return (
              <section key={`chunk-${chunkIndex}`} className="tracking-chunk">
                <ol className="tracking-ol" start={start}>
                  {chunk.map((row) => (
                    <li key={row.id ?? row.tracking_number} className="tracking-row">
                      <span className="tracking-tn">{row.tracking_number}</span>
                      {row.recipient_name ? (
                        <span className="tracking-name">{row.recipient_name}</span>
                      ) : null}
                      <span className="tracking-when">{formatWhen(row.uploaded_at)}</span>
                    </li>
                  ))}
                </ol>
                <a
                  className="tracking-usps-link"
                  href={uspsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  USPS track these {chunk.length}
                  {chunk.length === USPS_BULK_CHUNK_SIZE ? '' : ` (${start}–${end})`}
                </a>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
