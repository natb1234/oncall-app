-- ============================================================
-- OnCall — travel zone (Facebook-Marketplace-style distance search)
-- Applied 24 Oct 2026 via Supabase (migration name: travel_zone).
-- Run AFTER oncall-legal-and-reports.sql.
-- ============================================================
-- Approximate job location, and each user's search area (centre + radius).
alter table public.tasks add column if not exists lat double precision;
alter table public.tasks add column if not exists lng double precision;
alter table public.profiles add column if not exists area_lat double precision;
alter table public.profiles add column if not exists area_lng double precision;
alter table public.profiles add column if not exists area_label text;
grant update (area_lat, area_lng, area_label) on public.profiles to authenticated;

-- Privacy: locations are only ever stored to 2 decimal places (about 1 km).
create or replace function public.round_coord(v double precision, maxabs double precision)
returns double precision language sql immutable set search_path = '' as $$
  select case when v is null or abs(v) > maxabs then null else round(v::numeric, 2)::double precision end;
$$;

-- New jobs: same as before (lifecycle/money fields reset, Premium → Featured 48h),
-- plus job coordinates rounded to ~1 km.
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
  new.lat := public.round_coord(new.lat, 90);
  new.lng := public.round_coord(new.lng, 180);
  return new;
end $$;

-- Profiles: search-area centre rounded to ~1 km, radius kept between 1 and 500 km.
create or replace function public.round_profile_area()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.area_lat := public.round_coord(new.area_lat, 90);
  new.area_lng := public.round_coord(new.area_lng, 180);
  new.area_label := left(new.area_label, 80);
  if new.radius_km is null or new.radius_km < 1 then new.radius_km := 1; end if;
  if new.radius_km > 500 then new.radius_km := 500; end if;
  return new;
end $$;

create trigger round_profile_area before insert or update on public.profiles
  for each row execute function public.round_profile_area();
