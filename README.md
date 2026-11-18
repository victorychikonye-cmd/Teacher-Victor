# ZIMSEC AI Teacher: WhatsApp chatbot with EcoCash payments

Students chat with ZIMSEC AI Teacher on WhatsApp. They get a few free tutor questions a day, then buy more
with EcoCash without leaving the chat. The owner verifies payments by WhatsApp (or on a web dashboard) and keeps
final control of money, prices and access.

## What students can do (all inside WhatsApp)

| Send | What happens |
|---|---|
| any question | AI tutor explains step by step, to the ZIMSEC syllabus for their Form / Lower 6 / Upper 6 (English, Shona, Ndebele) |
| `2` Practice assignment, `3` Mock exam | bot sets a paper, the student replies with answers, the bot marks it and records the score |
| `4` Revision notes, `5` Performance report | notes for a topic; a study report built from their marked work |
| `BUY` | prices shown first, then quantity, optional discount code, total, then EcoCash instructions |
| `PAID <transaction ID>` | student submits the EcoCash confirmation ID and the number they paid from |
| `STATUS`, `RECEIPT` | active access and expiry dates; last receipt |
| `ADD 0771234567` | school buyer adds a student seat |
| `STOP`, `DELETE` | stop reminders; erase study data (payment records are kept for accounting) |

## Owner commands (WhatsApp numbers listed in `zpay_wa_admins`)

`PENDING` lists payments waiting. `VERIFY ZAT-XXXXXXXX` confirms one (student is activated and gets a receipt).
`REJECT ZAT-XXXXXXXX reason` rejects. `SUMMARY` shows revenue. Everything else (EcoCash number, price limits,
discounts, suspending services, AI price recommendations, transactions, audit log, CSV export) is on the web dashboard.

## How money is protected

- Prices are computed only in the database: cost-plus, then clamped to the owner's min and max. The student sees the total before paying, and an order's amount never changes.
- Nothing is activated until an admin verifies the payment against the EcoCash statement. One EcoCash transaction ID can back only one order, and one order can activate access only once.
- An admin cannot verify their own payment on WhatsApp.
- The AI only *recommends* prices. The owner approves; approval affects new orders only, never an active subscription's agreed price.
- The bot never asks for an EcoCash PIN, password or OTP, and nothing in the database could store one.
- Webhook calls must carry Meta's signature. Student tables are unreadable except by the bot (service role). The audit log cannot be edited or deleted.

## Project layout

```
supabase/migrations/…_zimsec_teacher.sql     database, pricing engine, payment rules, security
supabase/functions/whatsapp-webhook/         the chatbot (receives WhatsApp messages)
supabase/functions/daily-maintenance/        expires orders/subscriptions, sends renewal reminders
supabase/functions/price-advisor/            AI price recommendations for the owner
supabase/functions/_shared/                  WhatsApp sending, AI prompts, student-facing wording (text.ts)
web/app.html                                 student web app (works in any browser and in an Android/iOS webview)
web/privacy.html, web/icon.png               privacy policy page and app icon, host next to app.html
web/index.html                               owner dashboard (single static file)
supabase/functions/web-api/                  server side of the web app (sign-in required)
tests/                                       database rules test + full conversation test
```

## Setup

1. **Supabase.** Create a project. Apply the migration (`supabase db push`, or paste the SQL file into the SQL editor).
2. **WhatsApp.** In Meta for Developers, create an app with the WhatsApp product (Cloud API) and a business number. Note the *Phone number ID*, a *permanent access token*, and the *App secret*.
3. **Secrets** (`supabase secrets set …`):
   `ANTHROPIC_API_KEY`, `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` (any long random text you choose), `CRON_SECRET` (another random text).
4. **Deploy:** `supabase functions deploy whatsapp-webhook daily-maintenance price-advisor` (the included `config.toml` turns off JWT checks only for the two functions that need it off).
5. **Connect the webhook.** In Meta, WhatsApp > Configuration: callback URL `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`, verify token = your `WA_VERIFY_TOKEN`, then subscribe to the **messages** field.
6. **Make yourself owner.**
   - WhatsApp: `insert into zpay_wa_admins (phone, role) values ('263786610390', 'owner');` (use *your* number, country code first, no `+`).
   - Dashboard: sign up the owner's email in Supabase Auth, then `insert into zpay_admins (user_id, role) select id, 'owner' from auth.users where email = 'YOU@EXAMPLE.COM';`
7. **Schedule maintenance** (enable `pg_cron` and `pg_net`):
   ```sql
   select cron.schedule('zimsec-maintenance', '*/30 * * * *', $$
     select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/daily-maintenance',
       headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'Content-Type', 'application/json'), body := '{}'::jsonb) $$);
   ```
8. **Dashboard.** Put your Supabase URL and anon key at the top of `web/index.html` and host it anywhere static. Sign in as the owner, open *Pricing* and replace the example costs and limits with your real ones. Check *Settings* (EcoCash number defaults to 0786610390; add an account name and support contact).

## Web app (webview)

`web/app.html` is the same teacher as a mobile web app: sign in with email and password, tutor chat, practice assignments, mock exams, revision notes, performance report, buying with EcoCash, receipts and erasing data. It uses the same prices, payment checks and access rules as WhatsApp. Web accounts are separate from WhatsApp students.

1. In Supabase, Authentication > Providers > Email must be on. If "Confirm email" is on, students must click the email link before signing in. Add your site address under Authentication > URL Configuration.
2. Host the three files `app.html`, `privacy.html` and `icon.png` together on any static host (Cloudflare Pages, Netlify, GitHub Pages). Rename `app.html` to `index.html` if you want it at the site's root.
3. For an Android app, load that address in a WebView (or use a "website to app" builder). Payments stay manual: the student pays by EcoCash, enters the transaction ID, and you verify it.

## Things to know before going live

- **WhatsApp 24-hour rule.** WhatsApp lets a business send free text only within 24 hours of the person's last message. Payment alerts to you, "verified" notices and renewal reminders may fall outside that window. For those, create and get approved message templates in Meta, then set the optional secrets `WA_ADMIN_TEMPLATE` (2 variables: reference, amount), `WA_VERIFIED_TEMPLATE` (service, reference), `WA_REJECTED_TEMPLATE` (reference), `WA_EXPIRY_TEMPLATE` (service, date) and `WA_SEAT_TEMPLATE` (date). The bot tries free text first and falls back to the template. A new number also needs Meta business verification before it can message the public at scale.
- **AI cost.** Every tutor answer costs money. The free daily quota (default 5, owner setting) and a 150-reply daily fair-use cap per student limit exposure. Watch your first week's usage and tune the prices.
- **Manual verification.** There is no automated EcoCash check. If you later get an EcoCash merchant or provider API, verify its signed callback in an Edge Function and call `zpay_activate_order(order_id, null, 'provider')`. That is the only place access is granted.
- **Included vs paid features.** Daily, weekly, monthly and school access include tutoring, assignments, revision notes and reports. Mock exams are always bought separately. Change this per service with `covered_by_access` in `zpay_services`.
- **Testing your own payments.** You cannot verify your own WhatsApp payment (by design). Test with a second phone number, or approve from the web dashboard.
- **Student data.** The bot stores phone number, WhatsApp name, level, recent chat memory and marked-work scores. Review Zimbabwe's data protection requirements for your use, and adjust the notice in `_shared/text.ts` if needed.

## Tests

```
PGHOST=/path/to/postgres-socket PGPORT=5432 tests/bot/run.sh                       # full conversation test (61 checks)
SETUP_ONLY=1 PGHOST=… PGPORT=… tests/bot/run.sh        # makes a fresh scratch database with the migration applied
psql -h … -p … -U postgres -d zimsec_bot_test -v ON_ERROR_STOP=1 -f tests/payments.test.sql   # money-rule checks (needs that fresh database)
```
The conversation test runs the real bot code against a real Postgres, with WhatsApp and the AI faked. It has not been run against live Supabase, Meta or the Claude API, so do a small end-to-end trial with real numbers first: one free chat, one US$0.25 purchase, one verification.

## Not built (yet)

Timed mock exams (the paper is not clocked), removing a school seat, PDF receipts (receipts are WhatsApp text), voice notes and photos (the bot asks for text), changing the EcoCash number by WhatsApp (deliberately dashboard-only, so a stolen phone cannot redirect payments).
