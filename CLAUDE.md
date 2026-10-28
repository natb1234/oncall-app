# OnCall — project handover for Claude

Read this first. It explains the whole project so you can continue without the earlier chat.

## The person
- Non-technical founder. Works only from an iPhone (Safari + Claude app). No laptop, no terminal.
- Wants direct, honest answers; rate ideas out of 10; say when you're unsure.
- Never ask them to paste secret keys (Stripe `sk_...`, Supabase service_role, Resend `re_...`) into chat. Secrets go into the Supabase dashboard (Edge Functions → Secrets).

## What OnCall is
A small same-day task marketplace (Ireland, EUR). Posters post small jobs, workers bid, poster accepts a bid and pays into escrow, worker marks done with a photo, poster approves (or it auto-releases after 24h), poster rates the worker. OnCall keeps a 10% platform fee (6% if the worker has Premium when the bid is accepted).

## Where everything lives
- **App (frontend):** single file `index.html` (identical copy `oncall-mvp.html`) in this repo, served by GitHub Pages:
  `https://natb1234.github.io/oncall-app/`  — plain HTML + JS, Supabase JS from CDN. Keep both files identical.
- **Backend:** Supabase project ref `vwezewdobyyqrbflllmg` (eu-west-1), URL `https://vwezewdobyyqrbflllmg.supabase.co`. Publishable key is in `index.html` (safe to be public).
- **Payments function:** Supabase Edge Function `oncall` — source in `oncall-edge-function.ts` (repo root). Deployed with **verify_jwt = false** on purpose (the cron timer has no user login); every user action checks the login token itself via `getCaller`, the timer checks a Vault secret via `check_cron_secret()`.
- **Database schema:** `oncall-schema.sql` (original), then `oncall-stage1-migration.sql`, `oncall-site-bucket.sql`, `oncall-timer-and-reminders.sql`, `oncall-payouts-and-premium.sql`, `oncall-legal-and-reports.sql`, `oncall-travel-zone.sql`, `oncall-id-verification.sql`, `oncall-app-store.sql` (all in repo root, applied in that order). RLS is on everywhere; clients cannot update money/lifecycle columns — only the Edge Function (service_role) can.
- **Stripe:** test mode ("Sandbox"). Hosted Stripe Checkout with `capture_method: manual` (hold on accept, capture on approve). Stripe Connect Express for worker payouts. Secret key is an Edge Function secret `STRIPE_SECRET_KEY`.
- **Email:** Resend, key in Edge Function secret `RESEND_API_KEY`. No custom domain yet, so emails only reach the account owner (natbooth252@gmail.com).
- **Timer:** pg_cron job `oncall-auto-release` every 15 min → POSTs `{"action":"auto_release_sweep"}` to the function with header `x-cron-secret` (stored in Vault as `oncall_cron_secret`). The sweep sends the 4-hours-left reminder email, auto-releases jobs past `auto_release_at`, then pays any worker whose job money is still waiting (see Payouts).

## Payouts
On release the server captures the payment and, if the worker's Stripe Connect account has `transfers` active, transfers amount minus 10% (recorded in `payments.payout_transfer_id` / `paid_out_at`). If not, the money waits in the platform balance; it's sent automatically when the worker finishes "Getting paid" setup (`sync_connect_status`) or on the next 15-min timer run. Stripe idempotency key `oncall-payout-<taskId>` prevents double payment.

## App layout
Bottom tabs: Home (job feed), Saved, Post (form only), **My jobs** (switch between Posted — your jobs with bids, accept/pay, approve, rate — and Bidding — your bids, mark done, payout status), Inbox, Profile (profile card, Premium card, then everything that used to be in Settings: notifications (demo), payout setup, Terms, Privacy, Help & support (`support.html`), Blocked people (unblock), Log out, Delete my account — the ⚙️ button scrolls there). Returning from Stripe Checkout lands on My jobs → Posted; from Premium checkout, on Profile.

## Travel zone (like Facebook Marketplace)
- Each user has a search area: `profiles.area_lat/area_lng/area_label` + `radius_km` (1–500; the sheet's distance control sits at the top: slider over steps 1–500 km plus quick picks 5/10/20/40/100 km and "Anywhere" = 500, which means no distance limit). Before a profile exists it's kept in `localStorage` (`oncall_area`) and copied into the profile on creation.
- Jobs have `tasks.lat/lng`, required when posting (Post → "Where is the job?" opens the map, defaulting to your area).
- **Privacy:** all coordinates are rounded to 2 decimals (~1 km) by database triggers (`prepare_new_task`, `round_profile_area`, helper `round_coord`) — exact addresses are never stored.
- Home: area chip under the search bar opens the map sheet (`openAreaSheet('area'|'pin', start, onApply)`), Leaflet 1.9.4 from cdnjs + OpenStreetMap tiles; place search and reverse lookup via OSM Nominatim (one request per tap, no typeahead, Ireland only). Only jobs within the radius are shown (client-side haversine), Featured first, then nearest; cards show "· 4 km". Jobs without a pin (posted before this feature) are listed under "Location not on the map".
- For real traffic, OSM's free tile and Nominatim servers aren't meant for production use — switch to a paid provider (e.g. MapTiler, Stadia, Geoapify) before launch. When jobs grow into the thousands, move the distance filter into the database (PostGIS).

## ID + age verification (Stripe Identity)
- Everyone must pass a Stripe Identity check (passport / driving licence / national ID, photographed live — **no selfie**, by the owner's choice on 24 Oct; trade-off: someone could use another person's ID) and be 18+ before posting or bidding. Enforced in the database: restrictive RLS insert policies on `tasks` and `bids` require `public.is_verified_adult(auth.uid())`; the app also gates Post and the bid sheet.
- `profiles.id_status` (`none|pending|processing|verified|failed|under_18`), `id_session_id`, `id_verified_at`, `id_error`, `id_attempts` (max 5), plus `verified`. Only the server writes these; the `protect_new_profile` insert trigger forces them (and premium) to defaults.
- Actions `start_id_check` (creates/reuses a VerificationSession, returns Stripe's hosted URL, back to `?idcheck=1`) and `sync_id_check` (reads the result; the timer also re-checks pending/processing ones). Age: reads `verified_outputs.dob` with a **restricted key** in Edge Function secret `STRIPE_IDENTITY_KEY` (Identity Verification Results + Recent Detailed Verification Results: Read; works for 48h after a check). DOB and images are never stored — only the outcome.
- Needs Identity activated in the Stripe Dashboard. Costs Stripe's per-verification fee (~€1.50). No biometric data (no selfie), so no Art. 9 consent needed; human review on request. Terms/Privacy v1.3 cover this. To add face matching later: `require_matching_selfie: true` in `startIdCheck` + Terms/Privacy wording for biometric consent.
- Badge "✓ ID verified" on profiles and bids is real again (`verifiedBadgeHtml`).
- Set up and tested 24 Oct: Identity application completed in both the live account and the **sandbox** (the sandbox needs its own activation, otherwise the Identity permissions don't appear when creating restricted keys); restricted key saved as `STRIPE_IDENTITY_KEY`; Nat and Nay both verified first try (18+ check passed). For going live: repeat in the live account (new live restricted key) and complete Stripe's "Add business details" + "Verify your identity" for the owner.

## Premium
Real Stripe subscription, €4.99/month (Checkout `mode: subscription`, inline price, subscription metadata `oncall=premium`). Perks for workers: 6% fee instead of 10% on jobs won (fee fixed in `finalize_accept_bid` from a live Stripe check) and a ★ Premium badge on bids. Perk for posters: their new jobs are Featured (pinned to the top of Home, gold border) for 48h — set by the `prepare_new_task` insert trigger from `profiles.premium`.

## Boost
One-off €1.99 per job (any poster, open jobs only): `create_boost_checkout` → Stripe Checkout → back to `?boosted=1&cs=…` → `finalize_boost` sets `tasks.featured_until` = now+48h (idempotent via `boost_session_id`). If the poster never returns to the app after paying, the boost isn't applied (no webhook) — refund manually if that ever happens.

## New-job trigger
`prepare_new_task` (before insert on tasks) forces all lifecycle/money columns to their defaults, because the `authenticated` role has table-level INSERT on tasks. Only the form fields the app sends are kept. Stripe is the source of truth; `profiles.premium` / `premium_until` are a copy written only by the function (`sync_premium`), re-checked by the timer when `premium_until` passes. Cancel = `cancel_at_period_end` (and undo) via `set_premium_renewal`; no Stripe customer portal needed. No webhooks.

## Legal (drafted 20 Oct 2026 — needs solicitor review)
- `terms.html` and `privacy.html` (repo root, served by GitHub Pages) are the full Terms of Service and Privacy Policy, v1.0, written for Irish/EU law (consumer law incl. 14-day withdrawal, GDPR, Digital Services Act notice & action, Omnibus paid-ranking disclosure, DAC7). Yellow `[placeholders]` still to fill: operator's full legal name, business address, contact email, VAT number. Operator is currently a **sole trader** (personally liable) — recommend forming a Ltd.
- In the app: Terms/Privacy open those pages in an overlay (`openToS(section, 'terms'|'privacy')`); sign-up requires a "18+ and agree" checkbox, stored in auth user metadata (`terms_version`, `terms_accepted_at`); "OnCall Guarantee" replaced by a true "Payment protection" banner (no insurance exists); fake "Verified" badge and self-verify buttons removed (`verifiedBadgeHtml` returns ''); Featured jobs labelled as paid placements; withdrawal-right notices on Premium/Boost; fee shown in the bid form; **Report** buttons (bid sheet, message thread) → action `submit_report` → `public.reports` (service-role only) + email to `REPORTS_EMAIL` (defaults to owner). Google Fonts removed (system fonts) for GDPR.
- If the Terms change, bump `terms_version` in the sign-up code (now '1.3') and the version line in terms.html. Terms/Privacy v1.1 (24 Oct) added location/OpenStreetMap wording.

## App Store requirements (28 Oct 2026) — see `APP-STORE.md`
- **Block users:** table `public.blocks` (blocker_id, blocked_id; users manage only their own rows). Restrictive RLS insert policies stop messages and bids between blocked people in either direction (`is_blocked_between`). The app hides blocked people's jobs, bids and inbox threads (`loadBlocks`, `isBlocked`). ⊘ Block buttons sit next to ⚑ Report in the message thread and bid sheet.
- **Delete account:** action `delete_account` (body `confirm: "DELETE"`). Refused while a job is in progress (either side) or a payout is still owed. Cancels Premium at once, asks Stripe to redact the ID check, deletes open jobs (with their bids/messages), unaccepted bids, messages and photos (kept on disputed jobs), blocks, then the profile — or, if finished jobs/payments/reviews/reports reference it, anonymises it to "Deleted user" (`profiles.deleted_at`) — and finally the auth login. For that, `profiles_id_fkey` (cascade from auth.users) was dropped, so deleting a user in the Supabase dashboard no longer removes their profile — use the app's delete instead. Tested end to end 28 Oct with two throwaway accounts.
- **iPhone app:** `IN_IOS_APP` (user agent contains `OnCallApp`, or Capacitor iOS) hides Go Premium and Boost, because Apple requires its in-app purchase for digital extras. Job payments stay on Stripe (real-world services are allowed).

## Edge Function actions
`create_checkout_session`, `finalize_accept_bid` (takes Checkout `sessionId`), `mark_job_done` (photo required, server sets 24h window), `approve_completion`, `file_dispute`, `submit_review`, `connect_onboarding_link`, `sync_connect_status`, `create_premium_checkout`, `sync_premium`, `set_premium_renewal`, `create_boost_checkout`, `finalize_boost`, `submit_report`, `start_id_check`, `sync_id_check`, `delete_account`, `auto_release_sweep` (timer only). `create_payment_intent` is legacy/unused.

## Status (as of 18 Oct 2026, evening)
- Deployed function version 16 (28 Oct: `delete_account`). Before that, version 14 (ID check without selfie; ID verification; reports; Boost; Premium subscription; pending-payout catch-up, retried every timer run with a 10-minute idempotency window so a failed attempt isn't stuck for 24h, and checks Stripe for an existing transfer before paying; worker Connect accounts prefilled as Irish individuals so they skip company questions — unfinished accounts without the `oncall_prefill` metadata tag are replaced). Stripe sandbox needed "Accounts v1 support" switched on (Settings → API policies) for Connect account creation; consider moving to Accounts v2 before live. `premium` is not client-writable. Poster now sees the "job done" photo after payout and during a dispute.

Tested end to end in the user's hands: signup/login, profile, post job with photo, bid, messaging, accept + pay with test card 4242…, mark done with photo, approve & release, rating, reminder email, worker payout onboarding (Connect), and automatic payout to the worker on approval ("Moving furniture" €40 → €36 transferred 2 s after approval, 18 Oct). The earlier stuck €54 was also paid. Premium subscription (Nay, €4.99, renews 18 Nov), Boost ("Dog walking", €1.99 → Featured 48h) the 6% Premium fee (€30 job → €1.80 fee → €28.20 transferred to Nay) and a Premium poster's job auto-Featured ("Walking dog") all tested 18 Oct.

Clean-up done 19 Oct: test task, `public.site_pages` table and Storage bucket `site` deleted (only the `media` bucket remains — job photos). Deletes from chat time out (Supabase holds them for a confirmation); have the user run them in the SQL Editor or dashboard.

Test accounts: `natbooth252@gmail.com` (poster) and `natbooth252+worker@gmail.com` (worker, name "Nay").

## To-do, most important first
0. **App Store**: Apple Developer account, native wrapper (Capacitor + cloud build), Apple in-app purchase for Premium/Boost if wanted — full list in `APP-STORE.md`.
1. **Domain** for Resend so reminder emails reach real users; then set `EMAIL_FROM`.
2. Fill the yellow placeholders in terms.html / privacy.html (name, address, contact email once the domain exists, VAT if registered).
3. Before launch (legal/business, outside the code): solicitor review of terms.html + privacy.html; consider forming a Ltd company; public liability insurance for OnCall; register with Revenue as a DAC7 reporting platform operator and collect workers' tax numbers (PPSN/TIN) + date of birth + address before payouts; accept Supabase's and Resend's data processing agreements; ask workers whether they act as a business ("trader") and show that to posters; check reports in Supabase → reports and reply to reporters.
4. Before launch (code): switch the map tiles and place search from free OpenStreetMap servers to a paid provider (usage policy); switch Stripe to live keys; card holds expire after ~7 days — handle jobs not finished in time (re-authorise or cancel); a manual verification route for people who can't use the online ID check; Stripe webhook so a paid Boost is applied even if the poster never returns.

## How to ship changes
Edit `index.html` and copy the same content to `oncall-mvp.html`, commit to `main`; GitHub Pages republishes in ~1 minute. Edge Function and database changes must be deployed to Supabase separately (they are not auto-deployed from this repo).
