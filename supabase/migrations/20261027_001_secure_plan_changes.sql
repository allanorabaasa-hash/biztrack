alter table public.biztrack_profiles
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