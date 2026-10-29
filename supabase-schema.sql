-- BizTrack full schema for a fresh Supabase project.
-- Generated from supabase/migrations/ (run in order). Safe to re-run.

-- ===== 20261027_000_baseline.sql =====
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
  add column if not exists payment_method text;

alter table public.biztrack_workspaces
  add column if not exists data_key_wrapped text,
  add column if not exists recovery_key_wrapped text;

alter table public.biztrack_workspaces enable row level security;
alter table public.biztrack_profiles enable row level security;

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
-- ===== 20261027_001_secure_plan_changes.sql =====
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

-- ===== 20261029_002_profile_details.sql =====
-- BizTrack: profile details (username, photo, phone, town, about).
-- Safe to re-run.

alter table public.biztrack_profiles
  add column if not exists username text,
  add column if not exists phone text,
  add column if not exists location text,
  add column if not exists bio text,
  add column if not exists avatar_url text;

-- Limits, so one profile can't grow the database without bound.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'biztrack_profiles_username_format') then
    alter table public.biztrack_profiles add constraint biztrack_profiles_username_format
      check (username is null or username ~ '^[a-z0-9_.]{3,30}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'biztrack_profiles_field_lengths') then
    alter table public.biztrack_profiles add constraint biztrack_profiles_field_lengths
      check (
        coalesce(length(name), 0) <= 80
        and coalesce(length(phone), 0) <= 20
        and coalesce(length(location), 0) <= 80
        and coalesce(length(bio), 0) <= 280
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'biztrack_profiles_avatar_size') then
    -- The app stores a small (256 px) JPEG photo as a data URL.
    alter table public.biztrack_profiles add constraint biztrack_profiles_avatar_size
      check (
        avatar_url is null
        or (avatar_url like 'data:image/jpeg;base64,%' and length(avatar_url) <= 200000)
      );
  end if;
end $$;

-- Usernames are unique, ignoring capital letters.
create unique index if not exists biztrack_profiles_username_key
  on public.biztrack_profiles (lower(username))
  where username is not null;

-- Users may edit these profile fields (plan, trial and payment fields stay
-- server-only, see 20261027_001).
grant update (name, username, phone, location, bio, avatar_url, updated_at)
  on table public.biztrack_profiles to authenticated;

-- ===== 20261029_003_password_reset.sql =====
-- BizTrack: password reset with the recovery code.
-- Safe to re-run.
--
-- Business data is encrypted with a data key, and the data key is stored
-- "wrapped" (encrypted) by the password and, separately, by the recovery code.
-- After a password reset the app unwraps the data key with the recovery code
-- and wraps it again with the new password. This function saves that new
-- wrapper. It changes nothing else, and only on the caller's own workspace,
-- so it also works for read-only (expired) accounts. The encrypted business
-- data itself is untouched.

create or replace function public.biztrack_set_password_key(p_wrapped text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_wrapped is null or length(p_wrapped) > 2000 or p_wrapped !~ '^\{.*"iv".*"data".*\}$' then
    raise exception 'Invalid key';
  end if;
  update public.biztrack_workspaces
  set data_key_wrapped = p_wrapped,
      updated_at = now()
  where user_id = auth.uid()
    and data_key_wrapped is not null;
  return found;
end;
$$;

revoke all on function public.biztrack_set_password_key(text) from public, anon;
grant execute on function public.biztrack_set_password_key(text) to authenticated;

-- ===== 20261029_004_username_login.sql =====
-- BizTrack: sign in with a username, and accounts without an email address.
-- Safe to re-run.

-- Failed username logins and username signups, used to slow down password
-- guessing and bot signups. Server-only (the username-auth function).
create table if not exists public.biztrack_auth_attempts (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('login_failed', 'signup')),
  username text not null,
  created_at timestamptz not null default now()
);

create index if not exists biztrack_auth_attempts_lookup_idx
  on public.biztrack_auth_attempts (kind, username, created_at desc);

alter table public.biztrack_auth_attempts enable row level security;
revoke all on table public.biztrack_auth_attempts from anon, authenticated;
grant all on table public.biztrack_auth_attempts to service_role;

-- Old attempts are only useful for a few minutes. Run occasionally:
--   delete from public.biztrack_auth_attempts where created_at < now() - interval '1 day';

