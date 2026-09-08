-- Forward cash calendar: recurring obligations detected from transaction
-- history (src/lib/financials.js, detectRecurringObligations), persisted
-- so the founder can see and manage them (mark one inactive once it's
-- ended) rather than having them silently recomputed and forgotten every
-- session.
--
-- Design notes:
--   - Detection itself is a pure, stateless function over raw transactions
--     — this table is a cache/management layer on top of that, not a
--     second source of truth. Re-running detection and upserting keeps it
--     current; nothing here is hand-maintained except the `active` flag.
--   - `active` defaults true but can be set false by the founder (an
--     obligation that's ended) or automatically by the detector (a pattern
--     gone quiet for more than 2 cadence periods) — either way, marking it
--     inactive excludes it from forward projections without deleting the
--     detection history.

create table if not exists public.recurring_obligations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  label           text not null,
  category        text,
  cadence         text not null check (cadence in ('weekly','monthly','quarterly','annual')),
  typical_amount  numeric(14,2) not null,
  amount_variance text not null check (amount_variance in ('fixed','variable')),
  day_of_month    int,
  last_seen       date not null,
  next_expected   date not null,
  occurrences     int not null,
  confidence      text not null check (confidence in ('low','moderate','high')),
  active          boolean not null default true,
  normalized_key  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, normalized_key)
);

create index if not exists recurring_obligations_user_active_idx
  on public.recurring_obligations (user_id, active);
create index if not exists recurring_obligations_user_next_expected_idx
  on public.recurring_obligations (user_id, next_expected);

alter table public.recurring_obligations enable row level security;

drop policy if exists recurring_obligations_select_own on public.recurring_obligations;
create policy recurring_obligations_select_own on public.recurring_obligations for select using (auth.uid() = user_id);

drop policy if exists recurring_obligations_insert_own on public.recurring_obligations;
create policy recurring_obligations_insert_own on public.recurring_obligations for insert with check (auth.uid() = user_id);

drop policy if exists recurring_obligations_update_own on public.recurring_obligations;
create policy recurring_obligations_update_own on public.recurring_obligations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists recurring_obligations_delete_own on public.recurring_obligations;
create policy recurring_obligations_delete_own on public.recurring_obligations for delete using (auth.uid() = user_id);
