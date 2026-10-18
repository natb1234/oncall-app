-- ============================================================
-- OnCall — Stage 1 migration (run this AFTER oncall-schema.sql)
-- ============================================================
-- Run this once in Supabase SQL Editor before testing the updated
-- oncall-mvp.html. It does three things:
--
--   1. Adds a free-text budget field to tasks (the "Budget" field on
--      the Post Job screen is a single text box like "€80-120", not
--      two separate numbers).
--
--   2. Fixes a real bug in the original messages design: it only
--      scoped a conversation by job, not by who's actually talking to
--      who. With more than one bidder on a job, everyone would've
--      been dumped into one shared thread and could read each
--      other's private messages with the poster. This adds a proper
--      recipient to every message so each conversation is private
--      between exactly two people.
--
--   3. Creates the storage bucket job photos/videos upload into, with
--      public read access and upload access restricted to signed-in
--      users uploading into their own folder.
-- ============================================================

-- ---------- 1. free-text budget ----------
alter table public.tasks add column if not exists budget_text text;
grant update (budget_text) on public.tasks to authenticated;

-- ---------- 2. real sender/recipient on messages ----------
alter table public.messages add column if not exists recipient_id uuid references public.profiles(id);

drop policy if exists "thread visible to the poster and bidders" on public.messages;
drop policy if exists "poster or bidder can send a message" on public.messages;

create policy "messages visible to sender or recipient"
  on public.messages for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- A message is only allowed between a job's poster and one of that
-- job's bidders — never between two strangers, and never broadcast to
-- everyone who bid.
create policy "messages only between a job's poster and a bidder on it"
  on public.messages for insert
  with check (
    auth.uid() = sender_id
    and (
      exists (
        select 1 from public.tasks t
        where t.id = messages.task_id and t.poster_id = auth.uid()
          and exists (select 1 from public.bids b where b.task_id = t.id and b.worker_id = messages.recipient_id)
      )
      or exists (
        select 1 from public.bids b
        where b.task_id = messages.task_id and b.worker_id = auth.uid()
          and exists (select 1 from public.tasks t where t.id = messages.task_id and t.poster_id = messages.recipient_id)
      )
    )
  );

-- ---------- 3. storage bucket for job photos/videos ----------
insert into storage.buckets (id, name, public)
  values ('media', 'media', true)
  on conflict (id) do nothing;

drop policy if exists "media is publicly readable" on storage.objects;
create policy "media is publicly readable"
  on storage.objects for select
  using (bucket_id = 'media');

drop policy if exists "signed-in users can upload to their own folder" on storage.objects;
create policy "signed-in users can upload to their own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'media'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
