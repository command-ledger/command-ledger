-- DRAFT v2, NOT APPLIED. Differs from the first draft in two checks, marked (v2). Correction plan, revision 4: defect 8 (D3a, D3b), Phase 4.
-- Tax and VAT are set only by the founder. Nothing here has a default: a
-- default would label a business registered, or unregistered, without asking.
--
-- 1. Three new kinds a founder can give a payment to or from SARS:
--      income_tax_current  income tax for the current tax year (provisional payments)
--      income_tax_prior    income tax for an earlier tax year
--      vat                 VAT paid to, or refunded by, SARS
--    PAYE, UIF and SDL stay payroll costs, and every other SARS payment stays
--    a cost, so neither needs a kind.
-- 2. Income tax is marked one payment at a time, because each payment can
--    belong to a different tax year: an income tax rule must have scope 'single'.
-- 3. A VAT class on a rule, for a VAT-registered business. Money in:
--    standard, zero_rated, exempt. A cost: claimable, not_claimable, no_vat,
--    partly_claimable. A class applies to revenue or a cost, and to a refund of
--    one (v2): a refund of a standard-rated sale carries VAT too, and with no
--    class it would be counted whole against a sale counted without its VAT.
-- 4. profiles: whether the business is registered for VAT and from what date,
--    and the month its financial year ends. A registered business must give
--    the date (v2): receipts before it are never divided, so without it the
--    app could not tell which receipts carry VAT.

alter table public.transaction_rules drop constraint if exists transaction_rules_kind_check;
alter table public.transaction_rules add constraint transaction_rules_kind_check
  check (kind in ('operating', 'transfer', 'financing', 'refund', 'income_tax_current', 'income_tax_prior', 'vat'));

alter table public.transaction_rules drop constraint if exists transaction_rules_income_tax_single;
alter table public.transaction_rules add constraint transaction_rules_income_tax_single
  check (kind not in ('income_tax_current', 'income_tax_prior') or scope = 'single');

alter table public.transaction_rules add column if not exists vat_class text;
alter table public.transaction_rules drop constraint if exists transaction_rules_vat_class_check;
alter table public.transaction_rules add constraint transaction_rules_vat_class_check
  check (vat_class is null or (kind in ('operating', 'refund')
    and vat_class in ('standard', 'zero_rated', 'exempt', 'claimable', 'not_claimable', 'no_vat', 'partly_claimable')));

alter table public.profiles add column if not exists vat_registered boolean;
alter table public.profiles add column if not exists vat_registered_from date;
alter table public.profiles add column if not exists financial_year_end_month smallint;

alter table public.profiles drop constraint if exists profiles_vat_registered_from_check;
alter table public.profiles add constraint profiles_vat_registered_from_check
  check ((vat_registered is true and vat_registered_from is not null)
      or (vat_registered is not true and vat_registered_from is null));
alter table public.profiles drop constraint if exists profiles_financial_year_end_month_check;
alter table public.profiles add constraint profiles_financial_year_end_month_check
  check (financial_year_end_month is null or financial_year_end_month between 1 and 12);
