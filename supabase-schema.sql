create table if not exists public.biztrack_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  salt text not null,
  encrypted_data text not null,
  data_key_wrapped text,
  recovery_key_wrapped text,
  updated_at timestamptz not null default now()
);

create table if not exists public.biztrack_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  subscription_plan text,
  payment_method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.biztrack_profiles
  add column if not exists subscription_plan text,
  add column if not exists payment_method text,
  add column if not exists trial_ends_at timestamptz;

create table if not exists public.biztrack_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('basic', 'pro', 'premium')),
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  provider text,
  provider_reference text unique,
  amount numeric(12, 2),
  currency text not null default 'UGX',
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.biztrack_workspaces
  add column if not exists data_key_wrapped text,
  add column if not exists recovery_key_wrapped text;

alter table public.biztrack_workspaces enable row level security;
alter table public.biztrack_profiles enable row level security;
alter table public.biztrack_payments enable row level security;

revoke insert, update on table public.biztrack_profiles from authenticated;
revoke insert (subscription_plan, payment_method, trial_ends_at)
  on table public.biztrack_profiles from authenticated;
revoke update (subscription_plan, payment_method, trial_ends_at)
  on table public.biztrack_profiles from authenticated;
grant insert (user_id, email, name, created_at, updated_at)
  on table public.biztrack_profiles to authenticated;
grant update (user_id, email, name, updated_at)
  on table public.biztrack_profiles to authenticated;

revoke all on table public.biztrack_payments from anon, authenticated;
grant all on table public.biztrack_payments to service_role;

drop policy if exists "Users can read their own profile" on public.biztrack_profiles;
create policy "Users can read their own profile"
  on public.biztrack_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own profile" on public.biztrack_profiles;
create policy "Users can create their own profile"
  on public.biztrack_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own profile" on public.biztrack_profiles;
create policy "Users can update their own profile"
  on public.biztrack_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can read their own workspace" on public.biztrack_workspaces;
create policy "Users can read their own workspace"
  on public.biztrack_workspaces for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own workspace" on public.biztrack_workspaces;
create policy "Users can create their own workspace"
  on public.biztrack_workspaces for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own workspace" on public.biztrack_workspaces;
create policy "Users can update their own workspace"
  on public.biztrack_workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
