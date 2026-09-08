-- Standalone migration: tracking_numbers for Sortcerer Order Hub persistence.
-- Safe to run once in the Supabase SQL Editor if you already applied an older schema.sql.

create table if not exists public.tracking_numbers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tracking_number text not null,
  recipient_name text,
  batch_id uuid,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tracking_number)
);

create index if not exists tracking_numbers_user_uploaded_idx
  on public.tracking_numbers (user_id, uploaded_at desc);

alter table public.tracking_numbers enable row level security;

drop policy if exists "Users can view own tracking numbers" on public.tracking_numbers;
create policy "Users can view own tracking numbers"
  on public.tracking_numbers for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own tracking numbers" on public.tracking_numbers;
create policy "Users can insert own tracking numbers"
  on public.tracking_numbers for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own tracking numbers" on public.tracking_numbers;
create policy "Users can update own tracking numbers"
  on public.tracking_numbers for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete own tracking numbers" on public.tracking_numbers;
create policy "Users can delete own tracking numbers"
  on public.tracking_numbers for delete
  using (auth.uid() = user_id);

notify pgrst, 'reload schema';
