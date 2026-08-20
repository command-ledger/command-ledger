# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server
- `npm run build` — production build to `dist/`
- `npm run preview` — preview a production build locally

There is no test suite and no lint script configured in this repo (`package.json` only defines `dev`/`build`/`preview`). If you add tests or linting, wire the commands into `package.json` and update this section.

Supabase Edge Functions are deployed with the Supabase CLI via `npx` (it isn't installed globally in this repo):

```
npx supabase functions deploy <function-name> --project-ref rjecagelwzorklmnscrr
npx supabase secrets list --project-ref rjecagelwzorklmnscrr
npx supabase secrets set KEY=value --project-ref rjecagelwzorklmnscrr
```

There are no SQL migration files checked into `supabase/` — the database schema (including the `profiles` table) is managed directly on the remote project, not via local migrations.

## Architecture

**The entire application is one file.** `src/main.jsx` just mounts `src/App.jsx`, which contains the marketing site, auth flow, dashboard, all React components, and all CSS (as an inline template-literal string assigned to `CSS`) — around 1,900 lines. There is no router; navigation is a single `appState` state machine in the top-level `App()` component (`loading` → `marketing` / `login` / `dashboard` / `terms` / `privacy`), and `Dashboard` vs. `PaywallGate` is chosen based on whether `profile.plan` is set.

**Auth and plan-gating run through Supabase.** The Supabase client is created at module scope with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. On sign-in, `loadProfile()` reads (or upserts) a row in the `profiles` table; a falsy `profile.plan` routes the user to `PaywallGate` instead of `Dashboard`. Access control is entirely driven by `profiles.plan` — there is no separate entitlements table.

**Financial metrics are computed client-side, not stored.** `Dashboard` derives margin, burn runway, LTV:CAC, break-even, a 90-day projection, a "Sovereignty Score" (`margin*0.6 + conversion*0.4`), and hire-readiness/concentration-risk flags directly from either parsed CSV rows (`parseAnyCSV`, `detectExpenseCategory`, `detectIncomeFromDescription`, all in `App.jsx`) or manually entered fields. Nothing here is persisted server-side; every load recomputes from whatever data is currently in component state. "Safe Mode" vs. "Growth Mode" reserve percentages (30%/20% vs. 25%/10%) are hardcoded constants applied uniformly, not derived from the business's actual data.

**AI advisor: one live implementation.** `Dashboard` calls `supabase.functions.invoke("analyze-finances")`, which hits `supabase/functions/analyze-finances/index.ts` — a Supabase Edge Function that sends the computed metrics to the Anthropic Messages API with a "you are the fractional CFO, never hedge" system prompt and returns a short first-person memo. (A duplicate Vercel implementation, `api/analyze-ledger.js`, existed with a different prompt and data contract but was never called by the frontend — it was removed as dead code.)

**PayPal subscriptions activate through a webhook, not the browser.** `PayModal` in `App.jsx` creates a PayPal subscription client-side (passing `custom_id: userId` so the backend can identify the user) but does **not** write to the database on approval — that comment is explicit in the code. The actual plan/status update happens in `supabase/functions/paypal-webhook/index.ts`, which verifies the event via PayPal's `/v1/notifications/verify-webhook-signature` API and then updates `profiles.plan` / `profiles.status` based on the event type (`BILLING.SUBSCRIPTION.ACTIVATED` grants access, `CANCELLED`/`EXPIRED` revokes it, `SUSPENDED` records a grace period, `PAYMENT.SALE.COMPLETED`/`PAYMENT.CAPTURE.COMPLETED` keep renewals in sync). **The PayPal plan-ID → plan-key mapping is duplicated in two places that must be kept in sync by hand:** `PAYPAL_PLANS` in `src/App.jsx` and `PLAN_ID_TO_KEY` in `supabase/functions/paypal-webhook/index.ts`. If you add or change a PayPal plan, update both.

**Edge Function secret naming is non-standard — check before assuming.** The PayPal client secret is stored under `PAYPAL_SECRET_ID`, not the more conventional `PAYPAL_CLIENT_SECRET`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into every Edge Function and don't need to be set manually. `PAYPAL_API_BASE` defaults to the PayPal sandbox API if unset — it must be explicitly set to `https://api-m.paypal.com` for the webhook to verify events from a live PayPal app.

**Deployment is Vercel**, with `vercel.json` rewriting all paths to `index.html` for SPA routing. Note that Vercel serves an existing static file before applying that rewrite — any file placed at the repo root (as `checkout.html` was, before it was removed as dead/misleading code) is still directly reachable at its own URL regardless of the rewrite rule, even if nothing in the app links to it.

## Development workflow

For any non-trivial feature in this repo, plan before implementing: understand the requirement, inspect the existing architecture, identify affected components and dependencies, identify risks, write an implementation plan, and identify required tests — plus, because this is a financial product, explicitly call out security implications and financial-calculation implications wherever the change touches money, metrics, or user-facing numbers. Implement in small, verifiable steps.

A feature is not complete because it compiles or the happy path ran once. Before reporting it done, run the test suite and linting if configured, inspect the actual diff, exercise the affected workflows, perform a security review, verify calculations, and check responsive/UI behavior where relevant. Completion means functionality, tests, security, UX, edge cases, and regression checks have all been addressed.
