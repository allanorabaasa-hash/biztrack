-- BizTrack: usernames can be anything (capitals, spaces, symbols), except "@".
-- Safe to re-run.

-- Replace the strict a-z/0-9 rule with: 1-50 characters, no "@" (an "@" is
-- how the login screen tells an email from a username).
alter table public.biztrack_profiles
  drop constraint if exists biztrack_profiles_username_format;
alter table public.biztrack_profiles
  add constraint biztrack_profiles_username_format
  check (
    username is null
    or (length(btrim(username)) between 1 and 50 and position('@' in username) = 0)
  );

-- Lowercase, trimmed copy used to find a username at login. "Mama Rose",
-- "mama rose" and " MAMA ROSE " are the same username.
alter table public.biztrack_profiles
  add column if not exists username_key text
  generated always as (lower(btrim(username))) stored;

drop index if exists public.biztrack_profiles_username_key;
create unique index if not exists biztrack_profiles_username_key_idx
  on public.biztrack_profiles (username_key)
  where username_key is not null;

-- Attempts are keyed by the lowercase username too; allow longer values.
alter table public.biztrack_auth_attempts
  alter column username type text;
