-- SKU uniqueness migration: allow any number of SKUs to share an ASIN.
-- Safe to re-run. Unique identity is (user_id, sku) only.

begin;

delete from public.master_reference older
using public.master_reference newer
where older.user_id = newer.user_id
  and older.sku = newer.sku
  and (older.updated_at, older.id) < (newer.updated_at, newer.id);

alter table public.master_reference
  alter column asin drop not null;

alter table public.master_reference
  drop constraint if exists master_reference_user_id_asin_key;

-- Drop any unique constraint on (user_id, asin) if named differently.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.master_reference'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%asin%'
      and pg_get_constraintdef(oid) not ilike '%sku%'
  loop
    execute format('alter table public.master_reference drop constraint if exists %I', r.conname);
  end loop;
end $$;

-- Drop unique indexes on (user_id, asin) that are not backed by the constraint above.
do $$
declare r record;
begin
  for r in
    select i.relname as idxname
    from pg_index x
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_class i on i.oid = x.indexrelid
    where n.nspname = 'public'
      and t.relname = 'master_reference'
      and x.indisunique
      and not x.indisprimary
      and pg_get_indexdef(x.indexrelid) ilike '%asin%'
      and pg_get_indexdef(x.indexrelid) not ilike '%sku%'
  loop
    execute format('drop index if exists public.%I', r.idxname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.master_reference'::regclass
      and conname = 'master_reference_user_id_sku_key'
  ) then
    alter table public.master_reference
      add constraint master_reference_user_id_sku_key unique (user_id, sku);
  end if;
end $$;

drop index if exists public.master_reference_user_sku_idx;

notify pgrst, 'reload schema';
commit;
