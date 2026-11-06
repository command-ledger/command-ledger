-- A durable record of every payment event, and of every subscription checkout.
--
-- A real payment once produced no access and left no trace on our side: PayPal
-- was not reaching the webhook, the browser threw away the subscription id, and
-- the only evidence was short-lived logs. These tables mean a payment can no
-- longer disappear.
--
-- payment_events holds each verified webhook event once, by its PayPal event id,
-- so a redelivered event is recognised rather than applied twice, and a failed
-- one is recorded and retried. It keeps ids, amounts and outcomes only, never
-- payer names or emails. provider is here so the next payment provider reuses it.
--
--   received      being handled
--   processed     applied
--   ignored       verified, and correctly needed no action
--   failed        could not be applied; the webhook answers 500 so PayPal retries
--   needs_review  a person must look (a refund, a chargeback, anything unmatched)
--
-- subscription_checkouts holds each subscription from the moment PayPal gives it
-- an id, before the buyer has approved it. If the buyer closes the browser right
-- after paying, the server still knows what to check at their next sign-in. It is
-- also the list of payments without access, which is what repair works from.
--
--   created    id issued; the buyer may not have approved it
--   approved   the buyer approved it; waiting for PayPal to confirm payment
--   active     access granted
--   failed     PayPal says this will not become paid access
--   abandoned  never approved
--
-- Only the Edge Functions write to either table. Clients cannot mark anything
-- paid. A buyer may read their own checkouts, so the app can tell them a payment
-- is being activated after a refresh instead of offering to charge them again.

create table if not exists public.payment_events (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null default 'paypal',
  event_id         text not null,
  event_type       text not null,
  resource_id      text,
  subscription_id  text,
  transaction_id   text,
  user_id          uuid references auth.users(id) on delete set null,
  amount           numeric(12, 2),
  currency         text,
  status           text not null default 'received'
                     check (status in ('received', 'processed', 'ignored', 'failed', 'needs_review')),
  detail           text,
  attempts         integer not null default 1,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  reviewed_at      timestamptz,
  unique (provider, event_id)
);

create index if not exists payment_events_status_idx on public.payment_events (status);
create index if not exists payment_events_transaction_idx on public.payment_events (transaction_id);
create index if not exists payment_events_subscription_idx on public.payment_events (subscription_id);
create index if not exists payment_events_user_idx on public.payment_events (user_id);

alter table public.payment_events enable row level security;

create table if not exists public.subscription_checkouts (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null default 'paypal',
  subscription_id  text not null,
  user_id          uuid references auth.users(id) on delete set null,
  plan_key         text,
  status           text not null default 'created'
                     check (status in ('created', 'approved', 'active', 'failed', 'abandoned')),
  detail           text,
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  activated_at     timestamptz,
  last_checked_at  timestamptz,
  unique (provider, subscription_id)
);

create index if not exists subscription_checkouts_user_idx on public.subscription_checkouts (user_id, status);

alter table public.subscription_checkouts enable row level security;

drop policy if exists "Users can view own checkouts" on public.subscription_checkouts;
create policy "Users can view own checkouts"
  on public.subscription_checkouts for select
  using (auth.uid() = user_id);

-- Who may use the payment repair panel. A signed-in user can see only whether
-- they themselves are listed. The Edge Function checks this on every call; the
-- browser's answer only decides whether to show the panel.
create table if not exists public.app_admins (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  added_at  timestamptz not null default now()
);

alter table public.app_admins enable row level security;

drop policy if exists "Admins can see their own row" on public.app_admins;
create policy "Admins can see their own row"
  on public.app_admins for select
  using (auth.uid() = user_id);

-- A one-time order can now be refunded. A chargeback uses the existing review
-- status, because nothing further is delivered until a person has looked.
alter table public.diagnostic_orders drop constraint if exists diagnostic_orders_status_check;
alter table public.diagnostic_orders add constraint diagnostic_orders_status_check
  check (status in ('created', 'pending', 'completed', 'review', 'refunded'));
alter table public.diagnostic_orders add column if not exists refunded_at timestamptz;

notify pgrst, 'reload schema';
