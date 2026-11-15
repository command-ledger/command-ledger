-- Account answers: what the founder has told Command Ledger about an account,
-- which the uploads themselves cannot establish (correction plan, revision 4:
-- D10a and D10c; Phase 1, task 2).
--
-- No upload records a statement period: upload_batches.period_start,
-- period_end and closing_balance_on are transaction dates. So the app cannot
-- tell a month with no transactions from a month nobody uploaded, or a closed
-- account from one whose statements simply stopped. These rows hold the
-- founder's own answers. They never become a figure by themselves; the app
-- applies every other rule as well.
--
-- WHICH ACCOUNT A ROW IS ABOUT (account_key)
--   A named account: accountKey() of the name given at upload
--     (src/lib/financials.js): lower case, only a-z, 0-9, _ and spaces, at
--     most 80 characters. It cannot contain a colon.
--   An upload with no usable name: 'upload:' followed by that upload's id,
--     with batch_id set to the same upload. Unnamed uploads are never grouped
--     with each other by assumption, because nothing in the data says which
--     bank account an unnamed file came from. The founder links them with a
--     'same_as' answer. Every new upload must be named (the review screen
--     requires it), so only older uploads are unnamed; a name made only of
--     punctuation also has no usable key and is treated the same way.
--
-- NO ROW MEANS UNRESOLVED, NEVER CLOSED
--   An account with no 'status' row is unresolved: its identity, and whether
--   it is still open, are unknown. It is not closed and not linked; its
--   missing months stay gaps and the founder is asked. An older unnamed upload
--   with no answer is unresolved in exactly this way. Only the founder's own
--   answer creates a row: kind has no default, no trigger inserts rows, and
--   'closed' always carries the date the founder gave (closed_on is required).
--
-- WHAT THE ANSWER IS (kind, one row per answer)
--   'closed'                 The account closed. It is expected in no month
--                            after closed_on's month.
--   'same_as'                The same bank account as same_as_key. The two
--                            histories are read as one.
--   'still_open'             Still open; its statements will be uploaded. Its
--                            missing months stay gaps; the question is not
--                            asked again.
--   'no_transactions_month'  The founder confirms the account had no
--                            transactions in month. The confirmation is the
--                            evidence. Balances are supporting evidence only:
--                            a balance that moved across the month contradicts
--                            the confirmation and the app refuses it, and
--                            matching balances never establish a month with no
--                            transactions on their own (R10,000 in and R10,000
--                            out leaves the balance unchanged). Under the plan
--                            (D10a) the month counts as zero only when the
--                            founder has confirmed it and a verified balance
--                            is unchanged across it; with no balances to
--                            check, it stays a gap.
--
-- ONE ROW PER QUESTION (slot)
--   'status' for closed, same_as and still_open: one answer per account,
--   replaced when the founder changes it. 'month:YYYY-MM' for a
--   no-transactions month: one per account per month. A plain unique
--   constraint on (user_id, account_key, slot) is what the browser's upsert
--   targets (on_conflict=user_id,account_key,slot); a partial unique index
--   cannot be targeted through the REST API.

create table if not exists public.account_answers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  account_key  text not null,
  batch_id     uuid references public.upload_batches(id) on delete cascade,
  kind         text not null check (kind in ('closed', 'same_as', 'still_open', 'no_transactions_month')),
  slot         text not null,
  closed_on    date,
  same_as_key  text,
  month        date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, account_key, slot),

  -- A named key, or exactly 'upload:<batch_id>' for an unnamed upload.
  constraint account_answers_account_key check (
    (batch_id is null and account_key ~ '^[a-z0-9_ ]{1,80}$')
    or (batch_id is not null and account_key = 'upload:' || batch_id::text)
  ),

  -- The account it is the same as: a named key or an unnamed upload's key,
  -- never itself.
  constraint account_answers_same_as_key check (
    same_as_key is null
    or ((same_as_key ~ '^[a-z0-9_ ]{1,80}$'
         or same_as_key ~ '^upload:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        and same_as_key <> account_key)
  ),

  -- Each kind carries exactly the fields it needs, and its slot matches it.
  constraint account_answers_kind_fields check (
    case kind
      when 'closed'     then closed_on is not null and same_as_key is null and month is null and slot = 'status'
      when 'same_as'    then same_as_key is not null and closed_on is null and month is null and slot = 'status'
      when 'still_open' then closed_on is null and same_as_key is null and month is null and slot = 'status'
      when 'no_transactions_month'
                        then month is not null and extract(day from month) = 1
                             and closed_on is null and same_as_key is null
                             and slot = 'month:' || to_char(month, 'YYYY-MM')
      else false
    end
  )
);

create index if not exists account_answers_user_idx on public.account_answers (user_id);
create index if not exists account_answers_batch_idx on public.account_answers (batch_id) where batch_id is not null;

-- updated_at follows every change, whatever the client sends.
create or replace function public.account_answers_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists account_answers_touch on public.account_answers;
create trigger account_answers_touch
  before update on public.account_answers
  for each row execute function public.account_answers_touch();

-- Each founder reads and changes only their own answers. An answer about an
-- unnamed upload must name one of their own uploads.
alter table public.account_answers enable row level security;

drop policy if exists account_answers_select_own on public.account_answers;
create policy account_answers_select_own on public.account_answers for select
  using ((select auth.uid()) = user_id);

drop policy if exists account_answers_insert_own on public.account_answers;
create policy account_answers_insert_own on public.account_answers for insert
  with check (
    (select auth.uid()) = user_id
    and (batch_id is null or exists (
      select 1 from public.upload_batches b where b.id = batch_id and b.user_id = (select auth.uid())))
  );

drop policy if exists account_answers_update_own on public.account_answers;
create policy account_answers_update_own on public.account_answers for update
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (batch_id is null or exists (
      select 1 from public.upload_batches b where b.id = batch_id and b.user_id = (select auth.uid())))
  );

drop policy if exists account_answers_delete_own on public.account_answers;
create policy account_answers_delete_own on public.account_answers for delete
  using ((select auth.uid()) = user_id);
