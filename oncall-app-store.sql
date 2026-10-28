-- ============================================================
-- OnCall — App Store requirements: block users + delete account
-- Applied 28 Oct 2026 via Supabase (migration name: block_users_and_account_deletion).
-- Run AFTER oncall-id-verification.sql.
-- ============================================================

-- ---------- 1. Block users (Apple guideline 1.2: apps with user content must let people block) ----------
-- A block works both ways: neither person can bid on the other's jobs or message them.
create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;
revoke all on public.blocks from anon, authenticated;
grant select, insert, delete on public.blocks to authenticated;
grant all on public.blocks to service_role;

create policy "see the people you blocked" on public.blocks
  for select to authenticated using (blocker_id = auth.uid());
create policy "block someone" on public.blocks
  for insert to authenticated with check (blocker_id = auth.uid());
create policy "unblock someone" on public.blocks
  for delete to authenticated using (blocker_id = auth.uid());

create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
revoke all on function public.is_blocked_between(uuid, uuid) from public, anon;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated, service_role;

create policy "no messages between blocked people" on public.messages
  as restrictive for insert to authenticated
  with check (not public.is_blocked_between(auth.uid(), recipient_id));

create policy "no bids between blocked people" on public.bids
  as restrictive for insert to authenticated
  with check (not public.is_blocked_between(auth.uid(),
    (select t.poster_id from public.tasks t where t.id = task_id)));

-- ---------- 2. Delete account (Apple guideline 5.1.1(v)) ----------
-- The Edge Function (action delete_account) deletes the login and personal data.
-- Where finished jobs, payments, reviews or reports must be kept (Privacy Policy
-- section 6), the profile row stays as an anonymous "Deleted user". For that the
-- profile must be able to outlive its login, so the cascade from auth.users goes.
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles add column if not exists deleted_at timestamptz;
