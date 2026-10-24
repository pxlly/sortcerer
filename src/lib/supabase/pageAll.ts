/**
 * PostgREST (Supabase) silently truncates every SELECT to `max-rows` (1000 by default). A query
 * that "returns all rows for this user" therefore returns the first 1000 and nothing hints at
 * the loss. Every read that can grow past a few hundred rows must page with `.range()`.
 */

/** Rows per page. Must not exceed the PostgREST `max-rows` setting (Supabase default: 1000). */
export const PAGE_SIZE = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string; code?: string | null } | null };

/**
 * Fetch every row of a query by paging with `.range(from, to)` until a short page comes back.
 *
 * `makePage` must build a fresh query for the given inclusive range each time (PostgREST query
 * builders are single-use), with a deterministic `.order(...)` so pages do not overlap, e.g.
 *
 *   fetchAllRows((from, to) =>
 *     supabase.from('t').select('*').eq('user_id', id).order('created_at').order('id').range(from, to)
 *   );
 */
export async function fetchAllRows<T>(
  makePage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = PAGE_SIZE
): Promise<{ data: T[]; error: null } | { data: null; error: NonNullable<PageResult<T>['error']> }> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makePage(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const page = data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return { data: all, error: null };
}
