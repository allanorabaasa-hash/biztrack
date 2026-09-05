# BizTrack

## Supabase setup

BizTrack uses Supabase Auth for accounts and stores each user's AES-GCM encrypted workspace in a row protected by row-level security.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [supabase-schema.sql](supabase-schema.sql).
3. Copy `static/supabase-config.js` to your Supabase project URL and anon key from **Project Settings > API**.
4. If email confirmation is enabled, confirm the signup email before logging in on another device.
5. Serve the project over HTTP or deploy it to a static host. Opening the HTML directly as a `file:` URL can block the Supabase CDN or API requests.

Only the encrypted workspace blob is stored in the application table. The password is handled by Supabase Auth and is never stored by BizTrack.
