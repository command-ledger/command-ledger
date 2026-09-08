-- Financial Memory Engine: immutable transaction event store.
--
-- Replaces the previous "parse a CSV, hold it in React state, discard on
-- refresh" model. Uploads become append-only batches of transaction events;
-- history accumulates across sessions instead of resetting every upload.
--
-- Design notes:
--   - `transactions` stores individual, signed ledger events (positive =
--     inflow, negative = outflow) — never a pre-computed monthly total.
--     Every dashboard metric is derived from this table on read.
--   - `dedupe_hash` = SHA-256 of `txn_date | normalized_description | amount`,
--     computed client-side. The unique constraint on (user_id, dedupe_hash)
--     plus `ON CONFLICT ... DO NOTHING` on insert makes re-uploading an
--     overlapping date range (e.g. Jan-Jun, then Apr-Sep) silently
--     idempotent instead of double-counting April-June.
--   - `upload_batches` is the audit trail: which file, when, how much of it
--     was new vs. already on file. Deleting a batch cascades to delete only
--     the transactions that came from it.

create table if not exists public.upload_batches (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  filename        text,
  uploaded_at     timestamptz not null default now(),
  row_count       int,
  inserted_count  int,
  duplicate_count int,
  period_start    date,
  period_end      date,
  parser_mode     text
);

create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  txn_date        date not null,
  description     text not null,
  amount          numeric(14,2) not null,
  category        text,
  counterparty    text,
  source_batch_id uuid not null references public.upload_batches(id) on delete cascade,
  dedupe_hash     text not null,
  created_at      timestamptz not null default now(),
  unique (user_id, dedupe_hash)
);

create index if not exists transactions_user_date_idx on public.transactions (user_id, txn_date);
create index if not exists upload_batches_user_idx on public.upload_batches (user_id, uploaded_at);

alter table public.upload_batches enable row level security;
alter table public.transactions   enable row level security;

drop policy if exists upload_batches_select_own on public.upload_batches;
create policy upload_batches_select_own on public.upload_batches for select using (auth.uid() = user_id);

drop policy if exists upload_batches_insert_own on public.upload_batches;
create policy upload_batches_insert_own on public.upload_batches for insert with check (auth.uid() = user_id);

drop policy if exists upload_batches_update_own on public.upload_batches;
create policy upload_batches_update_own on public.upload_batches for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists upload_batches_delete_own on public.upload_batches;
create policy upload_batches_delete_own on public.upload_batches for delete using (auth.uid() = user_id);

drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own on public.transactions for select using (auth.uid() = user_id);

drop policy if exists transactions_insert_own on public.transactions;
create policy transactions_insert_own on public.transactions for insert with check (auth.uid() = user_id);

drop policy if exists transactions_delete_own on public.transactions;
create policy transactions_delete_own on public.transactions for delete using (auth.uid() = user_id);
