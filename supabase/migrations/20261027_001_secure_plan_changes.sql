-- BizTrack: server-controlled plans, 7-day Basic trial, read-only after expiry,
-- and automatic mobile money payments (Relworx).
-- Safe to re-run.

-- 1. Profile access columns ------------------------------------------------
alter table public.biztrack_profiles
  add column if not exists trial_ends_at timestamptz,
  add column if not exists plan_expires_at timestamptz;

-- 2. Payments ----------------------------------------------------------------
-- An earlier draft of this migration (manual payments) was never deployed.
-- Drop its leftovers if a test database has them.
drop view if exists public.biztrack_pending_payments;
drop function if exists public.biztrack_approve_payment(text);
drop function if exists public.biztrack_reject_payment(text, text);
drop table if exists public.biztrack_payment_intents;

create table if not exists public.biztrack_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('basic', 'pro', 'premium')),
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'failed')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'UGX',
  msisdn text not null,
  provider text not null default 'relworx',
  network text,
  reference text not null unique,
  provider_reference text unique,
  provider_transaction_id text,
  charge numeric(12, 2),
  failure_reason text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz
);

create index if not exists biztrack_payments_user_idx
  on public.biztrack_payments (user_id, created_at desc);

alter table public.biztrack_profiles enable row level security;
alter table public.biztrack_workspaces enable row level security;
alter table public.biztrack_payments enable row level security;

-- 3. Column privileges: users may only write harmless profile fields --------
revoke insert, update on table public.biztrack_profiles from anon, authenticated;
grant insert (user_id, email, name, created_at, updated_at)
  on table public.biztrack_profiles to authenticated;
grant update (user_id, email, name, updated_at)
  on table public.biztrack_profiles to authenticated;

-- Payments are server-only (Edge Functions use the service role).
revoke all on table public.biztrack_payments from anon, authenticated;
grant all on table public.biztrack_payments to service_role;

-- 4. Write access = active paid plan OR active trial -----------------------
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
      and (p.plan_expires_at > now() or p.trial_ends_at > now())
  );
$$;

revoke all on function public.biztrack_has_write_access() from public, anon;
grant execute on function public.biztrack_has_write_access()
  to authenticated, service_role;

-- Workspaces: reading is always allowed (see baseline policy).
-- Creating or changing data needs write access. One exception: a workspace
-- that still uses the old key format (data_key_wrapped is null) may be
-- re-encrypted by its owner, so security upgrades never lock anyone out.
drop policy if exists "Users can create their own workspace" on public.biztrack_workspaces;
create policy "Users can create their own workspace"
  on public.biztrack_workspaces for insert
  with check (auth.uid() = user_id and public.biztrack_has_write_access());

drop policy if exists "Users can update their own workspace" on public.biztrack_workspaces;
create policy "Users can update their own workspace"
  on public.biztrack_workspaces for update
  using (
    auth.uid() = user_id
    and (public.biztrack_has_write_access() or data_key_wrapped is null)
  )
  with check (
    auth.uid() = user_id
    and (public.biztrack_has_write_access() or data_key_wrapped is not null)
  );

-- 5. Granting a verified payment (called by the payments Edge Function) ----
-- Idempotent: a payment that is already verified is never counted twice.
-- A payment marked failed (e.g. timed out) can still be granted if the
-- provider later confirms it succeeded.
create or replace function public.biztrack_grant_payment(
  p_reference text,
  p_provider_reference text default null,
  p_provider_transaction_id text default null,
  p_network text default null,
  p_charge numeric default null
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  pay public.biztrack_payments%rowtype;
  expiry timestamptz;
begin
  select * into pay
  from public.biztrack_payments
  where reference = p_reference
  for update;

  if not found then
    raise exception 'Payment % not found', p_reference;
  end if;

  if pay.status = 'verified' then
    select plan_expires_at into expiry
    from public.biztrack_profiles where user_id = pay.user_id;
    return expiry;
  end if;

  update public.biztrack_profiles
  set subscription_plan = pay.plan,
      plan_expires_at = greatest(coalesce(plan_expires_at, now()), now())
        + interval '30 days',
      updated_at = now()
  where user_id = pay.user_id
  returning plan_expires_at into expiry;

  if not found then
    raise exception 'Profile for payment % not found', p_reference;
  end if;

  update public.biztrack_payments
  set status = 'verified',
      verified_at = now(),
      updated_at = now(),
      failure_reason = null,
      provider_reference = coalesce(p_provider_reference, provider_reference),
      provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
      network = coalesce(p_network, network),
      charge = coalesce(p_charge, charge)
  where id = pay.id;

  return expiry;
end;
$$;

revoke all on function public.biztrack_grant_payment(text, text, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.biztrack_grant_payment(text, text, text, text, numeric)
  to service_role;

-- 6. Support tools (run by you in the SQL Editor) --------------------------
-- Recent payments, newest first.
drop view if exists public.biztrack_recent_payments;
create view public.biztrack_recent_payments as
select
  p.reference,
  u.email as user_email,
  p.plan,
  p.amount,
  p.status,
  p.msisdn,
  p.network,
  p.provider_reference,
  p.provider_transaction_id,
  p.failure_reason,
  p.created_at,
  p.verified_at
from public.biztrack_payments p
join auth.users u on u.id = p.user_id
order by p.created_at desc;

revoke all on public.biztrack_recent_payments from public, anon, authenticated;
grant select on public.biztrack_recent_payments to service_role;

-- Manually grant a payment after confirming it in the Relworx dashboard.
create or replace function public.biztrack_admin_grant(p_reference text)
returns timestamptz
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.biztrack_grant_payment(p_reference);
$$;

revoke all on function public.biztrack_admin_grant(text)
  from public, anon, authenticated;
grant execute on function public.biztrack_admin_grant(text) to service_role;
