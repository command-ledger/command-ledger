// Bills (correction plan, revision 4: defect 12, D10a; Phase 1, task 5).
// No upload records a statement period, so nothing confirms that a statement
// covers a bill's due date. A bill with no matching payment is therefore
// "Cannot check yet", never missed, and it stays a committed cost. Only the
// founder ends a bill. The dates below are worked by hand.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { detectRecurringObligations, detectMissedObligations, computeForwardRunway, buildAlerts, CANNOT_CHECK_BILL } from "./financials.js";

const pay = (txn_date, amount, description) => ({ txn_date, amount, description, category: null, currency: "ZAR" });
// Rent R20,000 on the 1st, January to June 2026.
const RENT = ["01", "02", "03", "04", "05", "06"].map(m => pay(`2026-${m}-01`, -20000, "Rent Sandton Office"));
const at = (transactions, asOf) => {
  const obligations = detectRecurringObligations(transactions, { asOf });
  return { obligations, entries: detectMissedObligations(obligations, asOf) };
};

describe("a bill with no matching payment cannot be checked yet", () => {
  it("20 July: rent due 1 July shows Cannot check yet, with no alarm", () => {
    const { obligations, entries } = at(RENT, "2026-07-20");
    expect(obligations[0]).toMatchObject({ next_expected: "2026-07-01", active: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "cannot_check", dueDates: ["2026-07-01"] });
    expect(entries[0].message).toBe(CANNOT_CHECK_BILL);
    expect(CANNOT_CHECK_BILL).toMatch(/^Cannot check yet/);
    expect(entries.some(e => e.status === "missed")).toBe(false);
  });

  it("15 August: rent stays a committed cost of R20,000 a month; 1 July and 1 August cannot be checked", () => {
    // 75 days since 1 June is more than two monthly cycles: the old code ended the bill here.
    const { obligations, entries } = at(RENT, "2026-08-15");
    expect(obligations[0].active).toBe(true);
    expect(entries[0].dueDates).toEqual(["2026-07-01", "2026-08-01"]);
    const f = computeForwardRunway({ currentCash: 500000, avgRev: 100000, avgExp: 100000, obligations, fromDate: "2026-08-15" });
    expect(f.recurringMonthlyTotal).toBe(20000);
  });

  it("20 August, after a July upload for another account with no rent in it: still cannot be checked", () => {
    const savings = [pay("2026-07-02", 250, "Interest earned"), pay("2026-07-28", 250, "Interest earned")];
    const { entries } = at([...RENT, ...savings], "2026-08-20");
    expect(entries[0]).toMatchObject({ status: "cannot_check", dueDates: ["2026-07-01", "2026-08-01"] });
  });

  it("5 August, after July rows for the same account with no rent: still cannot be checked", () => {
    // Rows on both sides of the due date do not confirm the statement is complete.
    const july = [pay("2026-07-01", -150, "Bank fee"), pay("2026-07-15", 90000, "Invoice Acme"), pay("2026-07-31", -150, "Bank fee")];
    const { entries } = at([...RENT, ...july], "2026-08-05");
    expect(entries.find(e => e.label === "Rent Sandton Office")).toMatchObject({ status: "cannot_check", dueDates: ["2026-07-01", "2026-08-01"] });
  });

  it("a rent payment found in any account means it was paid: no entry", () => {
    const { entries } = at([...RENT, pay("2026-07-01", -20000, "Rent Sandton Office")], "2026-07-20");
    expect(entries).toEqual([]);
  });

  it("a bill not yet due has no entry", () => {
    expect(at(RENT, "2026-06-20").entries).toEqual([]);
    expect(at(RENT, "2026-07-01").entries).toEqual([]); // due today
  });

  it("a bill unpaid for 6 months stays active and committed", () => {
    const { obligations, entries } = at(RENT, "2027-01-15");
    expect(obligations[0].active).toBe(true);
    expect(entries[0].dueDates).toEqual(["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(entries[0].status).toBe("cannot_check");
  });

  it("the detector never returns active: false, however long a bill has been quiet", () => {
    ["2026-07-20", "2026-12-31", "2028-01-01", "2031-06-30"].forEach(asOf => {
      expect(detectRecurringObligations(RENT, { asOf }).every(o => o.active === true)).toBe(true);
    });
  });

  it("weekly and quarterly bills follow the same rule", () => {
    const weekly = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"].map(d => pay(d, -1500, "Cleaning service"));
    const w = at(weekly, "2026-07-01");
    expect(w.obligations[0]).toMatchObject({ cadence: "weekly", active: true });
    expect(w.entries[0].status).toBe("cannot_check");
    expect(w.entries[0].dueDates).toEqual(["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"]);
    const quarterly = ["2025-06-15", "2025-09-15", "2025-12-15", "2026-03-15"].map(d => pay(d, -9000, "Insurance premium"));
    const q = at(quarterly, "2026-12-20");
    expect(q.obligations[0]).toMatchObject({ cadence: "quarterly", active: true });
    expect(q.entries[0].dueDates).toEqual(["2026-06-15", "2026-09-15", "2026-12-15"]);
  });

  it("a bill the founder ended is never listed", () => {
    const ended = [{ label: "Old lease", cadence: "monthly", next_expected: "2026-01-01", day_of_month: 1, active: false }];
    expect(detectMissedObligations(ended, "2026-07-20")).toEqual([]);
  });
});

describe("no missed-bill alert without confirmed coverage", () => {
  it("the alerts bell raises nothing for a bill that cannot be checked", () => {
    const { entries } = at(RENT, "2026-08-15");
    const alerts = buildAlerts({ hasData: true, today: "2026-08-15", lastTxnDate: "2026-08-10", missedObligations: entries });
    expect(alerts).toEqual([]);
  });

  it("the app keeps a founder-ended bill ended, and shows unchecked bills as Cannot check yet", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(app).toMatch(/active: existingActiveByKey\[o\.normalized_key\] === false \? false : true/);
    expect(app).toMatch(/Cannot check yet/);
    expect(app).not.toMatch(/missedObligations\.slice\(0, 3\)\.map\(\(o, i\) => <div key=\{i\} className="d-alert crit">/);
  });
});
