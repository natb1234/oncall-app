-- ============================================================
-- OnCall — Supabase schema (v1)
-- ============================================================
-- Security model:
--   * Row Level Security (RLS) is ON for every table.
--   * Signed-in users (the "authenticated" role) can only read/write
--     what's safe for them to control directly — editing their own
--     profile, posting a job, placing a bid, sending a message.
--   * Anything that moves money or finalises a job's state (accepting
--     a bid, marking a job complete, approving release, auto-release,
--     filing a dispute) is NEVER written directly by the client.
--     Those columns have no UPDATE grant for ordinary users at all —
--     only the Edge Functions can change them, because those run with
--     the secret service_role key (never shipped to the browser) and
--     so bypass RLS entirely.
--   This is what stops someone opening devtools and just setting
--   `completed = true` to skip paying, which the in-memory prototype
--   could never actually prevent.
-- ============================================================

create extension if not exists "pgcrypto";

-- Baseline schema access. RLS policies only take effect on top of an
-- existing SQL-level privilege — without a GRANT, no row is visible or
-- writable at all regardless of policy. Each table below gets its own
-- explicit grant right after it's created (not relied on as a platform
-- default), so this schema is correct standalone.
grant usage on schema public to anon, authenticated, service_role;

-- ---------- profiles ----------
-- One row per signed-up person. Same unified model as the prototype —
-- anyone can post a job or bid on one, no separate account types.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  trade text,
  experience text,
  skills text[] not null default '{}',
  has_sample boolean not null default false,
  verified boolean not null default false,
  radius_km int not null default 15,
  premium boolean not null default false,
  stripe_connect_account_id text,      -- set only by Edge Functions once worker onboarding completes
  stripe_customer_id text,             -- set only by Edge Functions once a poster saves a card
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
grant select, insert on public.profiles to anon, authenticated;
grant all on public.profiles to service_role;

create policy "profiles are publicly readable"
  on public.profiles for select
  using (true);

create policy "users can create their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

revoke update on public.profiles from authenticated;
grant update (name, trade, experience, skills, has_sample, radius_km, premium)
  on public.profiles to authenticated;


-- ---------- tasks ----------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  poster_id uuid not null references public.profiles(id),
  title text not null,
  category text not null,
  budget_min numeric,
  budget_max numeric,
  location text,
  description text,
  media_url text,
  media_type text,                      -- 'image' | 'video'

  -- money / lifecycle fields — never writable directly by clients (see grants below)
  accepted_bid_id uuid,
  worker_completed_at timestamptz,
  completion_photo_url text,
  completed boolean not null default false,
  auto_release_at timestamptz,
  auto_released boolean not null default false,
  disputed boolean not null default false,
  dispute_note text,
  rated boolean not null default false,

  created_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
grant select, insert on public.tasks to anon, authenticated;
grant all on public.tasks to service_role;

create policy "tasks are publicly readable"
  on public.tasks for select
  using (true);

create policy "signed-in users can post a task"
  on public.tasks for insert
  with check (auth.uid() = poster_id);

create policy "poster can edit their own task listing"
  on public.tasks for update
  using (auth.uid() = poster_id);

revoke update on public.tasks from authenticated;
-- Only the plain listing fields are directly editable by the poster.
-- accepted_bid_id, completed, worker_completed_at, completion_photo_url,
-- auto_release_at, auto_released, disputed, dispute_note, rated are
-- deliberately left out of this grant — only Edge Functions set them.
grant update (title, category, budget_min, budget_max, location, description, media_url, media_type)
  on public.tasks to authenticated;


-- ---------- bids ----------
create table public.bids (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  worker_id uuid not null references public.profiles(id),
  price numeric not null,
  note text,
  premium boolean not null default false,
  created_at timestamptz not null default now(),
  unique (task_id, worker_id)            -- one bid per person per job, same as the prototype
);

alter table public.bids enable row level security;
grant select, insert, delete on public.bids to anon, authenticated;
grant all on public.bids to service_role;

create policy "bids are publicly readable"
  on public.bids for select
  using (true);

create policy "signed-in users can place their own bid"
  on public.bids for insert
  with check (auth.uid() = worker_id);

create policy "workers can withdraw their own unaccepted bid"
  on public.bids for delete
  using (
    auth.uid() = worker_id
    and not exists (
      select 1 from public.tasks t
      where t.id = bids.task_id and t.accepted_bid_id = bids.id
    )
  );

alter table public.tasks
  add constraint tasks_accepted_bid_fk
  foreign key (accepted_bid_id) references public.bids(id);

create index on public.bids (task_id);
create index on public.bids (worker_id);


-- ---------- messages ----------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;
grant select, insert on public.messages to anon, authenticated;
grant all on public.messages to service_role;

-- Visible to the poster and anyone who has bid on that job.
create policy "thread visible to the poster and bidders"
  on public.messages for select
  using (
    exists (select 1 from public.tasks t where t.id = messages.task_id and t.poster_id = auth.uid())
    or exists (select 1 from public.bids b where b.task_id = messages.task_id and b.worker_id = auth.uid())
  );

create policy "poster or bidder can send a message"
  on public.messages for insert
  with check (
    auth.uid() = sender_id
    and (
      exists (select 1 from public.tasks t where t.id = messages.task_id and t.poster_id = auth.uid())
      or exists (select 1 from public.bids b where b.task_id = messages.task_id and b.worker_id = auth.uid())
    )
  );

create index on public.messages (task_id);


-- ---------- reviews ----------
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id),
  reviewer_id uuid not null references public.profiles(id),
  reviewee_id uuid not null references public.profiles(id),
  rating int not null check (rating between 1 and 5),
  text text,
  created_at timestamptz not null default now(),
  unique (task_id, reviewer_id)
);

alter table public.reviews enable row level security;
grant select on public.reviews to anon, authenticated;
grant all on public.reviews to service_role;

create policy "reviews are publicly readable"
  on public.reviews for select
  using (true);

-- No insert policy for `authenticated` on purpose: a review is only ever
-- written by the mark-job-complete Edge Function, which already knows
-- the job genuinely finished. A client can't post a fake 5-star review.


-- ---------- payments ----------
-- Local mirror of the Stripe PaymentIntent for a job, so the app can show
-- status without calling Stripe directly. Entirely owned by Edge Functions.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references public.tasks(id),
  stripe_payment_intent_id text not null,
  amount numeric not null,
  platform_fee numeric not null,
  status text not null check (status in ('held','released','refunded')),
  created_at timestamptz not null default now(),
  released_at timestamptz
);

alter table public.payments enable row level security;
grant select on public.payments to anon, authenticated;
grant all on public.payments to service_role;

create policy "payments visible to the poster and the accepted worker"
  on public.payments for select
  using (
    exists (
      select 1 from public.tasks t
      where t.id = payments.task_id
        and (
          t.poster_id = auth.uid()
          or exists (select 1 from public.bids b where b.id = t.accepted_bid_id and b.worker_id = auth.uid())
        )
    )
  );
-- No insert/update policy for `authenticated` — only Edge Functions write here.
