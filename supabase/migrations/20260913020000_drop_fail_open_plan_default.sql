-- Remove the fail-open default on profiles.plan.
--
-- plan carried DEFAULT 'essentials'. Access to the dashboard is granted by a
-- truthy plan, so every inserted row that did not name plan was entitled by
-- default. Before 20260913010000 extended the guard trigger to INSERT, that
-- made free access trivial: a signed-in user could insert their own profile row
-- through the public API without mentioning plan at all, and receive a paid
-- tier.
--
-- The guard now nulls plan on every client INSERT, and it runs after column
-- defaults are applied, so client inserts are already safe. The default is
-- removed anyway. An entitlement column must fail closed: a future server-side
-- insert path, or the trigger being disabled while debugging, must not quietly
-- start handing out paid access.
--
-- Every legitimate insert already names plan explicitly (loadProfile() and the
-- 20260913030000 backfill both set it to null), and existing rows are
-- untouched — a default applies only to future inserts.

alter table public.profiles alter column plan drop default;
