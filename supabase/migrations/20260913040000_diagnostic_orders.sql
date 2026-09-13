-- One-time Financial Diagnostic purchases.
--
-- A subscription is priced on a PayPal plan; a one-time payment is not. Each
-- diagnostic purchase is a PayPal order created on the server by the
-- diagnostic-order Edge Function, so the amount is never set by the browser.
-- This table is the record that an order was created for a user and whether
-- money was received for it.
--
--   created    order exists at PayPal; no money has moved
--   pending    PayPal accepted the payment but has not released the funds;
--              the PAYMENT.CAPTURE.COMPLETED webhook completes it
--   completed  money received on exactly the terms sold
--   review     money was received but NOT on the terms sold (wrong amount,
--              currency or payer). Nothing is delivered for it until a person
--              has looked.
--
-- There are no insert, update or delete policies: only the service role (the
-- Edge Functions) writes here. A buyer can read their own orders and nothing
-- else, so they cannot mark an order paid.
--
-- user_id is nullable and set null when the account is deleted, rather than
-- cascading: a record that money was received is kept after the person
-- behind it leaves.

create table if not exists public.diagnostic_orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete set null,
  paypal_order_id    text not null unique,
  paypal_capture_id  text unique,
  amount_usd         numeric(10, 2) not null,
  currency           text not null default 'USD',
  status             text not null default 'created'
                       check (status in ('created', 'pending', 'completed', 'review')),
  review_reason      text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index if not exists diagnostic_orders_user_id_idx on public.diagnostic_orders (user_id);

alter table public.diagnostic_orders enable row level security;

drop policy if exists "Users can view own diagnostic orders" on public.diagnostic_orders;
create policy "Users can view own diagnostic orders"
  on public.diagnostic_orders for select
  using (auth.uid() = user_id);

notify pgrst, 'reload schema';
