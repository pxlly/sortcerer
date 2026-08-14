'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseMasterReferenceCsv } from '@/lib/parseMasterReferenceCsv';
import { parseCatalogInventoryText } from '@/lib/parseCatalogPdf';

type Row = {
  id?: string;
  asin: string;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
};

export default function SettingsMasterRef() {
  const [rows, setRows] = useState<Row[]>([]);
  const [storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [keepaBusy, setKeepaBusy] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/master-reference');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setRows(json.rows || []);

      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from('profiles')
          .select('store_name')
          .eq('user_id', user.id)
          .maybeSingle();
        setStoreName(data?.store_name || '');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveStore = async () => {
    const { createClient } = await import('@/lib/supabase/client');
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error: err } = await supabase.from('profiles').upsert({
      user_id: user.id,
      store_name: storeName.trim() || null,
    });
    if (err) setError(err.message);
    else showToast('Store name saved (one Amazon store per account).');
  };

  const upsertRows = async (incoming: Row[]) => {
    const res = await fetch('/api/master-reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: incoming }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upsert failed');
    await load();
    return {
      upserted: json.upserted as number,
      duplicatesCollapsed: (json.duplicatesCollapsed as number) || 0,
    };
  };

  const importCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = parseMasterReferenceCsv(String(reader.result));
        const mapped: Row[] = result.rows
          .filter((r) => r.asin)
          .map((r) => ({
            asin: r.asin!,
            sku: r.sku,
            weight_lb: r.weight,
            max_qty_per_box: r.maxQtyPerBox,
            product_name: r.productName ?? null,
          }));
        if (mapped.length === 0) {
          showToast('No rows with ASIN. ASIN is required (unique per account).');
          return;
        }
        const { upserted: n, duplicatesCollapsed } = await upsertRows(mapped);
        showToast(
          `Imported ${n} rows.${duplicatesCollapsed ? ` Collapsed ${duplicatesCollapsed} duplicate ASIN(s).` : ''}${result.rejected.length ? ` ${result.rejected.length} rejected.` : ''}`
        );
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Import failed');
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const importPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPdfBusy(true);
    setError(null);
    try {
      const pdfjs = await import('pdfjs-dist');
      // Use CDN worker matching installed pdfjs version
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      const buf = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ');
        text += pageText + '\n';
      }
      const parsed = parseCatalogInventoryText(text);
      if (parsed.length === 0) {
        showToast('No ASIN/SKU pairs found in PDF. Export Manage Inventory from Seller Central.');
        return;
      }
      const mapped: Row[] = parsed.map((r) => ({
        asin: r.asin,
        sku: r.sku,
        weight_lb: null,
        max_qty_per_box: null,
        product_name: r.productName || null,
      }));
      const { upserted: n, duplicatesCollapsed } = await upsertRows(mapped);
      showToast(
        `Catalog PDF: upserted ${n} SKUs.${duplicatesCollapsed ? ` Collapsed ${duplicatesCollapsed} duplicate ASIN(s).` : ''} Use Keepa enrich for missing weight/max.`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'PDF parse failed');
    } finally {
      setPdfBusy(false);
    }
  };

  const enrichMissing = async () => {
    const need = rows.filter((r) => r.weight_lb == null || r.max_qty_per_box == null).map((r) => r.asin);
    if (need.length === 0) {
      showToast('All rows already have weight and max qty.');
      return;
    }
    setKeepaBusy(true);
    try {
      const batch = need.slice(0, 20);
      const res = await fetch('/api/keepa/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asins: batch }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Keepa failed');
      const updates: Row[] = [];
      for (const result of json.results || []) {
        const existing = rows.find((r) => r.asin === result.asin);
        if (!existing) continue;
        if (result.weightLb == null && result.maxQtyPerBox == null) continue;
        updates.push({
          asin: existing.asin,
          sku: existing.sku,
          weight_lb: result.weightLb ?? existing.weight_lb,
          max_qty_per_box: result.maxQtyPerBox ?? existing.max_qty_per_box,
          product_name: result.productName || existing.product_name,
        });
      }
      if (updates.length === 0) {
        showToast('Keepa returned no usable dims/weight for this batch.');
        return;
      }
      const { upserted: n } = await upsertRows(updates);
      showToast(`Keepa enriched ${n} ASIN(s). ${need.length > 20 ? 'Run again for more.' : ''}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Keepa enrich failed');
    } finally {
      setKeepaBusy(false);
    }
  };

  const exportCsv = () => {
    const header = 'ASIN,SKU,WEIGHT,MAX QTY PER BOX,PRODUCT NAME';
    const body = rows.map((r) =>
      [r.asin, r.sku, r.weight_lb ?? '', r.max_qty_per_box ?? '', r.product_name ?? '']
        .map((v) => (String(v).includes(',') ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(',')
    );
    const blob = new Blob([[header, ...body].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'master-reference.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveEdit = async (row: Row) => {
    try {
      await upsertRows([row]);
      showToast('Saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const remove = async (asin: string) => {
    const res = await fetch(`/api/master-reference?asin=${encodeURIComponent(asin)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const json = await res.json();
      setError(json.error || 'Delete failed');
      return;
    }
    await load();
  };

  return (
    <div className="settings-page">
      <h1 className="order-hub-title">Settings</h1>
      <p className="order-hub-min-orders-desc">
        Master reference lives here (hidden from Order Hub). One Amazon store per account; ASIN is
        unique per user.
      </p>
      {toast && (
        <div className="order-hub-toast" role="alert">
          {toast}
        </div>
      )}
      {error && <div className="order-hub-error">{error}</div>}

      <section className="order-hub-section">
        <h3>Amazon store</h3>
        <div className="order-hub-form-row">
          <label>
            Store name (optional)
            <input value={storeName} onChange={(e) => setStoreName(e.target.value)} />
          </label>
        </div>
        <button type="button" className="order-hub-btn order-hub-btn-primary" onClick={saveStore}>
          Save store
        </button>
      </section>

      <section className="order-hub-section">
        <h3>Master reference</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <input ref={csvRef} type="file" accept=".csv" onChange={importCsv} style={{ display: 'none' }} />
          <input ref={pdfRef} type="file" accept="application/pdf" onChange={importPdf} style={{ display: 'none' }} />
          <button type="button" className="order-hub-btn" onClick={() => csvRef.current?.click()}>
            Import CSV
          </button>
          <button
            type="button"
            className="order-hub-btn"
            disabled={pdfBusy}
            onClick={() => pdfRef.current?.click()}
          >
            {pdfBusy ? 'Parsing PDF…' : 'Import catalog PDF'}
          </button>
          <button type="button" className="order-hub-btn" onClick={exportCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
          <button
            type="button"
            className="order-hub-btn order-hub-btn-primary"
            disabled={keepaBusy}
            onClick={enrichMissing}
          >
            {keepaBusy ? 'Enriching…' : 'Keepa enrich missing'}
          </button>
        </div>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>ASIN</th>
                  <th>Weight</th>
                  <th>Max/box</th>
                  <th>Product</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <EditableRow key={r.asin} row={r} onSave={saveEdit} onDelete={remove} />
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="order-hub-meta">No entries yet. Import a CSV or Seller Central inventory PDF.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function EditableRow({
  row,
  onSave,
  onDelete,
}: {
  row: Row;
  onSave: (r: Row) => void;
  onDelete: (asin: string) => void;
}) {
  const [draft, setDraft] = useState(row);
  useEffect(() => setDraft(row), [row]);

  return (
    <tr>
      <td>
        <input
          value={draft.sku}
          onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))}
        />
      </td>
      <td>{draft.asin}</td>
      <td>
        <input
          type="number"
          value={draft.weight_lb ?? ''}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              weight_lb: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        />
      </td>
      <td>
        <input
          type="number"
          value={draft.max_qty_per_box ?? ''}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              max_qty_per_box: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
        />
      </td>
      <td>
        <input
          value={draft.product_name ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, product_name: e.target.value }))}
        />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" className="order-hub-btn" onClick={() => onSave(draft)}>
          Save
        </button>{' '}
        <button type="button" className="order-hub-btn" onClick={() => onDelete(row.asin)}>
          Del
        </button>
      </td>
    </tr>
  );
}
