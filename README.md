# BizTrack

## Supabase setup

BizTrack uses Supabase Auth for accounts and stores each user's AES-GCM encrypted workspace in a row protected by row-level security.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [supabase-schema.sql](supabase-schema.sql).
3. Copy `static/supabase-config.js` to your Supabase project URL and anon key from **Project Settings > API**.
4. In Supabase **Authentication > Providers > Email**, turn off **Confirm email** so users can log in immediately after signup.
5. In Supabase **Authentication > URL Configuration**, set **Site URL** to the URL you use to open the app, for example `http://localhost:8000`, and add the same URL to **Redirect URLs**.
6. Serve the project over HTTP or deploy it to a static host. Opening the HTML directly as a `file:` URL can block the Supabase CDN or API requests.

Only the encrypted workspace blob is stored in the application table. The password is handled by Supabase Auth and is never stored by BizTrack.
