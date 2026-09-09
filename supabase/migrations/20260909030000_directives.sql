-- Decision Log: every directive Command Ledger issues, whether the founder
-- acted on it, and what happened to the metric it targeted afterward.
--
-- Design notes:
--   - One row per DISTINCT directive, not per page load — the client only
--     inserts when the freshly-computed directive (src/lib/financials.js,
--     computeDirective) differs from the most recent stored row for that
--     user (src/App.jsx checks this before inserting).
--   - `outcome_metric`/`outcome_at` stay null until 60 days after
--     `issued_at` have passed; a client-side pass fills them in by
--     recomputing `target_metric`'s current value once that window has
--     elapsed. Never computed early — "pending" is the honest answer
--     before then, not a guess.
--   - `acknowledged_at`/`action_taken`/`founder_note` are set once, by the
--     one-time "did you act on it?" prompt shown starting 7 days after
--     issue. A founder's answer is never re-asked or overwritten.

create table if not exists public.directives (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  issued_at       timestamptz not null default now(),
  directive_text  text not null,
  reason_text     text not null,
  severity        text not null check (severity in ('critical','warn','go','stable')),
  trigger_rule    text not null,
  target_metric   text,
  metric_at_issue numeric(14,2),
  snapshot        jsonb,
  acknowledged_at timestamptz,
  action_taken    text check (action_taken in ('acted','partially','ignored','disagreed')),
  founder_note    text,
  outcome_metric  numeric(14,2),
  outcome_at      timestamptz
);

create index if not exists directives_user_issued_idx on public.directives (user_id, issued_at desc);
create index if not exists directives_pending_outcome_idx on public.directives (user_id, outcome_at) where outcome_metric is null;

alter table public.directives enable row level security;

drop policy if exists directives_select_own on public.directives;
create policy directives_select_own on public.directives for select using (auth.uid() = user_id);

drop policy if exists directives_insert_own on public.directives;
create policy directives_insert_own on public.directives for insert with check (auth.uid() = user_id);

drop policy if exists directives_update_own on public.directives;
create policy directives_update_own on public.directives for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists directives_delete_own on public.directives;
create policy directives_delete_own on public.directives for delete using (auth.uid() = user_id);
