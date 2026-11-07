-- Verified imports: every upload keeps how its file was judged, so the status
-- survives a refresh, a new sign-in and every recalculation.
--
--   import_status          accepted. A rejected file is never saved.
--   reconciliation_status  verified or not_reconciled. A failed file is never
--                          saved, so 'failed' is allowed only for completeness.
--   reconciliation_detail  format, rows left out, opening and closing balances
--                          and warnings, as shown on the review screen.
--   account_label          the bank account the founder named. It keeps the
--                          same fee on two accounts from matching as a duplicate.
--
-- All four are nullable and existing rows are not touched: an upload from before
-- these checks reads as not reconciled, because nothing proved it. RLS on
-- upload_batches already limits every column to its owner.
--
-- Apply this before deploying the code that writes these columns, or every
-- upload is refused.

alter table public.upload_batches
  add column if not exists import_status text,
  add column if not exists reconciliation_status text,
  add column if not exists reconciliation_detail jsonb,
  add column if not exists account_label text;

alter table public.upload_batches
  add constraint upload_batches_import_status_check
    check (import_status is null or import_status = 'accepted'),
  add constraint upload_batches_reconciliation_status_check
    check (reconciliation_status is null or reconciliation_status in ('verified', 'not_reconciled', 'failed')),
  add constraint upload_batches_account_label_check
    check (account_label is null or char_length(account_label) <= 120);
