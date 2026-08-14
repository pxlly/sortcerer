-- Sortcerer Supabase schema
-- Run in Supabase SQL Editor after creating your project.

-- Profiles (one Amazon store per account)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  store_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = user_id);

-- Subscriptions (locked until invoice paid)
-- First successful payment = $300 setup; renewals = $175 / ~30 days.
-- setup_paid tracks whether the one-time signup fee has been collected.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'locked' check (status in ('active', 'locked')),
  setup_paid boolean not null default false,
  current_period_end timestamptz,
  last_invoice_id text,
  last_order_id text,
  updated_at timestamptz not null default now()
);

-- Existing projects (already ran an older schema.sql): run this once in SQL Editor:
--   alter table public.subscriptions
--     add column if not exists setup_paid boolean not null default false;
--   -- Prior $100 invoices counted as setup for existing payers
--   update public.subscriptions
--   set setup_paid = true
--   where setup_paid = false
--     and (last_invoice_id is not null or status = 'active' or current_period_end is not null);

alter table public.subscriptions enable row level security;

create policy "Users can view own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Service role updates subscriptions via postback (bypasses RLS)

-- Master reference: unique ASIN per user
create table if not exists public.master_reference (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  asin text not null,
  sku text not null,
  weight_lb numeric(10, 2),
  max_qty_per_box integer,
  product_name text,
  updated_at timestamptz not null default now(),
  unique (user_id, asin)
);

create index if not exists master_reference_user_sku_idx
  on public.master_reference (user_id, sku);

alter table public.master_reference enable row level security;

create policy "Users can view own master ref"
  on public.master_reference for select
  using (auth.uid() = user_id);

create policy "Users can insert own master ref"
  on public.master_reference for insert
  with check (auth.uid() = user_id);

create policy "Users can update own master ref"
  on public.master_reference for update
  using (auth.uid() = user_id);

create policy "Users can delete own master ref"
  on public.master_reference for delete
  using (auth.uid() = user_id);

-- Auto-create profile + locked subscription on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, status)
  values (new.id, 'locked')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
