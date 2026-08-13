export interface MasterRefEntryStored {
  sku: string;
  asin?: string;
  weight: number;
  maxQtyPerBox: number;
  productName?: string;
}

const BOM = '\uFEFF';

export interface RejectedRow {
  lineIndex: number;
  raw: string[];
  reason: string;
}

export interface ParseMasterReferenceCsvResult {
  rows: MasterRefEntryStored[];
  rejected: RejectedRow[];
}

function normalizeHeader(h: string): string {
  let s = h.replace(BOM, '').trim().toLowerCase();
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function headerToKey(normalized: string): string {
  const n = normalized.trim();
  const map: Record<string, string> = {
    asin: 'asin',
    sku: 'sku',
    weight: 'weight',
    'max qty per box': 'maxQtyPerBox',
    'product name': 'productName',
    product_name: 'productName',
  };
  return map[n] ?? n.replace(/\s+/g, '_');
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        current += c;
      }
    } else if (c === ',') {
      out.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current.trim());
  return out;
}

export function alignCsvCellsToHeaderCount(cells: string[], headerCount: number): string[] {
  if (headerCount <= 0 || cells.length <= headerCount) return cells;
  const head = cells.slice(0, headerCount - 1);
  const tail = cells
    .slice(headerCount - 1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...head, tail];
}

export function parseMasterReferenceCsv(text: string): ParseMasterReferenceCsvResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows: MasterRefEntryStored[] = [];
  const rejected: RejectedRow[] = [];

  if (lines.length < 2) {
    return { rows: [], rejected: [] };
  }

  const firstLine = lines[0].startsWith(BOM) ? lines[0].replace(BOM, '') : lines[0];
  const headerCells = parseCsvLine(firstLine);
  const headers = headerCells.map((h) => headerToKey(normalizeHeader(h)));
  const headerCount = headers.length;

  const skuIdx = headers.indexOf('sku');
  const weightIdx = headers.indexOf('weight');
  const maxQtyIdx = headers.findIndex((h) => h === 'maxQtyPerBox' || h === 'max_qty_per_box');
  const asinIdx = headers.indexOf('asin');
  const productNameIdx = headers.indexOf('productName');

  if (skuIdx === -1) {
    rejected.push({ lineIndex: 1, raw: headerCells, reason: 'Missing SKU column' });
    return { rows, rejected };
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = alignCsvCellsToHeaderCount(parseCsvLine(lines[i]), headerCount);
    const lineIndex = i + 1;

    const sku = (cells[skuIdx] ?? '').trim();
    if (!sku) {
      rejected.push({ lineIndex, raw: cells, reason: 'Empty SKU' });
      continue;
    }

    const weightRaw = (cells[weightIdx] ?? '').trim();
    const weight = parseFloat(weightRaw);
    if (weightRaw === '' || isNaN(weight) || weight < 0) {
      rejected.push({ lineIndex, raw: cells, reason: `Invalid WEIGHT: "${weightRaw}"` });
      continue;
    }

    const maxQtyRaw = (cells[maxQtyIdx] ?? '').trim() || '1';
    const maxQtyPerBox = parseInt(maxQtyRaw, 10);
    if (isNaN(maxQtyPerBox) || maxQtyPerBox < 1) {
      rejected.push({ lineIndex, raw: cells, reason: `Invalid MAX QTY PER BOX: "${maxQtyRaw}"` });
      continue;
    }

    rows.push({
      sku,
      asin: asinIdx >= 0 ? (cells[asinIdx] ?? '').trim() || undefined : undefined,
      weight,
      maxQtyPerBox,
      productName: productNameIdx >= 0 ? (cells[productNameIdx] ?? '').trim() || undefined : undefined,
    });
  }

  return { rows, rejected };
}
