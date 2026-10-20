-- ============================================================
-- OnCall — content reports (EU Digital Services Act notice & action)
-- Applied 20 Oct 2026 via Supabase (migration name: content_reports).
-- Run AFTER oncall-payouts-and-premium.sql.
-- ============================================================
-- Reports of illegal content / rule breaks from the in-app "Report" buttons.
-- Written only by the Edge Function (action submit_report), which also emails
-- the owner. Users can't read or change reports. Review them in the Supabase
-- Table Editor; set status to 'actioned' or 'dismissed' and add a decision_note.
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id),
  kind text not null check (kind in ('task','user')),
  task_id uuid references public.tasks(id),
  reported_user_id uuid references public.profiles(id),
  reason text not null,
  status text not null default 'open' check (status in ('open','actioned','dismissed')),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant all on public.reports to service_role;
