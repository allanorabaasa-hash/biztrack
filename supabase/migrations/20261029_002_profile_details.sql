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
