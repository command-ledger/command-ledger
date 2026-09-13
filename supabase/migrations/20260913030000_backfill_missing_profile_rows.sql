-- Create the profile rows that sign-up failed to create.
--
-- App.jsx loadProfile() creates a user's profile row on first sign-in, but the
-- upsert named an updated_at column the table did not have (fixed in
-- 20260913010000). PostgREST rejected it, the error was discarded, and the row
-- was never written. At the time of this migration, 7 of 9 signed-up accounts
-- had no profile row.
--
-- That matters beyond tidiness. paypal-webhook grants access by updating the
-- subscriber's row; with no row there is nothing to update. PayPal redelivers a
-- failed webhook event for several days, so a subscription paid for recently
-- may still be retrying. Creating the rows lets those retries apply instead of
-- expiring.
--
-- Rows are created with plan = null and status = null, so this grants nothing
-- by itself: access still comes only from a verified PayPal event. The name
-- rule mirrors loadProfile() exactly. It is idempotent, and touches only
-- accounts that have no row.

insert into public.profiles (id, email, name, plan, status, created_at, updated_at)
select
  u.id,
  u.email,
  coalesce(
    nullif(u.raw_user_meta_data ->> 'full_name', ''),
    nullif(split_part(u.email, '@', 1), ''),
    'Founder'
  ),
  null,
  null,
  u.created_at,
  now()
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;
