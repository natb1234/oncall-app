-- ============================================================
-- OnCall — worker payouts catch-up + Premium switched off
-- Applied 18 Oct 2026 via Supabase (migration name: payouts_and_premium_off).
-- Run AFTER oncall-timer-and-reminders.sql.
-- ============================================================

-- Record the Stripe transfer that paid the worker, so a job is never paid twice
-- and jobs released before the worker set up payouts can be paid later.
alter table public.payments add column if not exists payout_transfer_id text;
alter table public.payments add column if not exists paid_out_at timestamptz;

-- Premium is hidden in the app until it's a real paid subscription.
-- Stop the app (or anyone with the public key) from switching it on for free.
revoke update (premium) on public.profiles from authenticated;
update public.profiles set premium = false where premium;
