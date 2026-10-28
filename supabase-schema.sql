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
  add column if not exists trial_ends_at timestamptz,
  add column if not exists plan_expires_at timestamptz;

create table if not exists public.biztrack_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('basic', 'pro', 'premium')),
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed')),
  amount numeric(12, 2) not null,
  currency text not null default 'UGX',
  provider text not null check (provider in ('mtn_momo', 'airtel_money')),
  provider_transaction_id text not null unique,
  reference_code text not null unique,
  rejection_reason text,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create index if not exists biztrack_payments_pending_user_idx
  on public.biztrack_payments (user_id, created_at desc)
  where status = 'pending';

create table if not exists public.biztrack_payment_intents (
  reference_code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('basic', 'pro', 'premium')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.biztrack_workspaces
  add column if not exists data_key_wrapped text,
  add column if not exists recovery_key_wrapped text;

alter table public.biztrack_workspaces enable row level security;
alter table public.biztrack_profiles enable row level security;
alter table public.biztrack_payments enable row level security;
alter table public.biztrack_payment_intents enable row level security;

revoke insert, update on table public.biztrack_profiles from authenticated;
revoke insert (user_id, email, name, subscription_plan, payment_method, created_at, updated_at, trial_ends_at, plan_expires_at)
  on table public.biztrack_profiles from authenticated;
revoke update (user_id, email, name, subscription_plan, payment_method, created_at, updated_at, trial_ends_at, plan_expires_at)
  on table public.biztrack_profiles from authenticated;
grant insert (user_id, email, name, created_at, updated_at)
  on table public.biztrack_profiles to authenticated;
grant update (user_id, email, name, updated_at)
  on table public.biztrack_profiles to authenticated;

revoke all on table public.biztrack_payments from anon, authenticated;
grant all on table public.biztrack_payments to service_role;
revoke all on table public.biztrack_payment_intents from anon, authenticated;
grant all on table public.biztrack_payment_intents to service_role;

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

create or replace function public.biztrack_has_write_access()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.biztrack_profiles p
    where p.user_id = auth.uid()
      and (
        (p.plan_expires_at > now() and p.subscription_plan in ('basic', 'pro', 'premium'))
        or (p.trial_ends_at > now())
      )
  );
$$;

revoke all on function public.biztrack_has_write_access() from public, anon;
grant execute on function public.biztrack_has_write_access() to authenticated, service_role, postgres;

drop policy if exists "Users can create their own workspace" on public.biztrack_workspaces;
create policy "Users can create their own workspace"
  on public.biztrack_workspaces for insert
  with check (auth.uid() = user_id and public.biztrack_has_write_access());

drop policy if exists "Users can update their own workspace" on public.biztrack_workspaces;
create policy "Users can update their own workspace"
  on public.biztrack_workspaces for update
  using (auth.uid() = user_id and public.biztrack_has_write_access())
  with check (auth.uid() = user_id and public.biztrack_has_write_access());

create or replace function public.biztrack_approve_payment(p_reference text)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payment_row public.biztrack_payments%rowtype;
  expiry timestamptz;
begin
  select * into payment_row
  from public.biztrack_payments
  where reference_code = p_reference
  for update;

  if not found or payment_row.status <> 'pending' then
    raise exception 'Payment reference is missing or is not pending';
  end if;

  update public.biztrack_profiles
  set subscription_plan = payment_row.plan,
      plan_expires_at = greatest(coalesce(plan_expires_at, now()), now()) + interval '30 days',
      updated_at = now()
  where user_id = payment_row.user_id
  returning plan_expires_at into expiry;

  if not found then
    raise exception 'Payment user profile was not found';
  end if;

  update public.biztrack_payments
  set status = 'verified', verified_at = now(), rejection_reason = null
  where id = payment_row.id;

  return expiry;
end;
$$;

create or replace function public.biztrack_reject_payment(p_reference text, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.biztrack_payments
  set status = 'failed', rejection_reason = nullif(trim(p_reason), '')
  where reference_code = p_reference and status = 'pending';

  if not found then
    raise exception 'Payment reference is missing or is not pending';
  end if;
end;
$$;

revoke all on function public.biztrack_approve_payment(text) from public, anon, authenticated;
revoke all on function public.biztrack_reject_payment(text, text) from public, anon, authenticated;
grant execute on function public.biztrack_approve_payment(text) to service_role, postgres;
grant execute on function public.biztrack_reject_payment(text, text) to service_role, postgres;

create or replace view public.biztrack_pending_payments as
select
  p.reference_code as reference,
  p.user_id,
  u.email as user_email,
  p.plan,
  p.amount,
  p.provider,
  p.provider_transaction_id as transaction_id,
  p.created_at as requested_at
from public.biztrack_payments p
join auth.users u on u.id = p.user_id
where p.status = 'pending';

revoke all on public.biztrack_pending_payments from public, anon, authenticated;
grant select on public.biztrack_pending_payments to service_role, postgres;
