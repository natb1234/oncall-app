-- ============================================================
-- OnCall — public hosting bucket
-- ============================================================
-- This creates a public storage bucket called "site" that can host the
-- actual oncall-mvp.html file at a real https:// address, so it's a
-- genuine website instead of a file opened locally. A file opened
-- locally in Safari ("file://...") is blocked from making real network
-- requests to Supabase — that's the "Load failed" error. A page served
-- from a real https:// address doesn't have that restriction.
--
-- After running this, upload oncall-mvp.html into the new "site" bucket
-- from the Supabase Storage screen, and open it at:
--   https://vwezewdobyyqrbflllmg.supabase.co/storage/v1/object/public/site/oncall-mvp.html
-- ============================================================

insert into storage.buckets (id, name, public)
  values ('site', 'site', true)
  on conflict (id) do nothing;

drop policy if exists "site files are publicly readable" on storage.objects;
create policy "site files are publicly readable"
  on storage.objects for select
  using (bucket_id = 'site');
