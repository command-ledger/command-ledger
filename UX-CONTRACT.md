# Command Ledger UX contract

Rules every screen must keep. They exist because Command Ledger shows people
numbers they will act on with real money. A change that breaks one of these is
a defect, however good it looks. Visual rules live in `DESIGN.md`.

## Financial honesty

1. **Every figure is computed, never typed.** Metrics come from
   `computeMetrics()` and the other functions in `src/lib/financials.js`.
   The public site's sample figures are computed from `EXAMPLE_CSV` by the
   same functions.
2. **Missing is not zero.** A metric whose inputs are absent renders `---`
   with the reason, never `0`.
3. **Confidence travels with the number.** Any figure below high confidence
   shows a `ConfidenceLine` with its level and reason.
4. **One month is never critical.** `capSeverityForVolume()` and the
   advisor's code-level cap both enforce it.
5. **Sample data is always labelled** "Sample data", and illustrative copy is
   labelled as illustrative.
6. **History and forecast stay apart.** The cash chart shows actual
   transactions only; projections live under Forecasts.
7. **Model output is text.** AI briefs render as React text, never as HTML.
8. **Not everything that moves money is revenue or a cost.** Loans, the
   owner's own money and transfers between the business's own accounts are
   kept out of revenue, costs and margin, and refunds net against them. Every
   transaction shows what it counts as, and the founder can change it.
9. **A month in progress is labelled "to date"** and never stands in for a
   whole month: it counts in period totals, never in averages, growth,
   trends or the latest-month figures.
10. **A known cash balance is real, even at or below zero.** An overdraft or
    an empty account is 0 months of runway, not `---`. The balance shows its
    date and source, and a stale one lowers runway's confidence.
11. **One currency per figure, never converted.** Every figure is in the
   business currency, set by the first file or in Settings, and carries its
   symbol. A file's currency is read from the file; one that does not state
   it says how it was decided, and the founder is asked rather than a currency
   being assumed. Transactions in any other currency are listed in their own
   currency and counted in a notice, never added in. Command Ledger's own
   prices are written "US$".

## Accessibility

1. Every control works by keyboard and touch. Sidebar items are real links;
   actions are real buttons; custom controls use `clickableProps`.
2. Focus is always visible: a 2 px platinum outline (`:focus-visible`).
3. Colour never carries meaning alone; every state has a text label.
4. Text meets WCAG AA. `--text-3` is the dimmest text token allowed.
5. Popovers and the drawer close with Escape and on an outside click; the
   drawer returns focus to its button and locks page scroll while open.
6. `prefers-reduced-motion` turns motion off.
7. Inputs are 16 px on phones so iOS does not zoom.

## Layout

1. No horizontal page overflow at any width from 320 px up.
2. Financial figures are never clipped; tiles wrap before they shrink.
3. Tables scroll inside their panel rather than clipping columns.
4. Tested widths: 1440 and 1366 (laptop), 1024 and 768 (tablet), 375 (phone).

## Integrity

1. Controls must be connected to a real operation. If something is not
   supported (in-app account deletion, email preferences), say so plainly;
   never draw a control that does nothing.
2. Destructive actions ask for confirmation and say what will be lost.
3. Copy may only describe what the product does today. There is no bank
   connection; imports are CSV, Excel and published Google Sheets.
4. Payment, subscription and entitlement behaviour is never changed as part
   of a visual change. See `CLAUDE.md` for those rules.
5. Before reporting a UI change done: run `npm test` and `npm run build`,
   check the widths above, and confirm no em or en dash appears in the copy.
