// Partial months: a month that is not over, or that the data covers only
// part of, counts toward the period's totals but never stands in for a
// whole month. Every expected figure below is worked out by hand.
import { describe, it, expect } from "vitest";
import { aggregateTransactionsByMonth, computeMetrics, periodStartDate } from "./financials.js";

const NO_MANUAL = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
const TODAY = "2026-11-04";
const txn = (txn_date, amount, description = amount > 0 ? "Client invoice" : "Supplier") => ({ txn_date, amount, description, category: null });
const partialFlags = rows => rows.map(r => [r.period_month.slice(0, 7), r.partial]);

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

  it("still counts every month's money in the period's totals", () => {
    const m = computeMetrics(rows, NO_MANUAL, "safe");
    expect(m.totRev).toBe(31500);      // 3 x 10,000 + 1,500
    expect(m.totExp).toBe(20000);      // 3 x 6,000 + 2,000
    expect(m.margin).toBeCloseTo((11500 / 31500) * 100, 6);
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
