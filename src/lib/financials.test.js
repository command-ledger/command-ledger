import { describe, it, expect } from "vitest";
import { fmt, pc, safe, detectExpenseCategory, parseAnyCSV, computeMetrics } from "./financials.js";

describe("fmt / pc / safe", () => {
  it("formats currency and percentages", () => {
    expect(fmt(1250)).toBe("$1,250");
    expect(pc(43.18)).toBe("43.2%");
  });

  it("never lets NaN/Infinity reach the UI", () => {
    expect(safe(NaN)).toBe(0);
    expect(safe(Infinity)).toBe(0);
    expect(safe(-Infinity)).toBe(0);
    expect(safe(undefined)).toBe(0);
    expect(fmt(NaN)).toBe("$0");
  });
});

describe("detectExpenseCategory", () => {
  it("matches known categories by keyword", () => {
    expect(detectExpenseCategory("Salary payment to John")).toBe("payroll");
    expect(detectExpenseCategory("Monthly AWS hosting fee")).toBe("software");
    expect(detectExpenseCategory("Office rent - March")).toBe("rent");
  });

  it("falls back to 'other' for unrecognized or missing text", () => {
    expect(detectExpenseCategory("Random unclassified text")).toBe("other");
    expect(detectExpenseCategory("")).toBe("other");
    expect(detectExpenseCategory(null)).toBe("other");
  });
});

describe("parseAnyCSV", () => {
  it("parses a named Revenue/Expenses export", () => {
    const csv = "Date,Revenue,Expenses\n2024-01-01,10000,6000\n2024-02-01,12000,6500\n";
    const result = parseAnyCSV(csv);
    expect(result.mode).toBe("named");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ revenue: 10000, expenses: 6000 });
    expect(result.rows[1]).toMatchObject({ revenue: 12000, expenses: 6500 });
  });

  it("parses a single Amount-column bank export and categorizes expenses", () => {
    const csv = "Date,Description,Amount\n2024-01-05,Client payment received,5000\n2024-01-10,AWS hosting fee,-200\n";
    const result = parseAnyCSV(csv);
    expect(result.mode).toBe("bank");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].revenue).toBe(5000);
    expect(result.rows[0].expenses).toBe(200);
    expect(result.rows[0].software).toBe(200); // AWS hosting -> software category
  });

  it("returns null for input with no data rows", () => {
    expect(parseAnyCSV("Date,Revenue,Expenses\n")).toBeNull();
    expect(parseAnyCSV("")).toBeNull();
  });
});

describe("computeMetrics — manual entry", () => {
  const manual = { mRev: 10000, mExp: 6000, mCash: 20000, mCac: 200, mLtv: 800, mLeads: 50, mClose: 10 };

  it("computes ratios matching hand-calculated values in safe mode", () => {
    const m = computeMetrics(null, manual, "safe");
    expect(m.margin).toBeCloseTo(40, 5);         // (10000-6000)/10000 * 100
    expect(m.conv).toBeCloseTo(20, 5);            // 10/50 * 100
    expect(m.ltvcac).toBeCloseTo(4, 5);           // 800/200
    expect(m.sov).toBeCloseTo(32, 5);             // 40*0.6 + 20*0.4
    expect(m.sovLbl).toBe("Defensive");           // 30 <= 32 < 50
    expect(m.taxV).toBeCloseTo(1200, 5);          // 4000 profit * 30% (safe mode)
    expect(m.safV).toBeCloseTo(800, 5);           // 4000 profit * 20% (safe mode)
    expect(m.free).toBeCloseTo(2000, 5);          // 4000 - 1200 - 800
    expect(m.burnMonths).toBeCloseTo(20800 / 6000, 5); // (cash + safety buffer) / avg expenses
    expect(m.hireReady).toBe(false);              // free (2000) is nowhere near 150,000
    expect(m.breakEven).toBeCloseTo(15000, 5);    // avgExp / (margin/100)
    expect(m.hasData).toBe(true);
  });

  it("uses the growth-mode reserve split (25% tax / 10% safety) instead of safe mode's (30%/20%)", () => {
    const m = computeMetrics(null, manual, "growth");
    expect(m.taxV).toBeCloseTo(1000, 5);          // 4000 * 25%
    expect(m.safV).toBeCloseTo(400, 5);           // 4000 * 10%
    expect(m.free).toBeCloseTo(2600, 5);          // 4000 - 1000 - 400
  });

  it("treats zero revenue as no data rather than dividing by zero", () => {
    const m = computeMetrics(null, { ...manual, mRev: 0, mExp: 0 }, "safe");
    expect(m.margin).toBe(0);
    expect(m.breakEven).toBe(0);
    expect(m.hasData).toBe(false); // rows is null AND mRev is 0
    expect(Number.isFinite(m.burnMonths)).toBe(true); // avgExp === 0 short-circuits to 0, not Infinity/NaN
  });
});

describe("computeMetrics — uploaded CSV rows", () => {
  const rows = [
    { revenue: 10000, expenses: 6000, cash: 5000, cogs: 0, marketing: 0, leads: 0, closures: 0, cac: 0, ltv: 0 },
    { revenue: 12000, expenses: 6500, cash: 8000, cogs: 0, marketing: 0, leads: 0, closures: 0, cac: 0, ltv: 0 },
  ];
  const manual = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };

  it("uses the latest row for point-in-time figures and totals across all rows for period figures", () => {
    const m = computeMetrics(rows, manual, "safe");
    expect(m.totRev).toBe(22000);
    expect(m.totExp).toBe(12500);
    expect(m.vel).toBeCloseTo(20, 5);             // (12000-10000)/10000 * 100, month-over-month
    expect(m.activeCash).toBe(8000);              // latest row's cash balance, not summed
    expect(m.n).toBe(2);
  });

  it("flags revenue concentration from the single highest-revenue month", () => {
    const m = computeMetrics(rows, manual, "safe");
    expect(m.concentration).toBeCloseTo((12000 / 22000) * 100, 5);
  });

  it("projects 90-day revenue by compounding the latest month-over-month growth rate three times", () => {
    const m = computeMetrics(rows, manual, "safe");
    expect(m.proj90).toBeCloseTo(12000 * Math.pow(1.2, 3), 5);
  });
});
