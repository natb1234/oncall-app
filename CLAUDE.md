# OnCall — project handover for Claude

Read this first. It explains the whole project so you can continue without the earlier chat.

## The person
- Non-technical founder. Works only from an iPhone (Safari + Claude app). No laptop, no terminal.
- Wants direct, honest answers; rate ideas out of 10; say when you're unsure.
- Never ask them to paste secret keys (Stripe `sk_...`, Supabase service_role, Resend `re_...`) into chat. Secrets go into the Supabase dashboard (Edge Functions → Secrets).

## What OnCall is
A small same-day task marketplace (Ireland, EUR). Posters post small jobs, workers bid, poster accepts a bid and pays into escrow, worker marks done with a photo, poster approves (or it auto-releases after 24h), poster rates the worker. OnCall keeps a 10% platform fee.

## Where everything lives
- **App (frontend):** single file `index.html` (identical copy `oncall-mvp.html`) in this repo, served by GitHub Pages:
  `https://natb1234.github.io/oncall-app/`  — plain HTML + JS, Supabase JS from CDN. Keep both files identical.
- **Backend:** Supabase project ref `vwezewdobyyqrbflllmg` (eu-west-1), URL `https://vwezewdobyyqrbflllmg.supabase.co`. Publishable key is in `index.html` (safe to be public).
- **Payments function:** Supabase Edge Function `oncall` — source in `oncall-edge-function.ts` (repo root). Deployed with **verify_jwt = false** on purpose (the cron timer has no user login); every user action checks the login token itself via `getCaller`, the timer checks a Vault secret via `check_cron_secret()`.
- **Database schema:** `oncall-schema.sql` (original), then `oncall-stage1-migration.sql`, `oncall-site-bucket.sql`, `oncall-timer-and-reminders.sql` (all in repo root, applied in that order). RLS is on everywhere; clients cannot update money/lifecycle columns — only the Edge Function (service_role) can.
- **Stripe:** test mode ("Sandbox"). Hosted Stripe Checkout with `capture_method: manual` (hold on accept, capture on approve). Stripe Connect Express for worker payouts. Secret key is an Edge Function secret `STRIPE_SECRET_KEY`.
- **Email:** Resend, key in Edge Function secret `RESEND_API_KEY`. No custom domain yet, so emails only reach the account owner (natbooth252@gmail.com).
- **Timer:** pg_cron job `oncall-auto-release` every 15 min → POSTs `{"action":"auto_release_sweep"}` to the function with header `x-cron-secret` (stored in Vault as `oncall_cron_secret`). The sweep sends the 4-hours-left reminder email, then auto-releases jobs past `auto_release_at`.

## Edge Function actions
`create_checkout_session`, `finalize_accept_bid` (takes Checkout `sessionId`), `mark_job_done` (photo required, server sets 24h window), `approve_completion`, `file_dispute`, `submit_review`, `connect_onboarding_link`, `sync_connect_status`, `auto_release_sweep` (timer only). `create_payment_intent` is legacy/unused.

## Status (as of 18 Oct 2026)
Tested end to end in the user's hands: signup/login, profile, post job with photo, bid, messaging, accept + pay with test card 4242…, mark done with photo, approve & release, rating, reminder email.

Test accounts: `natbooth252@gmail.com` (poster) and `natbooth252+worker@gmail.com` (worker, name "Nay").

## To-do, most important first
1. **Worker payouts:** test Connect onboarding (Settings → "Getting paid") and that approval transfers €54 to the worker. The first test job's €54 stayed in the platform balance because the worker had no Connect account — needs a manual transfer or a sweep for pending payouts.
2. **Premium is broken:** "Go premium" toggles `profiles.premium` for free (no payment), and the app shows a 6% fee for premium while the server always charges 10%. Either build a real Stripe subscription + server-side fee, or hide Premium.
3. **Domain** for Resend so reminder emails reach real users; then set `EMAIL_FROM`.
4. Worker's "job done" photo isn't shown on the poster's card after payout (it's saved in `tasks.completion_photo_url`).
5. Leftovers to clean up (deletes were blocked from chat): test task "TEST reminder email (ignore)" (marked completed), table `public.site_pages`, unused Supabase Storage bucket `site`.
6. Before launch: switch Stripe to live keys, solicitor-reviewed terms, ID verification is currently a fake toggle (`verified` set by the client).

## How to ship changes
Edit `index.html` and copy the same content to `oncall-mvp.html`, commit to `main`; GitHub Pages republishes in ~1 minute. Edge Function and database changes must be deployed to Supabase separately (they are not auto-deployed from this repo).
