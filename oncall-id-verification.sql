-- ============================================================
-- OnCall — ID + age verification (Stripe Identity)
-- Applied 24 Oct 2026 via Supabase (migration name: id_verification).
-- Run AFTER oncall-travel-zone.sql.
-- ============================================================
-- Everyone must pass a Stripe Identity check (ID document + matching selfie) and
-- be 18+ before posting a job or bidding. We store only the outcome — never the
-- date of birth or the images, which stay with Stripe.
alter table public.profiles add column if not exists id_status text not null default 'none';
alter table public.profiles add column if not exists id_session_id text;
alter table public.profiles add column if not exists id_verified_at timestamptz;
alter table public.profiles add column if not exists id_error text;
alter table public.profiles add column if not exists id_attempts int not null default 0;
alter table public.profiles add constraint profiles_id_status_check
  check (id_status in ('none','pending','processing','verified','failed','under_18'));

-- New profiles always start unverified; only the server (service role) can change these.
create or replace function public.protect_new_profile()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.verified := false;
  new.id_status := 'none';
  new.id_session_id := null;
  new.id_verified_at := null;
  new.id_error := null;
  new.id_attempts := 0;
  new.premium := false;
  new.premium_until := null;
  return new;
end $$;
create trigger protect_new_profile before insert on public.profiles
  for each row execute function public.protect_new_profile();

-- Is this user an ID-verified adult?
create or replace function public.is_verified_adult(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = uid and p.verified and p.id_status = 'verified');
$$;
revoke all on function public.is_verified_adult(uuid) from public, anon;
grant execute on function public.is_verified_adult(uuid) to authenticated, service_role;

-- Only ID-verified adults can post jobs or place bids (added on top of the existing rules).
create policy "only ID-verified adults can post jobs" on public.tasks
  as restrictive for insert to authenticated
  with check (public.is_verified_adult(auth.uid()));
create policy "only ID-verified adults can bid" on public.bids
  as restrictive for insert to authenticated
  with check (public.is_verified_adult(auth.uid()));

-- Existing accounts: any old self-ticked "verified" flag is cleared; they verify properly.
update public.profiles set verified = false where id_status <> 'verified';
