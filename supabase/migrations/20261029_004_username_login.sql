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
