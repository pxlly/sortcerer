/**
 * Local persistence for Default From Address only.
 * Master reference lives in Supabase.
 */

const KEY_FROM_ADDRESS = 'sortcerer.defaultFromAddress.v1';

export interface DefaultFromAddress {
  fromName: string;
  fromStreet1: string;
  fromStreet2: string;
  fromCity: string;
  fromState: string;
  fromZip: string;
}

const emptyFromAddress: DefaultFromAddress = {
  fromName: '',
  fromStreet1: '',
  fromStreet2: '',
  fromCity: '',
  fromState: '',
  fromZip: '',
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

export function validateFromAddress(raw: unknown): { data: DefaultFromAddress; valid: boolean } {
  if (!isPlainObject(raw)) return { data: emptyFromAddress, valid: false };
  const o = raw;
  const data: DefaultFromAddress = {
    fromName: isString(o.fromName) ? o.fromName.trim() : '',
    fromStreet1: isString(o.fromStreet1) ? o.fromStreet1.trim() : '',
    fromStreet2: isString(o.fromStreet2) ? o.fromStreet2.trim() : '',
    fromCity: isString(o.fromCity) ? o.fromCity.trim() : '',
    fromState: isString(o.fromState) ? o.fromState.trim() : '',
    fromZip: isString(o.fromZip) ? o.fromZip.trim() : '',
  };
  return { data, valid: true };
}

export function getDefaultFromAddress(): { data: DefaultFromAddress; valid: boolean } {
  try {
    const s = localStorage.getItem(KEY_FROM_ADDRESS);
    if (s == null) return { data: emptyFromAddress, valid: true };
    return validateFromAddress(JSON.parse(s) as unknown);
  } catch {
    return { data: emptyFromAddress, valid: false };
  }
}

export function setDefaultFromAddress(data: DefaultFromAddress): void {
  localStorage.setItem(KEY_FROM_ADDRESS, JSON.stringify(data));
}
