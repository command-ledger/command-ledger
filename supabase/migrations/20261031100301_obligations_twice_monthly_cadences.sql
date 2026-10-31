-- Allow twice-a-month recurring obligations.
--
-- detectRecurringObligations() (src/lib/financials.js) only knew weekly,
-- monthly, quarterly and annual. Payroll is usually paid every two weeks
-- (biweekly) or on two fixed days of each month (semimonthly), whose
-- ~14-15 day gap fit none of those, so a business's largest committed cost
-- was missing from Committed Costs and the obligation-aware runway. The
-- detector now returns 'biweekly' and 'semimonthly'.
--
-- Deploy order: apply this BEFORE the frontend that produces the new values.
-- The browser upserts all detected obligations in one request, so a single
-- value this constraint rejects fails the whole batch and every obligation
-- disappears for that user until it is applied.
--
-- The new list is a superset of the old one, so existing rows still pass.

alter table public.recurring_obligations drop constraint if exists recurring_obligations_cadence_check;
alter table public.recurring_obligations add constraint recurring_obligations_cadence_check
  check (cadence in ('weekly','biweekly','semimonthly','monthly','quarterly','annual'));
