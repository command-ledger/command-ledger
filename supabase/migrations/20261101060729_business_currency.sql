-- Business base currency, and the currency of every stored amount.
--
-- Until now no table recorded a currency: every amount was a bare number the
-- app printed with "$". This migration labels what exists and converts
-- nothing. No amount column is touched.
--
-- profiles.base_currency: the currency a business keeps its books in. Its
-- metrics are computed only from transactions in this currency. It has no
-- default, for the same reason profiles.plan has none: a default would
-- silently label a new South African business as USD. The app asks for it
-- before the first import. Profiles that already hold data are labelled USD,
-- because the app has only ever shown their amounts in dollars. Profiles with
-- no data stay NULL and are asked.
--
-- transactions / upload_batches / recurring_obligations / directives
-- .currency: the ISO 4217 code each row is in. Existing rows are labelled
-- USD. Transactions may hold any ISO code: a file can contain rows in another
-- currency, which are kept as they arrived and left out of the metrics.
--
-- To support a new base currency, widen profiles_base_currency_check here
-- BEFORE shipping the frontend that offers it (SUPPORTED_CURRENCIES in
-- src/lib/financials.js), or saving the choice fails.
--
-- Deploy order: apply this before the frontend that writes these columns.
-- The frontend still deployed when this lands sends no currency; the
-- fill_currency_from_profile trigger labels its rows with the owner's base
-- currency, so it keeps working unchanged.
--
-- Applied 2026-11-01. Before and after: 4,472 transactions summing
-- 2,793,624,929.93, 5 uploads, 10 obligations summing 39,711.05, 2
-- directives; 2 of 9 profiles held data and were labelled USD.

alter table public.profiles add column if not exists base_currency text;
alter table public.profiles drop constraint if exists profiles_base_currency_check;
alter table public.profiles add constraint profiles_base_currency_check
  check (base_currency is null or base_currency in ('USD','ZAR'));

update public.profiles p set base_currency = 'USD'
where p.base_currency is null and (
     exists (select 1 from public.transactions t where t.user_id = p.id)
  or exists (select 1 from public.upload_batches b where b.user_id = p.id)
  or exists (select 1 from public.recurring_obligations o where o.user_id = p.id)
  or exists (select 1 from public.directives d where d.user_id = p.id));

alter table public.transactions          add column if not exists currency text;
alter table public.upload_batches        add column if not exists currency text;
alter table public.recurring_obligations add column if not exists currency text;
alter table public.directives            add column if not exists currency text;

update public.transactions          set currency = 'USD' where currency is null;
update public.upload_batches        set currency = 'USD' where currency is null;
update public.recurring_obligations set currency = 'USD' where currency is null;
update public.directives            set currency = 'USD' where currency is null;

-- Fills a missing currency from the owner's base currency. A client that
-- sends no currency is the app from before this migration; for an owner who
-- has not chosen a base currency, that app showed every amount in dollars,
-- so its rows are labelled USD. The current app always sends a currency.
-- Runs as the caller: a user can only read their own profile, and RLS still
-- rejects a row inserted for someone else.
create or replace function public.fill_currency_from_profile()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.currency is null then
    select p.base_currency into new.currency from public.profiles p where p.id = new.user_id;
    if new.currency is null then
      new.currency := 'USD';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists fill_currency on public.transactions;
create trigger fill_currency before insert or update on public.transactions
  for each row execute function public.fill_currency_from_profile();
drop trigger if exists fill_currency on public.upload_batches;
create trigger fill_currency before insert or update on public.upload_batches
  for each row execute function public.fill_currency_from_profile();
drop trigger if exists fill_currency on public.recurring_obligations;
create trigger fill_currency before insert or update on public.recurring_obligations
  for each row execute function public.fill_currency_from_profile();
drop trigger if exists fill_currency on public.directives;
create trigger fill_currency before insert or update on public.directives
  for each row execute function public.fill_currency_from_profile();

alter table public.transactions          alter column currency set not null;
alter table public.upload_batches        alter column currency set not null;
alter table public.recurring_obligations alter column currency set not null;
alter table public.directives            alter column currency set not null;

alter table public.transactions drop constraint if exists transactions_currency_check;
alter table public.transactions add constraint transactions_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.upload_batches drop constraint if exists upload_batches_currency_check;
alter table public.upload_batches add constraint upload_batches_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.recurring_obligations drop constraint if exists recurring_obligations_currency_check;
alter table public.recurring_obligations add constraint recurring_obligations_currency_check check (currency ~ '^[A-Z]{3}$');
alter table public.directives drop constraint if exists directives_currency_check;
alter table public.directives add constraint directives_currency_check check (currency ~ '^[A-Z]{3}$');

notify pgrst, 'reload schema';
