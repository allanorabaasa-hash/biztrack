# BizTrack

BizTrack is a static HTML/CSS/JS business accounting app that stores encrypted workspace data in Supabase Postgres and uses Supabase Auth for login.

## Supabase schema and migrations

For an existing project, run every new file in [supabase/migrations](supabase/migrations/) in filename order in the Supabase SQL Editor. After applying the migrations, refresh the API schema cache:

```sql
notify pgrst, 'reload schema';
```

For a fresh install, run the full current schema in [supabase-schema.sql](supabase-schema.sql) instead. It is idempotent and can be re-run safely. Keep this full schema current alongside the incremental migration files.

## Setup steps

1. Create a Supabase project.
2. In Supabase SQL Editor, run [supabase-schema.sql](supabase-schema.sql) for a fresh project, or apply the migration files in order for an existing project, then run `notify pgrst, 'reload schema';`.
3. Copy your project URL and anon key into [static/supabase-config.js](static/supabase-config.js).
4. In Supabase Authentication > Providers > Email, disable Confirm email during development so signup/login works immediately.
5. In Authentication > URL Configuration, set the Site URL to your local or deployed URL (for example `http://localhost:8000`) and add the same URL to Redirect URLs.
6. Serve the project with a local HTTP server or deploy to GitHub Pages/static host. Do not open the page as a direct file URL.

## Plan system

The app now uses a plan object in the browser code. The three plan choices are:

- `basic`: BizTrack Basic — UGX 5,000 / month
- `pro`: BizTrack Pro — UGX 7,500 / month
- `premium`: BizTrack Premium — UGX 12,000 / month

Basic includes a one-time 7-day trial. Pro and Premium require a verified payment. A verified payment grants 30 days, extending an active paid period rather than discarding remaining time. Expired accounts retain read-only access to all workspace pages and can export all data.

## Payments (automatic, via Relworx)

Users pay with MTN or Airtel Mobile Money. They enter their number, approve the prompt on their phone with their PIN, and the plan unlocks automatically. Prices live on the server in `supabase/functions/payments/index.ts` (Basic 5,000, Pro 7,500, Premium 12,000 UGX per 30 days).

How it works:

1. The app calls the `payments` function (`action: "create"`). The server records a pending payment and asks Relworx to send the PIN prompt.
2. Relworx calls `payments/webhook` when the payment finishes. The signature is checked, then the result is re-checked with Relworx's status API before anything is granted.
3. If the webhook is lost, the app's status checks (and the next login) ask Relworx directly, so a paid user is never left stuck.
4. `biztrack_grant_payment` adds 30 days (on top of any time left) and is idempotent, so a repeated webhook never adds extra time.

Edge Function secrets (Supabase > Edge Functions > Secrets). In Relworx, set the request payment webhook to `https://bwnxektjplspuoltxors.supabase.co/functions/v1/payments/webhook`.

| Name | Value |
| --- | --- |
| `RELWORX_API_KEY` | API key from Relworx > API Keys |
| `RELWORX_ACCOUNT_NO` | Business account number (starts with `REL`) |
| `RELWORX_WEBHOOK_KEY` | Webhook key from Relworx > Business Accounts > View > Settings |

Deploy `payments` with **JWT verification turned off** (Relworx cannot send a Supabase token; the function checks user tokens itself). Deploy `select-plan` with JWT verification on.

To add another provider later (Flutterwave, MTN or Airtel direct), implement the `PaymentProvider` interface in `payments/index.ts` and switch `PROVIDER`.

## Payment support

Recent payments (SQL Editor):

```sql
select * from public.biztrack_recent_payments limit 20;
```

If a customer paid but their plan did not unlock, find the payment in the Relworx dashboard first. Only when Relworx shows it as successful, grant it by its BizTrack reference:

```sql
select public.biztrack_admin_grant('BT0123456789abcdef0123');
```

Granting is idempotent: running it twice does not add extra time. These tools are available only to the SQL Editor and the server, never to app users.

## Recovery-key design

To avoid data loss when users forget passwords, the workspace is encrypted with a random data key. That data key is wrapped by:

- the password-derived key, and
- a recovery-code-derived key.

At signup and first login, the app should display a one-time recovery code and warn the user that if both the password and recovery code are lost, data cannot be recovered. The wrapped keys are stored in `biztrack_workspaces.data_key_wrapped` and `biztrack_workspaces.recovery_key_wrapped`.

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

## Android app

BizTrack uses Capacitor 8.5.3 with the static site copied to `www/`. The checked-in `capacitor.config.json` uses app name `BizTrack`, app ID `com.allanorabaasa.biztrack`, and `www` as `webDir`. The build copies the web app and Capacitor's browser plugin bundles into `www/`, and inserts plugin script tags into `www/index.html` only. The GitHub Pages site continues to use the root web files without loading native plugins.

The Capacitor Android project and launcher/splash resources are checked in. For a fresh project only, initialize the config and add the Android platform once:

```bash
npx cap init BizTrack com.allanorabaasa.biztrack --web-dir www
npx cap add android
```

On Kali, configure the Android SDK, Android Studio path, and a full Java 21 JDK (Capacitor 8's Android build requires Java 21):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export CAPACITOR_ANDROID_STUDIO_PATH=/opt/android-studio/bin/studio.sh
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

In Android Studio, open **Tools > SDK Manager** and install **Android SDK Platform 36** and **Android SDK Build-Tools 36.0.0** if they are missing. Confirm Java 21 includes `javac`; a JRE-only install is not enough.

For normal development, run these commands from the repository root in order:

```bash
npm install
npm run build
npx cap sync android
npx cap open android
```

The `CAPACITOR_ANDROID_STUDIO_PATH` export above lets `npx cap open android` find Android Studio under `/opt`.

To build a debug APK from the repository root:

```bash
./android/gradlew -p android assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. To install it on a connected device, run `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. Alternatively, open Android Studio with `npx cap open android` and select **Build > Build Bundle(s) / APK(s) > Build APK(s)**. If regenerating native icons, use the BizTrack source icon in `static/icons/icon-512.png` with `@capacitor/assets`, then run `npx cap sync android` again.

Set `ANDROID_HOME` to `$HOME/Android/Sdk` on Kali and use Android Studio's embedded JDK 21 (or another JDK 21) for Gradle. Capacitor 8 requires Java 21.

Keep Supabase auth confirmation and password-reset email redirects on the GitHub Pages site (`https://allanorabaasa-hash.github.io/biztrack/`) and allowlist that URL under Supabase Authentication > URL Configuration. Native deep links can be added later with an Android App Link or custom URL scheme, an Android intent filter, Capacitor App's `appUrlOpen` / `getLaunchUrl` handlers, and the app link added to Supabase's Redirect URLs.
