// Partial months: a month that is not over, or that the data covers only
// part of, counts toward the period's totals but never stands in for a
// whole month. Every expected figure below is worked out by hand.
import { describe, it, expect } from "vitest";
import { aggregateTransactionsByMonth, computeMetrics, periodStartDate, currentRunRate, sumCents } from "./financials.js";

const NO_MANUAL = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
const TODAY = "2026-11-04";
const txn = (txn_date, amount, description = amount > 0 ? "Client invoice" : "Supplier") => ({ txn_date, amount, description, category: null });
const partialFlags = rows => rows.map(r => [r.period_month.slice(0, 7), r.partial]);

// Defect 17 (correction plan, rank 17): monthly totals were rounded to whole
// rand before any calculation, so small amounts were lost or invented. Cents are
// kept through every calculation; only the display rounds. Expected figures are
// worked by hand.
describe("monthly totals are kept to the cent", () => {
  it("adds three R0.40 fees to R1.20, not R1", () => {
    const [row] = aggregateTransactionsByMonth([
      txn("2026-06-01", -0.4, "Bank fee"), txn("2026-06-02", -0.4, "Bank fee"), txn("2026-06-03", -0.4, "Bank fee"),
    ], { today: TODAY });
    expect(row.expenses).toBe(1.2); // 0.40 + 0.40 + 0.40
  });

  it("keeps cents in every total the month carries", () => {
    const [row] = aggregateTransactionsByMonth([
      txn("2026-06-05", 1234.56, "Client invoice"),             // revenue
      { txn_date: "2026-06-06", amount: -99.99, description: "Microsoft 365", category: "software" }, // a categorised cost
      txn("2026-06-07", -500.25, "Loan repayment"),              // financing out
    ], { today: TODAY });
    expect(row.revenue).toBe(1234.56);
    expect(row.software).toBe(99.99);
    expect(row.expenses).toBe(99.99);
    expect(row.financingOut).toBe(500.25);
  });

  // Adding cent amounts across months leaves floating-point remainders that
  // whole rand never did: 100.10 + 200.20 is 300.29999999999995. A business that
  // broke even to the cent then read a loss of 0.0000000000000568, and a critical
  // directive. Totals across months are kept to the cent too.
  it("adds months to the cent, so a break-even business reads exactly zero", () => {
    const rows = aggregateTransactionsByMonth([
      txn("2026-04-01", 100.1, "Client invoice"), txn("2026-04-28", -150.15, "Supplier"),
      txn("2026-05-01", 200.2, "Client invoice"), txn("2026-05-30", -150.15, "Supplier"),
    ], { today: "2026-07-15" });
    // Two complete months. In: 100.10 + 200.20 = 300.30. Out: 150.15 + 150.15 = 300.30. Profit: 0.
    const m = computeMetrics(rows, NO_MANUAL, "safe", { currency: "ZAR", today: "2026-07-15", runRateRows: rows });
    expect(m.totRev).toBe(300.3);
    expect(m.totExp).toBe(300.3);
    expect(Object.is(m.totPro, 0)).toBe(true);
    expect(Object.is(m.free, 0)).toBe(true);
    expect(m.margin).toBe(0);
  });

  it("adds months to the cent in the run rate as well", () => {
    // April and May complete; revenue 100.10 + 200.20 = 300.30 over 2 months, costs 150.15 + 150.15 = 300.30.
    const rows = aggregateTransactionsByMonth([
      txn("2026-04-01", 100.1, "Client invoice"), txn("2026-04-30", -150.15, "Supplier"),
      txn("2026-05-01", 200.2, "Client invoice"), txn("2026-05-31", -150.15, "Supplier"),
    ], { today: "2026-07-15" });
    const r = currentRunRate(rows);
    expect(r.months).toBe(2);
    expect(r.revenue).toBe(150.15);   // 300.30 / 2
    expect(r.expenses).toBe(150.15);  // 300.30 / 2
    expect(Object.is(r.burn, 0)).toBe(true);
  });

  it("sums a field to the cent", () => {
    expect(sumCents([{ v: 100.1 }, { v: 200.2 }], "v")).toBe(300.3);
    expect(Object.is(sumCents([{ v: 0.1 }, { v: 0.2 }, { v: -0.3 }], "v"), 0)).toBe(true);
    expect(sumCents([], "v")).toBe(0);
    expect(sumCents(null, "v")).toBe(0);
  });

  it("never stores a negative zero from cents left over by floating point", () => {
    // 0.30 - 0.10 - 0.20 is -0.0000000000000000278 in floating point; to the cent it is 0.
    const [row] = aggregateTransactionsByMonth([
      { txn_date: "2026-06-01", amount: -0.3, description: "Office supplies", category: null },
      { txn_date: "2026-06-02", amount: 0.1, description: "Office supplies refund", category: null },
      { txn_date: "2026-06-03", amount: 0.2, description: "Office supplies refund", category: null },
    ], { today: TODAY });
    expect(Object.is(row.expenses, 0)).toBe(true);
  });
});

describe("which months are partial", () => {
  it("marks this month as partial, whatever it holds", () => {
    const rows = aggregateTransactionsByMonth([txn("2026-10-01", 1000), txn("2026-10-28", -500), txn("2026-11-02", 300)], { today: TODAY });
    expect(partialFlags(rows)).toEqual([["2026-10", false], ["2026-11", true]]);
    expect(rows[1]).toMatchObject({ coveredFrom: "2026-11-02", coveredTo: "2026-11-02" });
  });

  it("marks the first month partial when the data starts more than a week into it", () => {
    const from = day => aggregateTransactionsByMonth([txn(`2026-08-${day}`, 1), txn("2026-08-30", 1), txn("2026-09-03", 1), txn("2026-09-29", 1)], { today: TODAY });
    expect(partialFlags(from("15"))).toEqual([["2026-08", true], ["2026-09", false]]);
    expect(from("09")[0].partial).toBe(true);   // the 1st to the 8th missing: 8 days
    expect(from("08")[0].partial).toBe(false);  // the 1st to the 7th missing: 7 days
  });

  it("marks the last month partial when the data stops more than a week before its end", () => {
    const to = day => aggregateTransactionsByMonth([txn("2026-09-01", 1), txn("2026-09-30", 1), txn("2026-10-01", 1), txn(`2026-10-${day}`, 1)], { today: TODAY });
    expect(partialFlags(to("20"))).toEqual([["2026-09", false], ["2026-10", true]]); // 11 days of October missing
    expect(to("24")[1].partial).toBe(false); // 7 days missing
  });

  it("treats monthly summaries dated the 1st as complete, except this month", () => {
    const rows = aggregateTransactionsByMonth(
      ["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"].flatMap(d => [txn(d, 10000), txn(d, -6000)]), { today: TODAY });
    expect(partialFlags(rows)).toEqual([["2026-08", false], ["2026-09", false], ["2026-10", false], ["2026-11", true]]);
    // A month later, October is still a complete summary, not a month with 30 days missing.
    const later = aggregateTransactionsByMonth(["2026-09-01", "2026-10-01"].map(d => txn(d, 10000)), { today: "2026-12-04" });
    expect(partialFlags(later)).toEqual([["2026-09", false], ["2026-10", false]]);
  });

  it("leaves a statement that stops on the 1st partial, after ordinary daily data", () => {
    const rows = aggregateTransactionsByMonth([txn("2026-09-01", 1), txn("2026-09-15", 1), txn("2026-09-30", 1), txn("2026-10-01", 1)], { today: TODAY });
    expect(partialFlags(rows)).toEqual([["2026-09", false], ["2026-10", true]]); // one day of October
  });
});

describe("computeMetrics with a partial month", () => {
  // August to October in full, then November to the 4th.
  const rows = aggregateTransactionsByMonth([
    txn("2026-08-01", 10000), txn("2026-08-28", -6000),
    txn("2026-09-01", 10000), txn("2026-09-28", -6000),
    txn("2026-10-01", 10000), txn("2026-10-28", -6000),
    txn("2026-11-02", 1500),  txn("2026-11-03", -2000),
  ], { today: TODAY });

  it("judges the latest month, growth and averages on complete months", () => {
    const m = computeMetrics(rows, NO_MANUAL, "safe");
    expect(m.latest.period_month).toBe("2026-10-01");
    expect(m.vel).toBe(0);             // October against September; November so far would read -85%
    expect(m.growth.label).toBe("Flat");
    expect(m.n).toBe(3);
    expect(m.partialMonths).toBe(1);
    expect(m.avgRev).toBe(10000);
    expect(m.avgExp).toBe(6000);
    expect(m.netBurn).toBe(-4000);
    expect(m.proj90).toBe(10000);
  });

  it("measures profit and margin on complete months, and reports the month in progress beside them (D4)", () => {
    const m = computeMetrics(rows, NO_MANUAL, "safe");
    expect(m.totRev).toBe(30000);      // 3 x 10,000; November's 1,500 so far is left out
    expect(m.totExp).toBe(18000);      // 3 x 6,000; November's 2,000 so far is left out
    expect(m.margin).toBeCloseTo(40, 6); // 12,000 / 30,000
    expect(m.toDate).toMatchObject({ revenue: 1500, expenses: 2000, months: 1 });
    expect(m.toDate.label).toMatch(/to date/);
  });

  it("uses the partial month when no month is complete yet", () => {
    const only = aggregateTransactionsByMonth([txn("2026-11-02", 1500), txn("2026-11-03", -2000)], { today: TODAY });
    const m = computeMetrics(only, NO_MANUAL, "safe");
    expect(m.n).toBe(1);
    expect(m.partialMonths).toBe(1);
    expect(m.latest.revenue).toBe(1500);
    expect(m.avgRev).toBe(1500);
  });
});

describe("month labels", () => {
  it("name the month whatever the viewer's time zone", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/New_York"; // midnight UTC on the 1st is the evening before here
      const rows = aggregateTransactionsByMonth([txn("2026-04-03", 100), txn("2026-05-02", 100)], { today: TODAY });
      expect(rows.map(r => r.month)).toEqual(["Apr 26", "May 26"]);
    } finally {
      if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
  });
});

describe("periodStartDate", () => {
  it("starts on the 1st of the month, whole months before this one", () => {
    expect(periodStartDate("12", "2026-11-04")).toBe("2025-11-01");
    expect(periodStartDate("3", "2026-11-04")).toBe("2026-08-01");
    expect(periodStartDate("6", "2026-06-30")).toBe("2025-12-01");
    expect(periodStartDate(1, "2026-01-15")).toBe("2025-12-01");
  });

  it("has no start for all history", () => {
    expect(periodStartDate("all", "2026-11-04")).toBeNull();
    expect(periodStartDate(0, "2026-11-04")).toBeNull();
  });
});
