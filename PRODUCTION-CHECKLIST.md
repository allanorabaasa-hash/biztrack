# BizTrack launch checklist

Everything the code can do is done. These are the steps only you can do: accounts, dashboards and forms. Work top to bottom.

## 1. Supabase (about 20 minutes)

### Deploy
- [ ] SQL Editor: run `supabase/migrations/20261029_002_profile_details.sql` (if not done yet), then `20261029_003_password_reset.sql`, then `notify pgrst, 'reload schema';`
- [ ] Edge Functions: deploy **`delete-account`** from `supabase/functions/delete-account/index.ts` (leave JWT verification **on**)
- [ ] Edge Functions: deploy **`news`** from `supabase/functions/news/index.ts` (the Premium News section needs it)
- [ ] Check `payments` still has JWT verification **off**, and `select-plan` has it **on**

### Authentication settings
- [ ] Authentication → URL Configuration → **Site URL**: `https://allanorabaasa-hash.github.io/biztrack/`
- [ ] **Redirect URLs**: add `https://allanorabaasa-hash.github.io/biztrack/` and `https://allanorabaasa-hash.github.io/biztrack/*`
- [ ] Authentication → Sign In / Providers → Email: turn **Confirm email** on (the app now handles it: new users confirm, then log in)
- [ ] Authentication → Emails → **SMTP Settings**: set up a real email sender. Supabase's built-in sender is only for testing and sends just a few emails per hour, so confirmation and password-reset emails will stop arriving once you have users. Free options include Brevo (300 emails a day) or Resend. You need a sending address, ideally on your own domain.
- [ ] Authentication → Emails → Templates: change "Confirm signup" and "Reset password" to mention BizTrack

### Reliability
- [ ] Free projects **pause after a week with no activity** and have **no automatic backups**. Before real customers depend on it, upgrade to **Pro** (about $25/month, daily backups).
- [ ] Until then, back up weekly: Database → Backups, or run `pg_dump` with the connection string from Project Settings → Database.

## 2. Payments (Relworx)
- [ ] Relworx enables API access on account `RELACEBE4C6D9` (requested by WhatsApp)
- [ ] KYC approved: business registration documents uploaded
- [ ] Test: pay UGX 5,000 for Basic from your own number; the plan unlocks within seconds
- [ ] If it took 15 seconds or more, check Edge Functions → payments → Logs for `401` (webhook signature). If you see one, retype the webhook URL in Relworx by hand.

## 3. ⚠️ Decide: payments inside the Play Store app

**Google Play's Payments policy requires digital subscriptions sold inside an Android app to use Google Play Billing.** Google's new billing choice program (third-party payments) started on 30 June 2026 for users in the **US, UK and EEA only**, with more countries promised later. It does not cover Uganda yet. So the in-app mobile money screen may get the Play version rejected. The **website version is not affected**.

Options (to decide before submitting):
1. **Play version without in-app payment (fastest).** In the Android app, hide the Pay screens. Users get the free trial in the app, and anyone who has paid on the website gets their plan in the app. The app must not tell users to go and pay elsewhere.
2. **Add Google Play Billing to the Android app.** Users pay through Google Play (cards, and mobile money or carrier billing where Google supports it). Google takes a service fee, typically 15% on subscriptions. It's more work: a Play Billing plugin plus server-side purchase checks.
3. **Wait** until Google's billing choice reaches Uganda, then keep mobile money in the app.

## 4. Legal and business
- [ ] Register a business name with URSB (needed for Relworx KYC anyway)
- [ ] Register with the Personal Data Protection Office (PDPO) as a data collector/processor
- [ ] Read `privacy.html` and `terms.html` and confirm they're right for you. They use `orallan19@gmail.com` as the contact. Change it in all three pages if you create a support email.
- [ ] Get a TIN from URA once you start earning

## 5. Google Play Console

### Account
- [ ] Create a developer account at play.google.com/console ($25 one-time). A **personal** account needs identity verification. An **organization** account needs a D-U-N-S number but skips the closed-testing rule below.

### Release build (on your computer)
- [ ] Create the upload key and `android/keystore.properties` (README → "Release build for Google Play"). **Back up the .jks file and password.**
- [ ] `npm run version:patch` then `npm run android:release`
- [ ] Upload `android/app/build/outputs/bundle/release/app-release.aab`

### Closed test (new personal accounts)
- [ ] Testing → Closed testing: add **at least 12 testers** (their Gmail addresses), who must stay opted in for **14 days**
- [ ] Ask testers to open the app on a few different days, and send feedback
- [ ] After 14 days: Apply for production access

### Store listing (text ready below)
- [ ] App name, short description and full description
- [ ] App icon: `play-store/app-icon-512.png`
- [ ] Feature graphic: `play-store/feature-graphic.png`
- [ ] Phone screenshots: `play-store/screenshots/` (sample data from a made-up shop)
- [ ] Category: **Business**. Contact email. Privacy policy URL.

### App content forms
- [ ] Privacy policy: `https://allanorabaasa-hash.github.io/biztrack/privacy.html`
- [ ] Data safety (answers below)
- [ ] Account deletion URL: `https://allanorabaasa-hash.github.io/biztrack/delete-account.html`
- [ ] Content rating questionnaire: a business/productivity app with no violence, sexual content, gambling or user chat. Expect "Everyone"/"3+".
- [ ] Target audience: **18 and over**
- [ ] Ads: **No ads**
- [ ] Financial features declaration: BizTrack is a record-keeping (bookkeeping) app. It doesn't lend, hold money, trade or transfer funds. Answer that it provides **no financial services**; it only sells its own subscription.
- [ ] App access: give reviewers a test login (an account with an active trial or plan), with notes.

## 6. Final tests before release
- [ ] `OFFLINE-PWA-TESTING.md`
- [ ] New account: confirmation email arrives, log in, trial shows "6 days left · ends …" (or 7 on day one)
- [ ] Forgot password: reset email arrives; the new password plus recovery code opens your old records
- [ ] Profile: change name, username and photo; it shows in the menu and survives logging in again
- [ ] Delete account (use a test account): everything is gone, and logging in again fails
- [ ] Trial ended: banner shows Pay and Export, records can be viewed but not changed
- [ ] Payment (once Relworx is live): Pro unlocks for 30 days; a declined payment unlocks nothing

---

## Store listing text

**App name** (30 max): `BizTrack: Business Records`

**Short description** (80 max):
`Track sales, expenses, stock and profit for your small business, even offline.`

**Full description:**

```
BizTrack is a simple bookkeeping app for small businesses: shops, salons, boutiques, agents, farmers and traders.

Record your money in and money out, and always know whether you are making a profit.

WHAT YOU CAN DO
• Record income and expenses in seconds
• See profit and loss for today, this week, this month or any dates
• Manage more than one business in one account
• Sales and invoicing: record sales and customers (Pro)
• Inventory: track stock and get low-stock alerts (Pro)
• Business news for Uganda and East Africa (Premium)

WORKS OFFLINE
Keep recording without data or network. BizTrack saves on your phone and syncs when you're back online.

PRIVATE BY DESIGN
Your business records are encrypted on your phone before they are saved online. We can't read them. Export your data any time.

PLANS
• Basic: UGX 5,000 per 30 days, with a 7-day free trial
• Pro: UGX 7,500 per 30 days
• Premium: UGX 12,000 per 30 days
No automatic charges: you choose when to pay again.

Made in Uganda.
```

(If you choose option 1 in section 3, remove the plan prices from the Play listing and describe the free trial only.)

---

## Data safety answers

**Does your app collect or share any of the required user data types?** Yes.

**Is all user data encrypted in transit?** Yes (HTTPS).

**Do you provide a way for users to request deletion?** Yes, in the app and at the account deletion URL.

**Data shared with third parties:** None. Supabase and Relworx are service providers acting for you, which Play doesn't count as "sharing".

| Data type (Play category) | Collected | Required? | Purposes |
| --- | --- | --- | --- |
| Personal info → Name | Yes | Required | App functionality, Account management |
| Personal info → Email address | Yes | Required | App functionality, Account management, Developer communications |
| Personal info → User IDs (username) | Yes | Optional | App functionality |
| Personal info → Phone number | Yes | Optional (profile); required to pay | App functionality (payments), Account management |
| Personal info → Address (town or city) | Yes | Optional | App functionality |
| Personal info → Other info (short bio) | Yes | Optional | App functionality |
| Photos and videos → Photos (profile photo) | Yes | Optional | App functionality |
| Financial info → Purchase history (plan payments) | Yes | Required for paid plans | App functionality, Account management, Fraud prevention |
| Financial info → Other financial info (business records) | Yes | Required | App functionality |

The business records are encrypted on the device and can't be read by you, but declaring them is the safe choice. Not collected: location, contacts, messages, app activity or analytics, device IDs, health, web browsing.
