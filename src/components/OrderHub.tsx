'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  parseUnshippedTxt,
  expandOrderToCsvLines,
  sortCsvRows,
  csvRowsToCsvString,
  generateMultiUnitReportTxt,
  buildTrackingNumbersCsv,
  sanitizeFilename,
  selectPdfEntriesForCombine,
  type ParsedOrderRow,
  type CsvOutputRow,
  type MasterRefEntry,
} from '@/lib/orderHub/orderHubUtils';
import {
  getDefaultFromAddress,
  setDefaultFromAddress,
  validateFromAddress,
  type DefaultFromAddress,
} from '@/lib/shippingStorage';
import { normalizeState, normalizeZip } from '@/lib/addressNormalize';
import { capMaxQtyByWeight } from '@/lib/packing';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import './OrderHub.css';

const BULK_CONFIRM_BASE = 'https://sellercentral.amazon.com/orders-v3/bulk-confirm-shipment';
const BULK_CONFIRM_CHUNK_SIZE = 50;

/** Smaller than WeShop (20/23) so long product titles fit on label header pages. */
const HEADER_FONT_SIZE = 13;
const HEADER_MARGIN = 28;

type MeasurableFont = { widthOfTextAtSize: (text: string, size: number) => number };

/**
 * Wrap header text on word boundaries using real font metrics. Words longer than
 * a full line are split by character as a last resort.
 */
function wrapTextToWidth(
  text: string,
  font: MeasurableFont,
  fontSize: number,
  maxWidth: number
): string[] {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];

  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, fontSize) <= maxWidth;

  const splitLongWord = (word: string): string[] => {
    const parts: string[] = [];
    let current = '';
    for (const char of word) {
      if (current && !fits(current + char)) {
        parts.push(current);
        current = char;
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);
    return parts;
  };

  const lines: string[] = [];
  let line = '';

  for (const word of normalized.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (fits(word)) {
      line = word;
      continue;
    }
    const chunks = splitLongWord(word);
    lines.push(...chunks.slice(0, -1));
    line = chunks[chunks.length - 1] ?? '';
  }

  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function getUniqueOrderIds(rows: ParsedOrderRow[]): string[] {
  const ids: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const row of rows) {
    const id = row.orderId;
    if (id && !seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
  }
  return ids;
}

function filterByMinOrders(
  rows: ParsedOrderRow[],
  minOrders: number
): { filtered: ParsedOrderRow[]; omittedCount: number } {
  if (minOrders <= 0) return { filtered: rows, omittedCount: 0 };
  const countBySku: Record<string, number> = {};
  for (const r of rows) {
    const sku = r.sku.trim();
    countBySku[sku] = (countBySku[sku] || 0) + 1;
  }
  const filtered = rows.filter((o) => (countBySku[o.sku.trim()] || 0) >= minOrders);
  return { filtered, omittedCount: rows.length - filtered.length };
}

function dbRowToEntry(r: {
  asin: string;
  sku: string;
  weight_lb: number | null;
  max_qty_per_box: number | null;
  product_name: string | null;
}): MasterRefEntry | null {
  if (r.weight_lb == null || r.max_qty_per_box == null) return null;
  return {
    sku: r.sku,
    asin: r.asin,
    weight: Number(r.weight_lb),
    maxQtyPerBox: capMaxQtyByWeight(Number(r.max_qty_per_box), Number(r.weight_lb)),
    productName: r.product_name ?? undefined,
  };
}

async function persistMasterEntry(entry: MasterRefEntry) {
  if (!entry.asin) return;
  await fetch('/api/master-reference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: [
        {
          asin: entry.asin,
          sku: entry.sku,
          weight_lb: entry.weight,
          max_qty_per_box: entry.maxQtyPerBox,
          product_name: entry.productName ?? null,
        },
      ],
    }),
  });
}

export default function OrderHub() {
  const [fromAddress, setFromAddress] = useState({
    fromName: '',
    fromStreet1: '',
    fromStreet2: '',
    fromCity: '',
    fromState: '',
    fromZip: '',
  });
  const [fromSaved, setFromSaved] = useState(false);
  const [masterRef, setMasterRef] = useState<MasterRefEntry[]>([]);
  const [asinBySku, setAsinBySku] = useState<Record<string, string>>({});
  const [loadingRef, setLoadingRef] = useState(true);
  const [csvRows, setCsvRows] = useState<CsvOutputRow[] | null>(null);
  const [convertSummary, setConvertSummary] = useState<{
    orders: number;
    boxes: number;
    unknownResolved: number;
    ordersFilteredOut?: number;
  } | null>(null);
  const [minOrdersFilter, setMinOrdersFilter] = useState(0);
  const [fileOrderOnly, setFileOrderOnly] = useState(false);
  const [combineIntoOnePdf, setCombineIntoOnePdf] = useState(false);
  const [missingSkuModal, setMissingSkuModal] = useState<{
    sku: string;
    productName: string;
    asin?: string;
    order: ParsedOrderRow;
    resolve: (ref: MasterRefEntry) => void;
    keepaTried?: boolean;
    keepaMsg?: string;
  } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [combineZipError, setCombineZipError] = useState<string | null>(null);
  const [trackingTxtError, setTrackingTxtError] = useState<string | null>(null);
  const [pdfProcessing, setPdfProcessing] = useState(false);
  const [combineZipProcessing, setCombineZipProcessing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [highQtyConfirmModal, setHighQtyConfirmModal] = useState<Array<{
    sku: string;
    productName: string;
    qty: number;
  }> | null>(null);
  const [bulkConfirmOrderIds, setBulkConfirmOrderIds] = useState<string[] | null>(null);
  const unshippedFileRef = useRef<HTMLInputElement>(null);
  const labelsPdfRef = useRef<HTMLInputElement>(null);
  const labelsZipRef = useRef<HTMLInputElement>(null);
  const trackingTxtRef = useRef<HTMLInputElement>(null);
  const pendingConversionOrderRowsRef = useRef<ParsedOrderRow[] | null>(null);
  const pendingConversionOmittedRef = useRef<number>(0);
  const masterRefRef = useRef(masterRef);
  masterRefRef.current = masterRef;

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    const { data, valid } = getDefaultFromAddress();
    setFromAddress(data);
    if (!valid) showToast('Saved address was invalid; form reset.');
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingRef(true);
      try {
        const res = await fetch('/api/master-reference');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load master reference');
        const entries: MasterRefEntry[] = [];
        const map: Record<string, string> = {};
        for (const r of json.rows || []) {
          map[r.sku.trim()] = r.asin;
          const e = dbRowToEntry(r);
          if (e) entries.push(e);
        }
        if (!cancelled) {
          setMasterRef(entries);
          setAsinBySku(map);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setApiError(err instanceof Error ? err.message : 'Failed to load master reference');
        }
      } finally {
        if (!cancelled) setLoadingRef(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveFromAddress = () => {
    setApiError(null);
    const data: DefaultFromAddress = {
      fromName: fromAddress.fromName.trim(),
      fromStreet1: fromAddress.fromStreet1.trim(),
      fromStreet2: fromAddress.fromStreet2.trim(),
      fromCity: fromAddress.fromCity.trim(),
      fromState: normalizeState(fromAddress.fromState),
      fromZip: normalizeZip(fromAddress.fromZip),
    };
    const { valid } = validateFromAddress(data);
    if (!valid) {
      setApiError('Invalid address data.');
      return;
    }
    setDefaultFromAddress(data);
    setFromAddress(data);
    setFromSaved(true);
    showToast('From address saved.');
    setTimeout(() => setFromSaved(false), 2000);
  };

  const refBySku = useCallback((): Record<string, MasterRefEntry> => {
    const out: Record<string, MasterRefEntry> = {};
    masterRefRef.current.forEach((r) => {
      out[r.sku.trim()] = r;
    });
    return out;
  }, []);

  const addToMasterRef = useCallback((entry: MasterRefEntry) => {
    setMasterRef((prev) => {
      const next = prev.filter((e) => e.sku !== entry.sku);
      next.push(entry);
      next.sort((a, b) => a.sku.localeCompare(b.sku));
      return next;
    });
    if (entry.asin) {
      setAsinBySku((p) => ({ ...p, [entry.sku.trim()]: entry.asin! }));
    }
    void persistMasterEntry(entry);
  }, []);

  const tryKeepaEnrich = async (
    sku: string,
    productName: string,
    asinHint?: string
  ): Promise<MasterRefEntry | null> => {
    const asin = (asinHint || asinBySku[sku.trim()] || '').trim().toUpperCase();
    if (!asin) return null;
    try {
      const res = await fetch('/api/keepa/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asins: [asin] }),
      });
      const json = await res.json();
      const result = json.results?.[0];
      if (!result || result.error) {
        return null;
      }
      if (result.weightLb == null || result.maxQtyPerBox == null) {
        return null;
      }
      return {
        sku,
        asin,
        weight: result.weightLb,
        maxQtyPerBox: result.maxQtyPerBox,
        productName: result.productName || productName,
      };
    } catch {
      return null;
    }
  };

  const runConversion = useCallback(
    (orderRows: ParsedOrderRow[]) => {
      const refMap = refBySku();
      const from = {
        fromName: fromAddress.fromName.trim(),
        fromAddress1: fromAddress.fromStreet1.trim(),
        fromAddress2: fromAddress.fromStreet2.trim(),
        fromCity: fromAddress.fromCity.trim(),
        fromState: normalizeState(fromAddress.fromState),
        fromZip: normalizeZip(fromAddress.fromZip),
      };

      let allLines: CsvOutputRow[] = [];
      let unknownResolved = 0;
      let index = 0;

      const finish = () => {
        const uniqueOrderIds = getUniqueOrderIds(orderRows);
        const omitted = pendingConversionOmittedRef.current;
        setCsvRows(fileOrderOnly ? allLines : sortCsvRows(allLines));
        setConvertSummary({
          orders: orderRows.length,
          boxes: allLines.length,
          unknownResolved,
          ...(omitted > 0 ? { ordersFilteredOut: omitted } : {}),
        });
        setBulkConfirmOrderIds(uniqueOrderIds.length > 0 ? uniqueOrderIds : null);
      };

      const processNext = async () => {
        if (index >= orderRows.length) {
          finish();
          return;
        }
        const order = orderRows[index];
        let ref = refMap[order.sku.trim()];

        if (!ref || !ref.weight || !ref.maxQtyPerBox) {
          const asin = asinBySku[order.sku.trim()];
          const enriched = await tryKeepaEnrich(order.sku, order.productName, asin);
          if (enriched) {
            refMap[enriched.sku.trim()] = enriched;
            addToMasterRef(enriched);
            unknownResolved++;
            allLines = allLines.concat(expandOrderToCsvLines(order, enriched, from));
            index++;
            processNext();
            return;
          }

          setMissingSkuModal({
            sku: order.sku,
            productName: order.productName,
            asin,
            order,
            keepaTried: Boolean(asin),
            keepaMsg: asin
              ? 'Keepa could not fill weight/max qty (missing dims or API). Enter manually.'
              : 'No ASIN on file for this SKU. Add ASIN in Settings or enter weight/max manually.',
            resolve: (newRef) => {
              refMap[newRef.sku.trim()] = newRef;
              addToMasterRef(newRef);
              unknownResolved++;
              allLines = allLines.concat(expandOrderToCsvLines(order, newRef, from));
              index++;
              setMissingSkuModal(null);
              processNext();
            },
          });
          return;
        }

        allLines = allLines.concat(expandOrderToCsvLines(order, ref, from));
        index++;
        processNext();
      };

      void processNext();
    },
    [fromAddress, refBySku, addToMasterRef, fileOrderOnly, asinBySku]
  );

  const handleUnshippedFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setParseError(null);
    setCsvRows(null);
    setConvertSummary(null);
    setBulkConfirmOrderIds(null);
    if (!file) return;
    const text = await file.text();
    const { rows: orderRows, missingColumns } = parseUnshippedTxt(text);
    if (missingColumns.length > 0) {
      setParseError(`Missing required columns: ${missingColumns.join(', ')}`);
      return;
    }
    if (orderRows.length === 0) {
      setParseError('No valid order rows found.');
      return;
    }

    const { filtered: orderRowsToConvert, omittedCount } = filterByMinOrders(
      orderRows,
      minOrdersFilter
    );
    pendingConversionOmittedRef.current = omittedCount;

    if (orderRowsToConvert.length === 0) {
      setParseError(
        `No orders left after filtering. All products have fewer than ${minOrdersFilter} order(s).`
      );
      return;
    }

    const highQtyOrders = orderRowsToConvert.filter((o) => o.qty > 4);
    if (highQtyOrders.length > 0) {
      setHighQtyConfirmModal(
        highQtyOrders.map((o) => ({ sku: o.sku, productName: o.productName, qty: o.qty }))
      );
      pendingConversionOrderRowsRef.current = orderRowsToConvert;
      return;
    }

    runConversion(orderRowsToConvert);
  };

  const downloadCsv = () => {
    if (!csvRows || csvRows.length === 0) return;
    const csv = csvRowsToCsvString(csvRows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileOrderOnly ? 'sortcerer-file-order-' : 'sortcerer-'}${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLabelsPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setPdfError(null);
    setPdfProcessing(true);
    if (!file || !csvRows?.length) {
      setPdfError('Generate and download CSV first, then upload the labels PDF.');
      setPdfProcessing(false);
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const pdf = await PDFDocument.load(buf);
      const pageCount = pdf.getPageCount();
      if (pageCount !== csvRows.length) {
        setPdfError(
          `PDF has ${pageCount} pages but CSV has ${csvRows.length} rows. They must match.`
        );
        setPdfProcessing(false);
        return;
      }
      const productPdfs: Array<{ fileName: string; pdfBytes: Uint8Array }> = [];
      const bySku: Record<string, { pageIndices: number[]; hasMultiUnit: boolean }> = {};
      csvRows.forEach((row, idx) => {
        const key = row.sku.trim();
        if (!bySku[key]) bySku[key] = { pageIndices: [], hasMultiUnit: false };
        bySku[key].pageIndices.push(idx);
        if (row.unitsInThisBox > 1) bySku[key].hasMultiUnit = true;
      });
      const usedZipNames = new Set<string>();
      for (const sku of Object.keys(bySku).sort()) {
        const { pageIndices, hasMultiUnit } = bySku[sku];
        const productName = csvRows[pageIndices[0]].productName || sku;
        const newPdf = await PDFDocument.create();
        const sourcePage = pdf.getPage(pageIndices[0]);
        const { width, height } = sourcePage.getSize();

        const headerPage = newPdf.addPage([width, height]);
        const bold = await newPdf.embedFont(StandardFonts.HelveticaBold);
        const regular = await newPdf.embedFont(StandardFonts.Helvetica);
        const fontSize = HEADER_FONT_SIZE;
        const lineHeight = fontSize + 3;
        const left = HEADER_MARGIN;
        const maxTextWidth = width - left * 2;
        let y = height - 48;
        for (const line of wrapTextToWidth(`Product: ${productName}`, bold, fontSize, maxTextWidth)) {
          headerPage.drawText(line, { x: left, y, size: fontSize, font: bold, color: rgb(0, 0, 0) });
          y -= lineHeight;
        }
        y -= lineHeight;

        if (hasMultiUnit) {
          const byUnits: Record<number, string[]> = {};
          for (const i of pageIndices) {
            const row = csvRows[i];
            if (row.unitsInThisBox <= 1) continue;
            if (!byUnits[row.unitsInThisBox]) byUnits[row.unitsInThisBox] = [];
            byUnits[row.unitsInThisBox].push((row.toName || '').trim());
          }
          const units = Object.keys(byUnits)
            .map(Number)
            .sort((a, b) => b - a);
          const lines: string[] = [];
          for (const u of units) {
            lines.push(`${u} pack:`);
            for (const name of byUnits[u]) lines.push(name);
            lines.push('');
          }
          for (const rawLine of lines) {
            for (const line of wrapTextToWidth(rawLine, regular, fontSize, maxTextWidth)) {
              if (y < 28) break;
              if (line.length > 0) {
                headerPage.drawText(line, {
                  x: left,
                  y,
                  size: fontSize,
                  font: regular,
                  color: rgb(0, 0, 0),
                });
              }
              y -= lineHeight;
            }
            if (y < 28) break;
          }
          y -= lineHeight;
          for (const line of wrapTextToWidth(
            'The rest of the labels are 1 unit orders',
            regular,
            fontSize,
            maxTextWidth
          )) {
            if (y < 28) break;
            headerPage.drawText(line, {
              x: left,
              y,
              size: fontSize,
              font: regular,
              color: rgb(0, 0, 0),
            });
            y -= lineHeight;
          }
        } else {
          for (const line of wrapTextToWidth('Single-unit labels', regular, fontSize, maxTextWidth)) {
            headerPage.drawText(line, {
              x: left,
              y,
              size: fontSize,
              font: regular,
              color: rgb(0, 0, 0),
            });
            y -= lineHeight;
          }
        }

        for (const i of pageIndices) {
          const [copiedPage] = await newPdf.copyPages(pdf, [i]);
          newPdf.addPage(copiedPage);
        }
        const pdfBytes = await newPdf.save();
        const baseStem = sanitizeFilename(productName);
        let n = 0;
        let fileName: string;
        while (true) {
          const stem = n === 0 ? baseStem : sanitizeFilename(`${productName}-${n}`);
          fileName = hasMultiUnit ? `*${stem}.pdf` : `${stem}.pdf`;
          if (!usedZipNames.has(fileName)) break;
          n++;
        }
        usedZipNames.add(fileName);
        productPdfs.push({ fileName, pdfBytes });
      }

      if (combineIntoOnePdf) {
        const orderedNames = selectPdfEntriesForCombine(productPdfs.map((p) => p.fileName));
        const bytesByName = new Map(productPdfs.map((p) => [p.fileName, p.pdfBytes]));
        const combined = await PDFDocument.create();
        for (const name of orderedNames) {
          const bytes = bytesByName.get(name);
          if (!bytes) continue;
          const src = await PDFDocument.load(bytes);
          const pages = await combined.copyPages(src, src.getPageIndices());
          for (const page of pages) combined.addPage(page);
        }
        const outBytes = await combined.save();
        const blob = new Blob([Uint8Array.from(outBytes)], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sortcerer-combined-${new Date().toISOString().slice(0, 10)}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Downloaded combined PDF (${orderedNames.length} product file(s)).`);
      } else {
        const zip = new JSZip();
        for (const { fileName, pdfBytes } of productPdfs) {
          zip.file(fileName, Uint8Array.from(pdfBytes));
        }
        zip.file('multi-unit-report.txt', generateMultiUnitReportTxt(csvRows));
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sortcerer-labels-${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err: unknown) {
      setPdfError(err instanceof Error ? err.message : 'Failed to process PDF.');
    }
    setPdfProcessing(false);
  };

  const handleCombineLabelsZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setCombineZipError(null);
    if (!file) return;
    setCombineZipProcessing(true);
    try {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const entryNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
      const pdfPaths = selectPdfEntriesForCombine(entryNames);
      if (pdfPaths.length === 0) {
        setCombineZipError('No PDF files found in the ZIP.');
        setCombineZipProcessing(false);
        return;
      }
      const combined = await PDFDocument.create();
      for (const path of pdfPaths) {
        const bytes = await zip.files[path].async('uint8array');
        const src = await PDFDocument.load(bytes);
        const pages = await combined.copyPages(src, src.getPageIndices());
        for (const page of pages) combined.addPage(page);
      }
      const outBytes = await combined.save();
      const blob = new Blob([Uint8Array.from(outBytes)], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sortcerer-combined-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Combined ${pdfPaths.length} PDF(s) into one file.`);
    } catch (err: unknown) {
      setCombineZipError(err instanceof Error ? err.message : 'Failed to combine ZIP PDFs.');
    }
    setCombineZipProcessing(false);
  };

  const handleTrackingTxt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setTrackingTxtError(null);
    if (!file || !csvRows?.length) {
      setTrackingTxtError('Generate CSV first, then upload tracking numbers.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      const trackingNumbers = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (trackingNumbers.length !== csvRows.length) {
        setTrackingTxtError(
          `Tracking file has ${trackingNumbers.length} line(s) but CSV has ${csvRows.length} row(s).`
        );
        return;
      }
      const csv = buildTrackingNumbersCsv(csvRows, trackingNumbers);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sortcerer-tracking-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Tracking CSV downloaded.');
    };
    reader.readAsText(file, 'UTF-8');
  };

  return (
    <div className="order-hub-container">
      <h1 className="order-hub-title">Order Hub</h1>
      {loadingRef && <p className="order-hub-meta">Loading master reference…</p>}
      {apiError && <div className="order-hub-error">{apiError}</div>}
      {toast && (
        <div className="order-hub-toast" role="alert">
          {toast}
        </div>
      )}

      <section className="order-hub-section order-hub-min-orders-section">
        <h3>Minimum orders per product</h3>
        <p className="order-hub-min-orders-desc">
          Only include products with at least this many order lines. 0 = include all.
        </p>
        <div className="order-hub-form-row order-hub-min-orders-row">
          <label>
            <span className="order-hub-min-orders-label">Minimum order lines:</span>
            <input
              type="number"
              min={0}
              value={minOrdersFilter}
              onChange={(e) => setMinOrdersFilter(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="order-hub-min-orders-input"
            />
          </label>
        </div>
      </section>

      <section className="order-hub-section">
        <h3>Default From Address</h3>
        <div className="order-hub-form-row">
          <label>
            From Name
            <input
              value={fromAddress.fromName}
              onChange={(e) => setFromAddress((p) => ({ ...p, fromName: e.target.value }))}
            />
          </label>
        </div>
        <div className="order-hub-form-row">
          <label>
            Street 1
            <input
              value={fromAddress.fromStreet1}
              onChange={(e) => setFromAddress((p) => ({ ...p, fromStreet1: e.target.value }))}
            />
          </label>
          <label>
            Street 2
            <input
              value={fromAddress.fromStreet2}
              onChange={(e) => setFromAddress((p) => ({ ...p, fromStreet2: e.target.value }))}
            />
          </label>
        </div>
        <div className="order-hub-form-row">
          <label>
            City
            <input
              value={fromAddress.fromCity}
              onChange={(e) => setFromAddress((p) => ({ ...p, fromCity: e.target.value }))}
            />
          </label>
          <label>
            State
            <input
              value={fromAddress.fromState}
              onChange={(e) => setFromAddress((p) => ({ ...p, fromState: e.target.value.trim() }))}
            />
          </label>
          <label>
            ZIP
            <input
              value={fromAddress.fromZip}
              onChange={(e) =>
                setFromAddress((p) => ({ ...p, fromZip: normalizeZip(e.target.value) }))
              }
              maxLength={5}
            />
          </label>
        </div>
        <button type="button" className="order-hub-btn order-hub-btn-primary" onClick={saveFromAddress}>
          Save From Address
        </button>
        {fromSaved && <span className="order-hub-success"> Saved.</span>}
      </section>

      <section className="order-hub-section">
        <div className="order-hub-step1-header">
          <h3>Step 1: Upload Unshipped Orders (.txt)</h3>
          <label className="order-hub-file-order-row">
            <span className="order-hub-switch">
              <input
                type="checkbox"
                checked={fileOrderOnly}
                onChange={(e) => setFileOrderOnly(e.target.checked)}
              />
              <span className="order-hub-switch-slider" />
            </span>
            <span>File order only</span>
          </label>
        </div>
        <p className="order-hub-min-orders-desc">
          Master reference is managed in Settings. Missing weight/max qty auto-fills via Keepa when an
          ASIN is known.
        </p>
        <input
          ref={unshippedFileRef}
          type="file"
          accept=".txt,text/plain"
          onChange={handleUnshippedFile}
          style={{ display: 'none' }}
        />
        <div
          className="order-hub-upload-area"
          onClick={() => unshippedFileRef.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && unshippedFileRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          Click to upload Amazon unshipped orders .txt
        </div>
        {parseError && <div className="order-hub-error">{parseError}</div>}
        {convertSummary && (
          <div className="order-hub-summary">
            Converted {convertSummary.orders} order lines → {convertSummary.boxes} box rows
            {convertSummary.unknownResolved > 0 &&
              ` · ${convertSummary.unknownResolved} SKU(s) resolved`}
            {convertSummary.ordersFilteredOut
              ? ` · ${convertSummary.ordersFilteredOut} filtered out`
              : ''}
            <div style={{ marginTop: '0.75rem' }}>
              <button type="button" className="order-hub-btn order-hub-btn-primary" onClick={downloadCsv}>
                Download CSV
              </button>
            </div>
            {bulkConfirmOrderIds && bulkConfirmOrderIds.length > 0 && (
              <div className="order-hub-bulk-confirm">
                <p>Bulk confirm shipment links:</p>
                <ul className="order-hub-bulk-confirm-links">
                  {Array.from(
                    { length: Math.ceil(bulkConfirmOrderIds.length / BULK_CONFIRM_CHUNK_SIZE) },
                    (_, i) => {
                      const chunk = bulkConfirmOrderIds.slice(
                        i * BULK_CONFIRM_CHUNK_SIZE,
                        (i + 1) * BULK_CONFIRM_CHUNK_SIZE
                      );
                      const href = `${BULK_CONFIRM_BASE}?orderIds=${chunk.join(',')}`;
                      return (
                        <li key={i}>
                          <a
                            className="order-hub-bulk-confirm-link"
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Orders {i * BULK_CONFIRM_CHUNK_SIZE + 1}–
                            {i * BULK_CONFIRM_CHUNK_SIZE + chunk.length}
                          </a>
                        </li>
                      );
                    }
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {!fileOrderOnly && (
        <section className="order-hub-section">
          <div className="order-hub-step1-header">
            <h3>Step 2: Labels PDF</h3>
            <label className="order-hub-file-order-row">
              <span className="order-hub-switch">
                <input
                  type="checkbox"
                  checked={combineIntoOnePdf}
                  onChange={(e) => setCombineIntoOnePdf(e.target.checked)}
                />
                <span className="order-hub-switch-slider" />
              </span>
              <span>Combine into one PDF</span>
            </label>
          </div>
          <p className="order-hub-min-orders-desc">
            Upload a PDF with one label per CSV row (same order). Header pages use a smaller font so
            long titles fit.
          </p>
          <input
            ref={labelsPdfRef}
            type="file"
            accept="application/pdf"
            onChange={handleLabelsPdf}
            style={{ display: 'none' }}
          />
          <div
            className="order-hub-upload-area"
            onClick={() => csvRows?.length && !pdfProcessing && labelsPdfRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            {pdfProcessing ? 'Processing…' : 'Upload labels PDF'}
          </div>
          {pdfError && <div className="order-hub-error">{pdfError}</div>}
          <details className="order-hub-combine-zip">
            <summary className="order-hub-combine-zip-title">Optional: combine an existing labels ZIP</summary>
            <input
              ref={labelsZipRef}
              type="file"
              accept=".zip"
              onChange={handleCombineLabelsZip}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="order-hub-btn"
              disabled={combineZipProcessing}
              onClick={() => labelsZipRef.current?.click()}
            >
              {combineZipProcessing ? 'Combining…' : 'Upload ZIP'}
            </button>
            {combineZipError && <div className="order-hub-error">{combineZipError}</div>}
          </details>
        </section>
      )}

      <section className="order-hub-section">
        <h3>Step {fileOrderOnly ? '2' : '3'}: Tracking numbers</h3>
        <p className="order-hub-min-orders-desc">
          One tracking number per line, same order as CSV rows.
        </p>
        <input
          ref={trackingTxtRef}
          type="file"
          accept=".txt,text/plain"
          onChange={handleTrackingTxt}
          style={{ display: 'none' }}
        />
        <div
          className="order-hub-upload-area"
          onClick={() => csvRows?.length && trackingTxtRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          Upload tracking .txt
        </div>
        {trackingTxtError && <div className="order-hub-error">{trackingTxtError}</div>}
      </section>

      {highQtyConfirmModal && (
        <div className="order-hub-modal-overlay">
          <div className="order-hub-modal order-hub-modal-wide">
            <h4>High quantity orders</h4>
            <p className="order-hub-min-orders-desc">
              These orders have more than 4 units. Include them in the CSV, or omit them and
              convert the rest.
            </p>
            <ul className="order-hub-high-qty-list">
              {highQtyConfirmModal.map((o, i) => (
                <li key={i}>
                  {o.sku} — {o.productName} (qty {o.qty})
                </li>
              ))}
            </ul>
            <div className="form-actions">
              <button
                type="button"
                className="order-hub-btn"
                onClick={() => {
                  setHighQtyConfirmModal(null);
                  pendingConversionOrderRowsRef.current = null;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="order-hub-btn"
                onClick={() => {
                  const rows = pendingConversionOrderRowsRef.current;
                  setHighQtyConfirmModal(null);
                  pendingConversionOrderRowsRef.current = null;
                  if (!rows) return;
                  const withoutHighQty = rows.filter((o) => o.qty <= 4);
                  if (withoutHighQty.length === 0) {
                    showToast('No orders left after omitting. Upload a new file to try again.');
                    return;
                  }
                  pendingConversionOmittedRef.current += rows.length - withoutHighQty.length;
                  runConversion(withoutHighQty);
                }}
              >
                Omit these orders
              </button>
              <button
                type="button"
                className="order-hub-btn order-hub-btn-primary"
                onClick={() => {
                  const rows = pendingConversionOrderRowsRef.current;
                  setHighQtyConfirmModal(null);
                  pendingConversionOrderRowsRef.current = null;
                  if (rows) runConversion(rows);
                }}
              >
                Include &amp; continue
              </button>
            </div>
          </div>
        </div>
      )}

      {missingSkuModal && (
        <MissingSkuModal
          modal={missingSkuModal}
          onCancel={() => setMissingSkuModal(null)}
        />
      )}
    </div>
  );
}

function MissingSkuModal({
  modal,
  onCancel,
}: {
  modal: {
    sku: string;
    productName: string;
    asin?: string;
    resolve: (ref: MasterRefEntry) => void;
    keepaMsg?: string;
  };
  onCancel: () => void;
}) {
  const [weight, setWeight] = useState('1');
  const [maxQty, setMaxQty] = useState('1');
  const [name, setName] = useState(modal.productName);
  const [asin, setAsin] = useState(modal.asin || '');

  return (
    <div className="order-hub-modal-overlay">
      <div className="order-hub-modal">
        <h4>Missing master data: {modal.sku}</h4>
        {modal.keepaMsg && <p className="order-hub-min-orders-desc">{modal.keepaMsg}</p>}
        <label>ASIN</label>
        <input value={asin} onChange={(e) => setAsin(e.target.value.trim().toUpperCase())} />
        <label>Single-unit weight (lbs)</label>
        <input type="number" min={1} value={weight} onChange={(e) => setWeight(e.target.value)} />
        <label>Max units per box</label>
        <input type="number" min={1} value={maxQty} onChange={(e) => setMaxQty(e.target.value)} />
        <label>Product name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="form-actions">
          <button type="button" className="order-hub-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="order-hub-btn order-hub-btn-primary"
            onClick={() => {
              const w = Math.max(1, Math.ceil(parseFloat(weight) || 1));
              const m = Math.max(1, parseInt(maxQty, 10) || 1);
              modal.resolve({
                sku: modal.sku,
                asin: asin || undefined,
                weight: w,
                maxQtyPerBox: capMaxQtyByWeight(m, w),
                productName: name,
              });
            }}
          >
            Save & continue
          </button>
        </div>
      </div>
    </div>
  );
}
