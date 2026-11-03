-- Transaction kinds: the founder's own rules for what a transaction is.
--
-- Figures leave out money that is not revenue or a cost: transfers between
-- the business's own accounts, loans and owner money, and refunds (which
-- net against revenue or costs). src/lib/financials.js
-- (classifyTransaction) reads most of them from the description; a rule
-- here is how the founder corrects it. Transactions stay immutable (they
-- have no update policy), so the kind is never stored on them: it is
-- worked out from these rules on every read.
--
--   scope 'single'   one transaction, matched by its dedupe_hash, which
--                    survives deleting and re-uploading the same file.
--   scope 'similar'  every transaction whose description, with digits
--                    removed (classificationKey), equals match_key.
--   description_key  for a 'single' rule, the classificationKey of its
--                    transaction, so choosing "every transaction like this"
--                    later can clear the single rules it replaces.

create table if not exists public.transaction_rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  scope           text not null check (scope in ('single','similar')),
  match_key       text not null check (char_length(match_key) between 1 and 200),
  description_key text check (description_key is null or char_length(description_key) <= 200),
  kind            text not null check (kind in ('operating','transfer','financing','refund')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, scope, match_key)
);

alter table public.transaction_rules enable row level security;

drop policy if exists transaction_rules_select_own on public.transaction_rules;
create policy transaction_rules_select_own on public.transaction_rules for select using ((select auth.uid()) = user_id);

drop policy if exists transaction_rules_insert_own on public.transaction_rules;
create policy transaction_rules_insert_own on public.transaction_rules for insert with check ((select auth.uid()) = user_id);

drop policy if exists transaction_rules_update_own on public.transaction_rules;
create policy transaction_rules_update_own on public.transaction_rules for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists transaction_rules_delete_own on public.transaction_rules;
create policy transaction_rules_delete_own on public.transaction_rules for delete using ((select auth.uid()) = user_id);
