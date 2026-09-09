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

export function formatDbError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('schema cache') ||
    (lower.includes('could not find the table') && lower.includes('public.'))
  ) {
    return (
      'Database tables are missing (schema not applied). In the Supabase dashboard: SQL Editor → ' +
      'New query → paste and Run supabase/schema.sql from the Sortcerer repo, wait a few seconds, then retry.'
    );
  }
  if (
    lower.includes('master_reference_user_id_asin_key') ||
    (lower.includes('duplicate key') && lower.includes('asin')) ||
    lower.includes('no unique or exclusion constraint matching the on conflict')
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
