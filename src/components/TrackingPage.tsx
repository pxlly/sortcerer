'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
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

function batchTitle(batch: TrackingBatchGroup): string {
  return batch.legacy ? 'Earlier uploads' : formatWhen(batch.created_at);
}

type DeleteBatchModalProps = {
  batch: TrackingBatchGroup;
  onCancel: () => void;
  /** Resolves to an error message on failure, or null on success. */
  onConfirm: (batch: TrackingBatchGroup) => Promise<string | null>;
};

/**
 * Two-step confirmation for deleting a batch. Mounted only while open, so the
 * checkbox/error state is fresh each time. Cancel is deliberately the prominent,
 * auto-focused action; the destructive button stays low-emphasis and locked until
 * both acknowledgements are checked.
 */
function DeleteBatchModal({ batch, onCancel, onConfirm }: DeleteBatchModalProps) {
  const [ackDelete, setAckDelete] = useState(false);
  const [ackIrreversible, setAckIrreversible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;
  const ackDeleteId = `${uid}-ack-delete`;
  const ackIrreversibleId = `${uid}-ack-irreversible`;

  const count = batch.rows.length;
  const canConfirm = ackDelete && ackIrreversible && !deleting;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [deleting, onCancel]);

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setDeleting(true);
    setError(null);
    try {
      const err = await onConfirm(batch);
      if (err) {
        setError(err);
        setDeleting(false);
      }
      // On success the parent unmounts this modal; no state update needed.
    } catch {
      setError('Failed to delete tracking history');
      setDeleting(false);
    }
  };

  return (
    <div
      className="order-hub-modal-overlay tracking-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !deleting) onCancel();
      }}
    >
      <div
        className="order-hub-modal tracking-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <h4 id={titleId} className="tracking-modal-title">
          Are you sure you want to delete this tracking history?
        </h4>
        <p id={descId} className="tracking-modal-subject">
          {batchTitle(batch)} — {count} label{count === 1 ? '' : 's'}
          {!batch.legacy && batch.label ? ` · ${batch.label}` : ''}
        </p>

        <div className="tracking-modal-checks">
          <label className="tracking-modal-check" htmlFor={ackDeleteId}>
            <input
              id={ackDeleteId}
              type="checkbox"
              checked={ackDelete}
              disabled={deleting}
              onChange={(e) => setAckDelete(e.target.checked)}
            />
            <span>Yes, delete this tracking history</span>
          </label>
          <label className="tracking-modal-check" htmlFor={ackIrreversibleId}>
            <input
              id={ackIrreversibleId}
              type="checkbox"
              checked={ackIrreversible}
              disabled={deleting}
              onChange={(e) => setAckIrreversible(e.target.checked)}
            />
            <span>I understand that this action cannot be reversed</span>
          </label>
        </div>

        {error && (
          <div className="order-hub-error tracking-modal-error" role="alert">
            {error}
          </div>
        )}

        <div className="form-actions tracking-modal-actions">
          <button
            type="button"
            className="order-hub-btn tracking-modal-confirm-btn"
            disabled={!canConfirm}
            onClick={() => void handleConfirm()}
          >
            {deleting ? 'Deleting…' : 'Confirm delete'}
          </button>
          <button
            type="button"
            className="order-hub-btn order-hub-btn-primary tracking-modal-cancel-btn"
            autoFocus
            disabled={deleting}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

type BatchRowProps = {
  batch: TrackingBatchGroup;
  onRequestDelete: (batch: TrackingBatchGroup) => void;
};

function BatchRow({ batch, onRequestDelete }: BatchRowProps) {
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

  return (
    <section className="tracking-batch">
      <div className="tracking-batch-head">
        <div className="tracking-batch-info">
          <div className="tracking-batch-title">{batchTitle(batch)}</div>
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
            onClick={() => onRequestDelete(batch)}
          >
            Delete
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
  const [pendingDelete, setPendingDelete] = useState<TrackingBatchGroup | null>(null);

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

  const deleteBatch = useCallback(async (batch: TrackingBatchGroup): Promise<string | null> => {
    try {
      const res = await fetch(`/api/tracking-numbers?batch_id=${encodeURIComponent(batch.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return data.error || 'Failed to delete tracking history';
      }
      setBatches((prev) => prev.filter((b) => b.id !== batch.id));
      setPendingDelete(null);
      return null;
    } catch {
      return 'Failed to delete tracking history';
    }
  }, []);

  const closeDeleteModal = useCallback(() => setPendingDelete(null), []);

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
              <BatchRow key={batch.id} batch={batch} onRequestDelete={setPendingDelete} />
            ))}
          </div>
        </>
      )}

      {pendingDelete && (
        <DeleteBatchModal
          key={pendingDelete.id}
          batch={pendingDelete}
          onCancel={closeDeleteModal}
          onConfirm={deleteBatch}
        />
      )}
    </div>
  );
}
