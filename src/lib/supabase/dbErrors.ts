/** Map PostgREST / Postgres errors to actionable UI copy. */
const RUN_SCHEMA_SQL =
  'In the Supabase dashboard: SQL Editor → New query → paste and Run the contents of ' +
  'supabase/schema.sql from the Sortcerer repo, wait a few seconds for the schema cache to ' +
  'refresh, then retry.';

export function formatDbError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('schema cache') ||
    (lower.includes('could not find the table') && lower.includes('public.'))
  ) {
    return `Database tables are missing (schema not applied). ${RUN_SCHEMA_SQL}`;
  }
  if (lower.includes('no unique or exclusion constraint matching the on conflict')) {
    return (
      'The master_reference table still uses the old ASIN uniqueness rule, so saving by SKU ' +
      `failed. ${RUN_SCHEMA_SQL}`
    );
  }
  if (lower.includes('master_reference_user_id_asin_key')) {
    return (
      'This ASIN is already used by another SKU and your database still enforces one row per ' +
      `ASIN. Multiple SKUs may share an ASIN after the SKU-uniqueness migration. ${RUN_SCHEMA_SQL}`
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
