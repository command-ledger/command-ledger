---
name: webhook-integrity-check
description: Checklist to verify the PayPal subscription webhook is correctly configured and in sync with the frontend before trusting it with real payments — run before and after any change touching PayPal, plan pricing, or the webhook.
---

`supabase/functions/paypal-webhook/index.ts` is the only place that grants or revokes paid access in Command Ledger — `src/App.jsx`'s `PayModal` only updates local UI state on approval, it never writes to the database. This function previously shipped as unedited scaffold boilerplate for an unknown period before an audit caught it, so treat "looks right in the code" as insufficient — verify it end to end.

## Checklist

1. **Plan-ID mapping is in sync.** `PAYPAL_PLANS` in `src/App.jsx` and `PLAN_ID_TO_KEY` in `supabase/functions/paypal-webhook/index.ts` both hardcode the same PayPal plan IDs to internal plan keys (`essentials`, `pro`). They are two separate literals in two separate runtimes (browser vs. Deno) with no shared import — diff them by hand whenever either file changes, and especially whenever a plan is added, removed, or repriced in the PayPal dashboard.

2. **Required secrets are present.** Run:
   ```
   npx supabase secrets list --project-ref rjecagelwzorklmnscrr
   ```
   and confirm `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET_ID` (not the more conventional `PAYPAL_CLIENT_SECRET` — this project's naming is nonstandard, check the actual name rather than assuming), `PAYPAL_WEBHOOK_ID`, and `PAYPAL_API_BASE` are all listed. `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-injected and don't need to appear here.

3. **`PAYPAL_API_BASE` matches the credentials' environment.** If `PAYPAL_CLIENT_ID`/`PAYPAL_SECRET_ID` are from a live PayPal app, `PAYPAL_API_BASE` must be `https://api-m.paypal.com`. It defaults to the sandbox API if unset — a live app verified against the sandbox endpoint will fail signature verification for every real event, silently blocking activation.

4. **The PayPal dashboard webhook is subscribed to the right events.** In the PayPal app's webhook configuration, confirm the webhook pointed at this function's URL is subscribed to at least: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`. This can't be verified from the repository — it lives entirely in the PayPal dashboard — so it must be checked there directly, not assumed from the code.

5. **Prove it end to end, don't just review the code.** Run a real (or PayPal-simulated) sandbox subscription through the full flow — checkout in `PayModal` → webhook receives and verifies the event → `profiles.plan` and `profiles.status` actually update in Supabase. If browser automation (Playwright MCP) is available, drive the checkout flow directly rather than only inspecting network logs.

6. **Confirm cancellation actually revokes access.** `BILLING.SUBSCRIPTION.CANCELLED`/`EXPIRED` set `profiles.plan` to `null`. Verify a cancelled test subscriber is routed back to `PaywallGate` (`profile.plan` falsy) rather than retaining `Dashboard` access.
