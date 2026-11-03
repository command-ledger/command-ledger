-- Cash balance: saved and dated, instead of a field that was lost on refresh.
--
-- Runway needs the cash in the bank. It comes from two places, and
-- src/lib/financials.js (effectiveCashBalance) uses the newest:
--   profiles.cash_balance*        a balance the founder enters, the date it
--                                 was true, and its currency. All three or
--                                 none. Below zero is an overdraft.
--   upload_batches.closing_balance*  the balance after the last transaction
--                                 of a file with a Balance column, and its
--                                 date. Its currency is the upload's own.
-- A balance in a currency other than the business currency is never used,
-- because amounts are never converted.

alter table public.profiles add column if not exists cash_balance numeric(14,2);
alter table public.profiles add column if not exists cash_balance_on date;
alter table public.profiles add column if not exists cash_balance_currency text;

alter table public.profiles drop constraint if exists profiles_cash_balance_currency_check;
alter table public.profiles add constraint profiles_cash_balance_currency_check
  check (cash_balance_currency is null or cash_balance_currency ~ '^[A-Z]{3}$');
alter table public.profiles drop constraint if exists profiles_cash_balance_complete;
alter table public.profiles add constraint profiles_cash_balance_complete check (
  (cash_balance is null and cash_balance_on is null and cash_balance_currency is null)
  or (cash_balance is not null and cash_balance_on is not null and cash_balance_currency is not null)
);

alter table public.upload_batches add column if not exists closing_balance numeric(14,2);
alter table public.upload_batches add column if not exists closing_balance_on date;

alter table public.upload_batches drop constraint if exists upload_batches_closing_balance_complete;
alter table public.upload_batches add constraint upload_batches_closing_balance_complete
  check ((closing_balance is null) = (closing_balance_on is null));

notify pgrst, 'reload schema';
