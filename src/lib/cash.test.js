// The cash balance: saved and dated, the newest one used, an overdraft or a
// zero balance read as real. Every expected figure below is worked out by
// hand in the comment beside it.
import { describe, it, expect } from "vitest";
import { effectiveCashBalance, computeMetrics, computeDirective, checkAffordability, runScenario, parseAnyCSV } from "./financials.js";

const NO_MANUAL = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
// Net burn 1,000 a month.
const months = ["2026-08-01", "2026-09-01", "2026-10-01"].map(period_month => ({ period_month, revenue: 9000, expenses: 10000 }));

describe("effectiveCashBalance", () => {
  const profile = { cash_balance: 48000, cash_balance_on: "2026-11-04", cash_balance_currency: "ZAR" };
  const upload = { closing_balance: 50000, closing_balance_on: "2026-10-31", currency: "ZAR", filename: "oct.csv", uploaded_at: "2026-11-01T10:00:00Z" };

  it("uses the newest balance", () => {
    expect(effectiveCashBalance({ profile, batches: [upload], baseCurrency: "ZAR" }))
      .toEqual({ amount: 48000, on: "2026-11-04", source: "entered", filename: null, currency: "ZAR" });
    const newerFile = { ...upload, closing_balance_on: "2026-11-05" };
    expect(effectiveCashBalance({ profile, batches: [newerFile], baseCurrency: "ZAR" }))
      .toEqual({ amount: 50000, on: "2026-11-05", source: "upload", filename: "oct.csv", currency: "ZAR" });
  });

  it("prefers the founder's figure on the same date, then the latest upload", () => {
    const sameDay = { ...profile, cash_balance_on: "2026-10-31" };
    expect(effectiveCashBalance({ profile: sameDay, batches: [upload], baseCurrency: "ZAR" }).source).toBe("entered");
    const reupload = { ...upload, closing_balance: 51000, uploaded_at: "2026-11-02T09:00:00Z", filename: "oct-again.csv" };
    expect(effectiveCashBalance({ profile: null, batches: [upload, reupload], baseCurrency: "ZAR" }))
      .toMatchObject({ amount: 51000, filename: "oct-again.csv" });
  });

  it("keeps an overdraft and a zero balance, and reads numbers sent as text", () => {
    expect(effectiveCashBalance({ profile: { ...profile, cash_balance: -2500 }, batches: [], baseCurrency: "ZAR" }).amount).toBe(-2500);
    expect(effectiveCashBalance({ profile: { ...profile, cash_balance: 0 }, batches: [], baseCurrency: "ZAR" }).amount).toBe(0);
    expect(effectiveCashBalance({ profile: { ...profile, cash_balance: "1234.50" }, batches: [], baseCurrency: "ZAR" }).amount).toBe(1234.5);
  });

  it("never uses a balance in another currency, without a date, or with no business currency", () => {
    expect(effectiveCashBalance({ profile: { ...profile, cash_balance_currency: "USD" }, batches: [{ ...upload, currency: "USD" }], baseCurrency: "ZAR" })).toBeNull();
    expect(effectiveCashBalance({ profile: { ...profile, cash_balance_on: null }, batches: [{ ...upload, closing_balance_on: null }], baseCurrency: "ZAR" })).toBeNull();
    expect(effectiveCashBalance({ profile, batches: [upload], baseCurrency: null })).toBeNull();
  });

  it("has nothing when no balance was ever given", () => {
    expect(effectiveCashBalance({ profile: { cash_balance: null }, batches: [{ closing_balance: null, currency: "ZAR" }], baseCurrency: "ZAR" })).toBeNull();
  });
});

describe("runway from a known balance", () => {
  it("measures runway from a saved balance", () => {
    const m = computeMetrics(months, NO_MANUAL, "safe", { cash: { amount: 10000, on: "2026-11-04" }, today: "2026-11-04" });
    expect(m.cashKnown).toBe(true);
    expect(m.cashOn).toBe("2026-11-04");
    expect(m.burnMonths).toBeCloseTo(9.8, 6); // (10,000 - 1,000 x 0.20) / 1,000
    expect(m.runwayConfidence).toMatchObject({ shown: true, level: "moderate" }); // 3 months of data
  });

  it("reads an overdraft or an empty account as no runway, not as missing", () => {
    for (const amount of [0, -2500]) {
      const m = computeMetrics(months, NO_MANUAL, "safe", { cash: { amount, on: "2026-11-04" }, today: "2026-11-04" });
      expect(m.activeCash).toBe(amount);
      expect(m.burnMonths).toBe(0);
      expect(m.runwayConfidence.shown).toBe(true);
      expect(m.risk.breakdown.runwayRisk).toBe(100);
    }
  });

  it("never reports negative runway when cash is below the safety share", () => {
    const m = computeMetrics(months, { ...NO_MANUAL, mCash: 100 }, "safe"); // (100 - 200) / 1,000 would be -0.1
    expect(m.burnMonths).toBe(0);
  });

  it("lowers confidence in runway from a balance weeks old", () => {
    const m = computeMetrics(months, NO_MANUAL, "safe", { cash: { amount: 10000, on: "2026-08-31" }, today: "2026-11-04" });
    expect(m.runwayConfidence.level).toBe("low"); // moderate, one level down
    expect(m.runwayConfidence.reason).toContain("a cash balance from 2026-08-31, 65 days ago");
  });

  it("keeps the old meaning of a typed zero when no balance is known", () => {
    const m = computeMetrics(months, NO_MANUAL, "safe");
    expect(m.cashKnown).toBe(false);
    expect(m.runwayConfidence.shown).toBe(false);
  });

  it("treats a file's own closing balance as known, even when overdrawn", () => {
    const csv = `Date,Description,Amount,Balance
2026-10-01,Client invoice,9000,1000
2026-10-30,Rent,-10000,"-9000"`;
    const m = computeMetrics(parseAnyCSV(csv).rows, NO_MANUAL, "safe");
    expect(m.cashKnown).toBe(true);
    expect(m.activeCash).toBe(-9000);
    expect(m.burnMonths).toBe(0);
  });
});

describe("the runway directive", () => {
  const base = { margin: 5, burnMonths: 0, free: 1000, vel: 0, conv: 0, ltvcac: 0, months: 3, concentration: null };

  it("fires at zero runway once a balance is known", () => {
    const d = computeDirective({ ...base, runwayKnown: true, cashFlowPositive: false });
    expect(d.rule).toBe("low_runway");
    expect(d.reason).toContain("no longer covers a month of net burn");
  });

  it("stays silent about runway when no balance is known, or nothing burns", () => {
    expect(computeDirective(base).rule).not.toBe("low_runway");
    expect(computeDirective({ ...base, runwayKnown: true, cashFlowPositive: true }).rule).not.toBe("low_runway");
  });

  it("names a loss as a loss", () => {
    const d = computeDirective({ ...base, free: -12000, currency: "USD" });
    expect(d.rule).toBe("negative_free_cash");
    expect(d.reason).toContain("made a loss of $12,000");
  });
});

describe("affordability from a known balance", () => {
  const args = { avgRev: 10000, avgExp: 8000, obligations: [], monthlyCost: 1000, fromDate: "2026-11-04", currency: "USD" };

  it("says an overdrawn business has no cash for a new cost, even when profit covers it", () => {
    const r = checkAffordability({ ...args, currentCash: -500, cashKnown: true });
    expect(r).toMatchObject({ affordable: false, overdrawn: true });
    expect(r.message).toContain("average monthly profit ($2,000) covers this, but your cash balance is -$500");
  });

  it("says so plainly when profit does not cover it either", () => {
    const r = checkAffordability({ ...args, currentCash: 0, cashKnown: true, monthlyCost: 3000 });
    expect(r.affordable).toBe(false);
    expect(r.message).toContain("does not cover this");
  });

  it("still reads an unknown zero as no balance entered", () => {
    expect(checkAffordability({ ...args, currentCash: 0 }).needsCash).toBe(true);
  });
});

describe("scenarios from a known balance", () => {
  it("keep an overdraft as it is", () => {
    const { before, after } = runScenario({ revenue: 9000, expenses: 10000, cash: -2000 }, { cashDelta: 15000 }, "safe", { cashKnown: true });
    expect(before.activeCash).toBe(-2000);
    expect(before.burnMonths).toBe(0);
    expect(after.activeCash).toBe(13000);
    expect(after.burnMonths).toBeCloseTo(12.8, 6); // (13,000 - 1,000 x 0.20) / 1,000
  });
});
