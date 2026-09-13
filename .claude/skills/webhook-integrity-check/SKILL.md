---
name: webhook-integrity-check
description: Checklist to verify the PayPal subscription webhook is correctly configured and in sync with the frontend before trusting it with real payments — run before and after any change touching PayPal, plan pricing, or the webhook.
---

`supabase/functions/paypal-webhook/index.ts` is the only place that grants or revokes paid access in Command Ledger — `src/App.jsx`'s `PayModal` only updates local UI state on approval, it never writes to the database. This function has failed silently twice. It first shipped as unedited scaffold boilerplate. Later, for months, it wrote `status` and `updated_at` columns that `public.profiles` did not have, so PostgREST rejected every activation, renewal and cancellation. The code looked correct both times. Treat "looks right in the code" as insufficient — verify it against the live systems.

## Checklist

1. **Plan ids live in one place.** `supabase/functions/_shared/paypal-plans.ts` is the only file that maps PayPal plan ids to plan keys (`software`, `advisory`). Both `paypal-webhook` and `plan-pricing` import it, and the browser holds no plan ids. Confirm no plan id literal has crept back in anywhere else:
   ```
   grep -rn "P-[0-9A-Z]\{20,\}" src supabase/functions --include=*.ts --include=*.js --include=*.jsx
   ```
   Every hit should be inside `_shared/paypal-plans.ts` (test fixtures in `financials.test.js` are the one legitimate exception). After editing that file, redeploy **both** functions — each one bundles its own copy at deploy time.

2. **Every column the code touches actually exists.** This is the check that would have caught the months-long silent failure. List what `profiles` really has:
   ```
   npx supabase db query --linked "select column_name from information_schema.columns where table_schema='public' and table_name='profiles' order by ordinal_position;"
   ```
   Then compare it with every column written by `setProfile()` in the webhook, selected by `analyze-finances`, and upserted by `loadProfile()` in `App.jsx`. Any column the code names that the table lacks means every one of those requests fails.

3. **Prove the write shape against PostgREST, not from reading code.** A `PATCH` filtered to a UUID that cannot exist changes nothing, but PostgREST still validates the column names first:
   ```
   curl -X PATCH "$SUPABASE_URL/rest/v1/profiles?id=eq.00000000-0000-0000-0000-000000000000" \
     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" \
     -d '{"status":"active","updated_at":"2026-01-01T00:00:00Z"}'
   ```
   `204` means the payload is valid. `400` with `PGRST204` (write) or `42703` (read) names the missing column.

4. **Required secrets are present.** Run:
   ```
   npx supabase secrets list --project-ref rjecagelwzorklmnscrr
   ```
   and confirm `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET_ID` (not the more conventional `PAYPAL_CLIENT_SECRET` — this project's naming is nonstandard, check the actual name rather than assuming), `PAYPAL_WEBHOOK_ID`, and `PAYPAL_API_BASE` are all listed. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected and don't need to appear here.

5. **The functions actually reach live PayPal.** `secrets list` shows digests only, so prove it by behaviour instead:
   - `POST` to `plan-pricing` with `{"planKey":"software"}` and the anon key. A real plan summary back means `PAYPAL_API_BASE` is live and the credentials work — a live plan id does not exist in sandbox and would 404.
   - `POST` an **unsigned** JSON body to `paypal-webhook`. It must return `401 Signature verification failed`. The webhook calls PayPal OAuth *before* checking the signature, so a 401 (rather than a 500) also proves the credentials are valid, and the forged event is rejected before any database write.

6. **Live PayPal terms match the page.** For each plan, the `plan-pricing` response must show `status: ACTIVE`, `currency: USD`, `intervalUnit: MONTH`, `intervalCount: 1`, an `amount` equal to `PLANS[key].usd` in `App.jsx`, an empty `trials` array, and `setupFee: 0`. `checkoutBlockReason()` keeps checkout closed while any of these disagree. A leftover trial cycle is easy to miss after repricing a plan in place — repricing edits the regular cycle only.

7. **The PayPal dashboard webhook is subscribed to the right events.** In the PayPal app's webhook configuration, confirm the webhook pointed at this function's URL is subscribed to at least: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`. This can't be verified from the repository — it lives entirely in the PayPal dashboard — so it must be checked there directly, not assumed from the code.

8. **Prove it end to end with a real subscription.** Everything above proves the parts work; only a completed subscription proves they work together. Run one through the full flow — checkout in `PayModal` → webhook receives and verifies the event → `profiles.plan` and `profiles.status` actually update in Supabase. If browser automation (Playwright MCP) is available, drive the checkout flow directly rather than only inspecting network logs.

9. **Confirm cancellation actually revokes access.** `BILLING.SUBSCRIPTION.CANCELLED`/`EXPIRED` set `profiles.plan` to `null`. Verify a cancelled test subscriber is routed back to `PaywallGate` (`profile.plan` falsy) rather than retaining `Dashboard` access.
