-- Profiles entitlement columns, and closing the plan self-grant on INSERT.
--
-- public.profiles predates this migrations directory and was managed by hand
-- on the remote project. Three pieces of code were written against columns it
-- never received, and each one fails in production:
--
--   * paypal-webhook setProfile() writes status and updated_at. PostgREST
--     rejects the entire payload (PGRST204), so every subscription
--     activation, renewal, cancellation and suspension fails to apply.
--   * analyze-finances selects "plan, status". The query errors (42703), so
--     the AI advisor returns 403 to every user, whether entitled or not.
--   * App.jsx loadProfile() upserts updated_at on first login. The upsert is
--     rejected, its error is never checked, and the profile row is silently
--     never created.
--
-- Both columns are added nullable with no default. Existing rows are left
-- with a NULL status on purpose: their plans were not granted by a PayPal
-- event, and writing 'active' would record a subscription state that never
-- happened.

alter table public.profiles add column if not exists status text;
alter table public.profiles add column if not exists updated_at timestamptz;

-- The guard previously fired BEFORE UPDATE only, while the INSERT policy
-- checks nothing beyond auth.uid() = id. Nothing creates the profile row at
-- signup (there is no trigger on auth.users), so a user whose row did not yet
-- exist could insert it with any plan and receive paid access for free. The
-- guard now also covers INSERT: a row created by a client always starts with
-- no plan and no status, and only the webhook can set them.
--
-- Only PostgREST client roles are restricted. auth.role() is 'service_role'
-- for the webhook and NULL on a direct database connection (the SQL editor,
-- migrations); both remain trusted, exactly as before. The NULL case is now
-- stated explicitly instead of depending on NULL <> 'service_role' happening
-- to evaluate to NULL rather than true.
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
    else
      new.plan := old.plan;
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profiles_plan_status on public.profiles;
create trigger guard_profiles_plan_status
  before insert or update on public.profiles
  for each row execute function public.prevent_unprivileged_plan_change();

-- PostgREST caches the schema; without a reload the new columns stay
-- invisible to the API and the PGRST204 / 42703 failures persist.
notify pgrst, 'reload schema';
