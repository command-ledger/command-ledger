---
name: verify-financials
description: Validate Command Ledger's financial calculation engine (margin, burn runway, LTV:CAC, break-even, 90-day projection, Sovereignty Score) against hand-computed expected values before any change to that code ships.
---

Command Ledger's entire value proposition is "trust these numbers." The calculation engine lives in `src/lib/financials.js`, specifically `computeMetrics()`, and is consumed by the `Dashboard` component in `src/App.jsx`. Before any change to that file (or to how `Dashboard` calls it) is considered done, run this procedure — don't rely on "it compiles" or "the number on screen looks plausible."

## Procedure

1. **Read the current formulas** in `computeMetrics()` end to end. Note every constant (the 30%/20% safe-mode and 25%/10% growth-mode reserve split, the `margin*0.6 + conv*0.4` Sovereignty Score weighting, the `free > 25000*6` hire-readiness threshold) — these are business decisions encoded as literals, not incidental values, so a diff that touches one should be treated as a product decision, not a typo fix.

2. **Run the existing unit tests**: `npx vitest run src/lib/financials.test.js`. These encode hand-computed expected values for representative scenarios (manual entry, uploaded CSV rows, safe vs. growth mode, zero-revenue edge cases). A change to the calculation engine that doesn't break any of these — but should have, because the formula changed — means the test file itself needs a new case added, not that the check can be skipped.

3. **For any new or changed formula**, hand-compute the expected result for at least one concrete example before writing or trusting a test for it. Don't derive the expected value by reading the code you're testing — compute it independently (e.g. margin = (revenue − expenses) / revenue × 100, burn runway = (cash + safety buffer) / average monthly expenses) and confirm the code produces that number.

4. **Check the edge cases specifically**: zero revenue, zero expenses, a single data row (no `prev` row to compare against for velocity), negative free cash, and CAC/LTV of zero. These are exactly the states a new user with incomplete data will be in, and `computeMetrics()` has explicit guards for several of them (e.g. `avgExp > 0 ? ... : 0` to avoid burn-runway division by zero) — verify new formulas have the same guards where division is involved.

5. **Confirm the AI advisor payload still matches.** `Dashboard`'s `runAI()` function sends `margin.toFixed(1)`, `burnMonths.toFixed(1)`, etc. straight into the prompt sent to `supabase/functions/analyze-finances`. If a metric's meaning or unit changes, the system prompt in that Edge Function (which tells Claude to treat these as ground truth) needs to be checked too — a silent mismatch there means the AI advisor confidently narrates a wrong number.

6. **Rebuild and diff the bundle hash** as a cheap sanity check for pure refactors: `npm run build`. If you only meant to reorganize code (not change behavior) and the output JS bundle hash changes, that's a signal something behavioral shifted unintentionally — worth double-checking before treating the refactor as safe.
