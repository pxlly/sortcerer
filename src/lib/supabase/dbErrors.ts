/** Map PostgREST / Postgres errors to actionable UI copy. */
export function formatDbError(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes('schema cache') ||
    (lower.includes('could not find the table') && lower.includes('public.'))
  ) {
    return (
      'Database tables are missing (schema not applied). In the Supabase dashboard: ' +
      'SQL Editor → New query → paste and Run the contents of supabase/schema.sql from the Sortcerer repo, ' +
      'wait a few seconds for the schema cache to refresh, then retry.'
    );
  }
  return message;
}
