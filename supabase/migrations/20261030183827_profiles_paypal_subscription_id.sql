-- Record which PayPal subscription grants a profile's plan.
--
-- A customer who upgrades from Command Ledger to Command Advisory holds two
-- subscriptions until one is cancelled. paypal-webhook applied every event to
-- the profile whatever subscription it came from, so the older subscription's
-- monthly renewal set an Advisory customer back to "software", and cancelling
-- it removed access the newer subscription was paying for. The webhook now
-- stores the granting subscription here and lets only that one revoke or
-- suspend access (see supabase/functions/_shared/subscription-entitlement.ts).
--
-- Existing rows start NULL: the webhook treats that as "nothing on file" and
-- records the id on the next event for the profile.
--
-- Deploy order: apply this migration BEFORE deploying the new paypal-webhook.
-- The new code selects this column; without it every event fails with 500
-- (PayPal retries, so nothing is lost, but access is delayed until it exists).

alter table public.profiles add column if not exists paypal_subscription_id text;

-- The column decides who may revoke access, so a client must not be able to
-- write it — a user pointing it at a dead subscription id would make their own
-- cancellation unable to remove their plan. Same guard as plan and status.
create or replace function public.prevent_unprivileged_plan_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.role() is not null and auth.role() <> 'service_role' then
    if tg_op = 'INSERT' then
      new.plan := null;
      new.status := null;
      new.paypal_subscription_id := null;
    else
      new.plan := old.plan;
      new.status := old.status;
      new.paypal_subscription_id := old.paypal_subscription_id;
    end if;
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
