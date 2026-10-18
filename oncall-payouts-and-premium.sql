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

-- ---------- Premium subscription (18 Oct 2026, migration name: premium_subscription) ----------
-- Premium is now a real €4.99/month Stripe subscription. Only the Edge Function
-- sets premium / premium_until (from Stripe); clients still can't write them.
alter table public.profiles add column if not exists premium_until timestamptz;

-- ---------- Featured jobs & Boost (18 Oct 2026, migration name: featured_jobs) ----------
-- featured_until: job is pinned at the top of Home until then. Set only by the
-- server: this trigger (Premium posters, 48h) or the Edge Function (paid €1.99 Boost).
alter table public.tasks add column if not exists featured_until timestamptz;
alter table public.tasks add column if not exists boost_session_id text;

-- New jobs: lifecycle/money fields always start blank (the app may only send the
-- form fields), and a Premium poster's job is Featured for 48 hours.
create or replace function public.prepare_new_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.accepted_bid_id := null;
  new.completed := false;
  new.worker_completed_at := null;
  new.completion_photo_url := null;
  new.auto_release_at := null;
  new.auto_released := false;
  new.disputed := false;
  new.dispute_note := null;
  new.rated := false;
  new.reminder_sent_at := null;
  new.boost_session_id := null;
  new.featured_until := case
    when exists (select 1 from public.profiles p where p.id = new.poster_id and p.premium)
    then now() + interval '48 hours' else null end;
  return new;
end $$;

drop trigger if exists prepare_new_task on public.tasks;
create trigger prepare_new_task before insert on public.tasks
  for each row execute function public.prepare_new_task();
