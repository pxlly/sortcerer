'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  USPS_BULK_CHUNK_SIZE,
  buildUspsBulkTrackingUrl,
  chunkTrackingNumbers,
} from '@/lib/uspsBulkTracking';
import type { TrackingBatchGroup } from '@/lib/trackingBatches';
import './TrackingPage.css';

function formatWhen(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Open every USPS chunk link synchronously from the click handler so browsers count them as user-initiated. */
function openAll(urls: string[]): number {
  let opened = 0;
  for (const url of urls) {
    // No `noopener` feature here: it makes window.open return null even on success,
    // which would defeat the pop-up-blocked detection. Sever the opener manually instead.
    const win = window.open(url, '_blank');
    if (win) {
      try {
        win.opener = null;
      } catch {
        // Cross-origin window; ignore.
      }
      opened += 1;
    }
  }
  return opened;
}

async function fetchBatches(): Promise<{ batches: TrackingBatchGroup[]; error: string | null }> {
  try {
    const res = await fetch('/api/tracking-numbers');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { batches: [], error: data.error || 'Failed to load tracking numbers' };
    }
    return { batches: Array.isArray(data.batches) ? data.batches : [], error: null };
  } catch {
    return { batches: [], error: 'Failed to load tracking numbers' };
  }
}

type BatchRowProps = {
  batch: TrackingBatchGroup;
  onDelete: (batch: TrackingBatchGroup) => Promise<void>;
};

function BatchRow({ batch, onDelete }: BatchRowProps) {
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const numbers = batch.rows.map((r) => r.tracking_number);
  const chunks = chunkTrackingNumbers(numbers, USPS_BULK_CHUNK_SIZE);
  const urls = chunks.map((c) => buildUspsBulkTrackingUrl(c));
  const count = numbers.length;

  const handleTrack = () => {
    if (urls.length === 0) return;
    const opened = openAll(urls);
    if (opened < urls.length) {
      setNote(
        `Opened ${opened} of ${urls.length} tabs. Allow pop-ups for this site, or use the chunk links below.`
      );
    } else {
      setNote(null);
    }
  };

  const handleDelete = async () => {
    const what = batch.legacy ? 'all earlier (ungrouped) tracking numbers' : 'this batch';
    if (!window.confirm(`Delete ${what} (${count} tracking number(s))? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      await onDelete(batch);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="tracking-batch">
      <div className="tracking-batch-head">
        <div className="tracking-batch-info">
          <div className="tracking-batch-title">
            {batch.legacy ? 'Earlier uploads' : formatWhen(batch.created_at)}
          </div>
          <div className="tracking-batch-meta">
            {batch.legacy ? (
              <span>Saved before batches existed · latest {formatWhen(batch.created_at)}</span>
            ) : (
              <span>{batch.label || 'Order Hub upload'}</span>
            )}
            <span className="tracking-batch-count">
              {count} tracking number{count === 1 ? '' : 's'} · {urls.length} USPS tab
              {urls.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="tracking-batch-actions">
          <button
            type="button"
            className="tracking-usps-link tracking-track-btn"
            onClick={handleTrack}
            disabled={count === 0}
            title={`Open ${urls.length} USPS tracking tab(s), ${USPS_BULK_CHUNK_SIZE} numbers each`}
          >
            Track {count} on USPS
          </button>
          <button
            type="button"
            className="tracking-delete-btn"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
      <p className="tracking-popup-note">
        {note ?? 'Allow pop-ups for this site if only one tab opens.'}
      </p>

      <details className="tracking-details">
        <summary>Links &amp; numbers</summary>
        <ul className="tracking-chunk-links">
          {urls.map((url, i) => {
            const start = i * USPS_BULK_CHUNK_SIZE + 1;
            const end = start + chunks[i].length - 1;
            return (
              <li key={url}>
                <a
                  className="tracking-usps-link tracking-chunk-link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Chunk {i + 1}/{urls.length} · {chunks[i].length} numbers ({start}–{end})
                </a>
              </li>
            );
          })}
        </ul>
        <ol className="tracking-ol">
          {batch.rows.map((row) => (
            <li key={row.id ?? row.tracking_number} className="tracking-row">
              <span className="tracking-tn">{row.tracking_number}</span>
              {row.recipient_name ? (
                <span className="tracking-name">{row.recipient_name}</span>
              ) : (
                <span />
              )}
              <span className="tracking-when">{formatWhen(row.created_at)}</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

export default function TrackingPage() {
  const [batches, setBatches] = useState<TrackingBatchGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBatches().then((result) => {
      if (cancelled) return;
      setError(result.error);
      setBatches(result.batches);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const deleteBatch = useCallback(
    async (batch: TrackingBatchGroup) => {
      setError(null);
      try {
        const res = await fetch(
          `/api/tracking-numbers?batch_id=${encodeURIComponent(batch.id)}`,
          { method: 'DELETE' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || 'Failed to delete batch');
          return;
        }
        setBatches((prev) => prev.filter((b) => b.id !== batch.id));
      } catch {
        setError('Failed to delete batch');
      }
    },
    []
  );

  const totalNumbers = batches.reduce((sum, b) => sum + b.rows.length, 0);

  return (
    <div className="tracking-page">
      <h1 className="tracking-page-title">Tracking</h1>
      <p className="tracking-page-desc">
        One row per Order Hub workflow session, newest first. <strong>Track</strong> opens USPS
        bulk tracking in tabs of {USPS_BULK_CHUNK_SIZE} numbers each (an order with 100 labels
        opens 3 tabs).
      </p>
      <p className="tracking-page-hint">
        Upload tracking files in <Link href="/hub">Order Hub</Link> (Step 2/3) to add more.
      </p>

      {loading && <p className="tracking-page-meta">Loading…</p>}
      {error && <div className="tracking-page-error">{error}</div>}

      {!loading && !error && batches.length === 0 && (
        <div className="tracking-page-empty">
          No tracking numbers yet. Generate a CSV in Order Hub, then upload the tracking .txt file.
        </div>
      )}

      {!loading && batches.length > 0 && (
        <>
          <p className="tracking-page-meta">
            {batches.length} session{batches.length === 1 ? '' : 's'} · {totalNumbers} tracking
            number{totalNumbers === 1 ? '' : 's'}
          </p>
          <div className="tracking-page-list">
            {batches.map((batch) => (
              <BatchRow key={batch.id} batch={batch} onDelete={deleteBatch} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
