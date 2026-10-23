/** Map PostgREST / Postgres errors to actionable UI copy. */
const SKU_UNIQUENESS_SQL =
  'Run this once in Supabase SQL Editor (project SQL → New query), then retry:\n\n' +
  'begin;\n' +
  'delete from public.master_reference older using public.master_reference newer ' +
  'where older.user_id = newer.user_id and older.sku = newer.sku ' +
  'and (older.updated_at, older.id) < (newer.updated_at, newer.id);\n' +
  'alter table public.master_reference alter column asin drop not null;\n' +
  'alter table public.master_reference drop constraint if exists master_reference_user_id_asin_key;\n' +
  "do $$ declare r record; begin for r in select conname from pg_constraint where conrelid = 'public.master_reference'::regclass and contype = 'u' and pg_get_constraintdef(oid) ilike '%asin%' and pg_get_constraintdef(oid) not ilike '%sku%' loop execute format('alter table public.master_reference drop constraint if exists %I', r.conname); end loop; end $$;\n" +
  "do $$ begin if not exists (select 1 from pg_constraint where conrelid = 'public.master_reference'::regclass and conname = 'master_reference_user_id_sku_key') then alter table public.master_reference add constraint master_reference_user_id_sku_key unique (user_id, sku); end if; end $$;\n" +
  "notify pgrst, 'reload schema';\n" +
  'commit;';

/** Postgres undefined_column / undefined_table and PostgREST schema-cache equivalents. */
const MISSING_SCHEMA_CODES = new Set(['42703', '42P01', 'PGRST204', 'PGRST205']);

/** Matches network-level failures and the body Supabase returns while a free-tier project is paused. */
export function isDbUnreachableError(message: string, code?: string | null): boolean {
  const lower = message.toLowerCase();
  return (
    code === 'db_unreachable' ||
    lower.includes('fetch failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('project is paused') ||
    lower.includes('project paused') ||
    lower.includes('service unavailable') ||
    lower.includes('upstream connect error') ||
    lower.includes('cloudflare')
  );
}

export const DB_UNREACHABLE_MESSAGE =
  'Could not reach the database (Supabase). Free-tier Supabase projects are paused after about a ' +
  'week without activity — open the Supabase dashboard, click Restore on the project, wait a minute, ' +
  'then retry. If the project is running, check that Vercel has the right NEXT_PUBLIC_SUPABASE_URL ' +
  'and NEXT_PUBLIC_SUPABASE_ANON_KEY.';

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again, then retry.';

/** Postgres error code for "no unique or exclusion constraint matching the ON CONFLICT specification". */
export const NO_CONFLICT_TARGET_CODE = '42P10';

export function isMissingConflictTargetError(message: string, code?: string | null): boolean {
  return (
    code === NO_CONFLICT_TARGET_CODE ||
    message.toLowerCase().includes('no unique or exclusion constraint matching the on conflict')
  );
}

export function formatDbError(message: string, code?: string | null): string {
  const lower = message.toLowerCase();
  if (isDbUnreachableError(message, code)) {
    return `${DB_UNREACHABLE_MESSAGE} Details: ${message}`;
  }
  if (
    code === 'PGRST301' ||
    lower.includes('jwt expired') ||
    lower.includes('invalid jwt') ||
    lower.includes('refresh token')
  ) {
    return SESSION_EXPIRED_MESSAGE;
  }
  const aboutTracking =
    lower.includes('tracking_numbers') ||
    lower.includes('tracking_batches') ||
    lower.includes('tracking_number');
  if (aboutTracking && (lower.includes('row-level security') || code === '42501')) {
    return (
      'Saving tracking numbers was blocked by database permissions (row-level security). ' +
      'Re-run supabase/schema.sql from the Sortcerer repo in the Supabase SQL Editor to restore ' +
      `the tracking policies, then retry. Details: ${message}`
    );
  }
  const missingObject =
    lower.includes('does not exist') &&
    (lower.includes('column') || lower.includes('relation') || lower.includes('table'));
  if (
    (code && MISSING_SCHEMA_CODES.has(code)) ||
    missingObject ||
    lower.includes('schema cache') ||
    (lower.includes('could not find the table') && lower.includes('public.'))
  ) {
    return (
      'Database tables/columns are missing or out of date (schema not applied). In the Supabase ' +
      'dashboard: SQL Editor → New query → paste and Run supabase/schema.sql from the Sortcerer repo ' +
      `(it is idempotent and safe to re-run), wait a few seconds, then retry. Details: ${message}`
    );
  }
  if (
    lower.includes('master_reference_user_id_asin_key') ||
    (lower.includes('duplicate key') && lower.includes('asin')) ||
    (isMissingConflictTargetError(message, code) && !aboutTracking)
  ) {
    return (
      'Save blocked by the old one-row-per-ASIN database rule. Multiple SKUs may share an ASIN ' +
      `after a one-time migration. ${SKU_UNIQUENESS_SQL}`
    );
  }
  if (lower.includes('null value in column "asin"')) {
    return (
      'Your master_reference.asin column does not allow empty values. Run this in the Supabase ' +
      'SQL Editor: alter table public.master_reference alter column asin drop not null; ' +
      "notify pgrst, 'reload schema';"
    );
  }
  return message;
}
