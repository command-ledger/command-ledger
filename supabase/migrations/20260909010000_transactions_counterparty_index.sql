-- Revenue concentration by real paying counterparty.
--
-- `transactions.counterparty` already existed in the schema but was never
-- populated (see 20260908004436_transaction_event_store.sql) — the upload
-- path now fills it in for every positive-amount transaction, extracted
-- client-side from the transaction description (src/lib/financials.js,
-- extractCounterparty). This index supports querying/aggregating by
-- counterparty at scale, the same way transactions_user_date_idx already
-- does for txn_date.
create index if not exists transactions_user_counterparty_idx
  on public.transactions (user_id, counterparty);
