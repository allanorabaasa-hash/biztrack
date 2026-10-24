# BizTrack

BizTrack is a static HTML/CSS/JS business accounting app that stores encrypted workspace data in Supabase Postgres and uses Supabase Auth for login.

## Supabase SQL to run

Run the following in the Supabase SQL Editor in order:

```sql
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

create policy "Users can read their own profile"
  on public.biztrack_profiles for select
  using (auth.uid() = user_id);

create policy "Users can create their own profile"
  on public.biztrack_profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own profile"
  on public.biztrack_profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can read their own workspace"
  on public.biztrack_workspaces for select
  using (auth.uid() = user_id);

create policy "Users can create their own workspace"
  on public.biztrack_workspaces for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own workspace"
  on public.biztrack_workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

## Setup steps

1. Create a Supabase project.
2. In Supabase SQL Editor, run [supabase-schema.sql](supabase-schema.sql).
3. Copy your project URL and anon key into [static/supabase-config.js](static/supabase-config.js).
4. In Supabase Authentication > Providers > Email, disable Confirm email during development so signup/login works immediately.
5. In Authentication > URL Configuration, set the Site URL to your local or deployed URL (for example `http://localhost:8000`) and add the same URL to Redirect URLs.
6. Serve the project with a local HTTP server or deploy to GitHub Pages/static host. Do not open the page as a direct file URL.

## Plan system

The app now uses a plan object in the browser code. The three plan choices are:

- `basic`: BizTrack Basic — UGX 5,000 / month
- `pro`: BizTrack Pro — UGX 7,500 / month
- `premium`: BizTrack Premium — UGX 12,000 / month

The selection is stored in `biztrack_profiles.subscription_plan`, while access control is enforced in the browser using a single config object and page allowlists.

## Recovery-key design

To avoid data loss when users forget passwords, the workspace is encrypted with a random data key. That data key is wrapped by:

- the password-derived key, and
- a recovery-code-derived key.

At signup and first login, the app should display a one-time recovery code and warn the user that if both the password and recovery code are lost, data cannot be recovered. The wrapped keys are stored in `biztrack_workspaces.data_key_wrapped` and `biztrack_workspaces.recovery_key_wrapped`.

> TODO: real payment verification must happen server-side using a Supabase Edge Function and payment webhook; the client must then lose permission to write `subscription_plan`.

## News function deployment

The Edge Function lives in [supabase/functions/news/index.ts](supabase/functions/news/index.ts). Deploy it from the project root with:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy news --project-ref YOUR_PROJECT_REF
```

Set these environment variables in the Supabase dashboard for the function:

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

The function expects a valid bearer token and filters RSS/Atom feeds, deduplicates headlines, and caches the newest 60 results for 30 minutes.

## Local testing

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in the browser.
