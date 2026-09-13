# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server
- `npm run build` — production build to `dist/`
- `npm run preview` — preview a production build locally
- `npm test` — run the Vitest suite once (`vitest run`)

There is a test suite: `src/lib/financials.test.js` covers `src/lib/financials.js` with hand-computed expectations. Run it before reporting any calculation change complete. There is still no lint script; if you add one, wire it into `package.json` and update this section.

**`xlsx` is installed from the vendor's CDN, not the npm registry.** SheetJS stopped publishing to npm after 0.18.5, which carries an unpatched prototype-pollution and a ReDoS advisory, so `package.json` pins `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. A fresh `npm install` therefore needs `cdn.sheetjs.com` to be reachable. Do not "fix" this back to a registry range — that silently reintroduces both advisories.

Supabase Edge Functions are deployed with the Supabase CLI via `npx` (it isn't installed globally in this repo):

```
npx supabase functions deploy <function-name> --project-ref rjecagelwzorklmnscrr
npx supabase secrets list --project-ref rjecagelwzorklmnscrr
npx supabase secrets set KEY=value --project-ref rjecagelwzorklmnscrr
```

Database schema lives in `supabase/migrations/` and is applied with `npx supabase db push --linked`. `npx supabase migration list --linked` compares local to remote. The `profiles` table predates these migrations and was managed by hand on the remote project; its entitlement columns (`status`, `updated_at`) and its plan guard now live in migration `20260913010000`.

**Code was written against `profiles` columns that did not exist, and nothing noticed for months.** The webhook wrote `status` and `updated_at`, the AI advisor selected `status`, and sign-up wrote `updated_at` — none of which the table had. PostgREST rejected every one of those requests, so no subscription could grant access, the advisor refused every user, and new profile rows were never created. Two lessons follow. **Before shipping code that reads or writes a column, confirm the column exists** (`information_schema.columns`). And **never discard a Supabase `error`** — each of these failures was silent only because the error was ignored or a fallback hid it.

Two CLI quirks worth knowing: there is **no `functions logs` subcommand**, and `secrets list` prints digests only, never plaintext.

## Architecture

**The entire application is one file.** `src/main.jsx` just mounts `src/App.jsx`, which contains the marketing site, auth flow, dashboard, all React components, and all CSS (as an inline template-literal string assigned to `CSS`) — around 2,800 lines. **A stray backtick anywhere inside the `CSS` template literal terminates the string and breaks the build**, so never use backticks in its comments.

The one exception to the single-file rule is `src/lib/financials.js`, which holds every pure calculation and parsing function. New financial logic belongs there, not in `App.jsx`, because that is the only part of the codebase under test. There is no router; navigation is a single `appState` state machine in the top-level `App()` component (`loading` → `marketing` / `login` / `dashboard` / `terms` / `privacy`), and `Dashboard` vs. `PaywallGate` is chosen based on whether `profile.plan` is set.

**Auth and plan-gating run through Supabase.** The Supabase client is created at module scope with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. On sign-in, `loadProfile()` reads (or upserts) a row in the `profiles` table; a falsy `profile.plan` routes the user to `PaywallGate` instead of `Dashboard`. Access control is entirely driven by `profiles.plan` — there is no separate entitlements table.

**Financial metrics are computed client-side, not stored.** `computeMetrics()` in `src/lib/financials.js` derives margin, burn runway, LTV:CAC, break-even, a 90-day projection, a trend-aware composite risk score, growth scoring with a seasonality override, revenue concentration by counterparty, and forward obligations — from either parsed rows (`parseAnyCSV`, `parseTransactions`, `detectExpenseCategory`, `detectIncomeFromDescription`, all now in `financials.js`) or manually entered fields.

**Every displayed metric carries a computed confidence.** `computeConfidence()` grades on volume and recency and returns `low`/`moderate`/`high` with a reason. Confidence is computed, never hardcoded per metric. Two rules follow from it and must not be quietly relaxed: a metric with insufficient data renders `---`, never `0` (a zero is a claim; an absence is the truth), and `capSeverityForVolume()` prevents a single month of data from ever producing a `critical` severity. The Edge Function receives the confidence and hedges accordingly. The metrics themselves are never stored; every load recomputes them. The data they are computed from is persisted — transactions in the event store, plus `recurring_obligations` and `directives`. "Safe Mode" vs. "Growth Mode" reserve percentages (30%/20% vs. 25%/10%) are hardcoded constants applied uniformly, not derived from the business's actual data.

**AI advisor: one live implementation.** `Dashboard` calls `supabase.functions.invoke("analyze-finances")`, which hits `supabase/functions/analyze-finances/index.ts` — a Supabase Edge Function that sends the computed metrics to the Anthropic Messages API and returns a structured recommendation (What Happened / Why / Business Impact / Risk / Action / Expected Outcome / Confidence). The system prompt deliberately **does** hedge on low-confidence input, refuses to call an established seasonal pattern a decline, and caps risk at `Watch` when only one month of data exists — there is a code-level cap enforcing that last rule regardless of what the model returns. Its output is rendered as React text, never `dangerouslySetInnerHTML`, because model output is untrusted content. (A duplicate Vercel implementation, `api/analyze-ledger.js`, existed with a different prompt and data contract but was never called by the frontend — it was removed as dead code.)

**PayPal subscriptions activate through a webhook, not the browser.** `PayModal` in `App.jsx` creates a PayPal subscription client-side (passing `custom_id: userId` so the backend can identify the user) but does **not** write to the database on approval — that comment is explicit in the code. The actual plan/status update happens in `supabase/functions/paypal-webhook/index.ts`, which verifies the event via PayPal's `/v1/notifications/verify-webhook-signature` API and then updates `profiles.plan` / `profiles.status` based on the event type (`BILLING.SUBSCRIPTION.ACTIVATED` grants access, `CANCELLED`/`EXPIRED` revokes it, `SUSPENDED` records a grace period, `PAYMENT.SALE.COMPLETED`/`PAYMENT.CAPTURE.COMPLETED` keep renewals in sync). Grant events throw when no profile row matches, so the webhook returns 500 and PayPal redelivers instead of acknowledging a paid subscription it could not apply.

**PayPal plan ids live in exactly one place:** `supabase/functions/_shared/paypal-plans.ts`, imported by both `paypal-webhook` and `plan-pricing`. The browser holds no plan ids. To add, retire or swap a plan, edit only that file and redeploy both functions. Retired plan ids stay mapped until no live subscription remains on them.

**PayPal owns the price; this app only renders it.** When `PayModal` opens it calls the `plan-pricing` Edge Function, which reads the plan's live terms from PayPal — recurring amount, currency, interval, trial cycles and setup fee — and `checkoutBlockReason()` in `financials.js` opens checkout only if **every charge, starting with the first, equals the price shown**. A trial or setup fee blocks it even when it favours the customer, because the page does not disclose it. Blocked checkout shows the customer one neutral message plus an email route, and logs the specific reason to the console. **Never resolve a block by loosening the check** — change the plan in PayPal, or change the page to disclose the terms. PayPal plans *can* be repriced in place (an earlier version of this file said otherwise, which was wrong); because the check is live, an in-place reprice reaches checkout within the function's 5-minute cache without a code change.

**Two offers, not three tiers:** `software` (Command Ledger, $99/mo, self-serve; annual $990 is arranged by email because no annual PayPal plan exists) and `advisory` (Command Advisory, $3,000/mo, 6 seats, adds the monthly call and board report). `DIAGNOSTIC` ($750 one-time) is sold by email, not checkout, because one-time charges need PayPal's Orders API which is not wired. Profiles created under the retired Essentials/Pro/Elite pricing are mapped by `resolvePlanKey()`, so `PLANS[plan]` is never undefined — keep that resolver as long as any legacy row or subscription can exist.

**Edge Function secret naming is non-standard — check before assuming.** The PayPal client secret is stored under `PAYPAL_SECRET_ID`, not the more conventional `PAYPAL_CLIENT_SECRET`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into every Edge Function and don't need to be set manually. `PAYPAL_API_BASE` defaults to the PayPal sandbox API if unset — it must be explicitly set to `https://api-m.paypal.com` for the webhook to verify events from a live PayPal app.

**Deployment is Vercel**, with `vercel.json` rewriting all paths to `index.html` for SPA routing. Note that Vercel serves an existing static file before applying that rewrite — any file placed at the repo root (as `checkout.html` was, before it was removed as dead/misleading code) is still directly reachable at its own URL regardless of the rewrite rule, even if nothing in the app links to it.

## Development workflow

For any non-trivial feature in this repo, plan before implementing: understand the requirement, inspect the existing architecture, identify affected components and dependencies, identify risks, write an implementation plan, and identify required tests — plus, because this is a financial product, explicitly call out security implications and financial-calculation implications wherever the change touches money, metrics, or user-facing numbers. Implement in small, verifiable steps.

A feature is not complete because it compiles or the happy path ran once. Before reporting it done, run the test suite and linting if configured, inspect the actual diff, exercise the affected workflows, perform a security review, verify calculations, and check responsive/UI behavior where relevant. Completion means functionality, tests, security, UX, edge cases, and regression checks have all been addressed.
