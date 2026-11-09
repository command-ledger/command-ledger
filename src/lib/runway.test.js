import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeMetrics, aggregateTransactionsByMonth, computeForwardRunway, checkAffordability, runScenario, periodStartDate,
  currentRunRate, cashMovementSince, estimateCashToday, cashTodayNote, buildRuleIndex, classificationKey, fmt,
} from "./financials.js";

// Runway is estimated cash today divided by current monthly burn. An audit found
// it could show 16.9 months for a business with 7.5 left, and call a cost
// affordable that would run it out of money. Every file here is invented, and
// every expected figure is worked by hand in the comment, not from the code.
const TODAY = "2026-07-15";
const NO = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
const month = (ym, rev, exp) => [
  { txn_date:`${ym}-05`, amount:rev, description:"Client payment Coastal Retail", category:null, currency:"ZAR" },
  { txn_date:`${ym}-28`, amount:-exp, description:"Office costs", category:"other", currency:"ZAR" },
];
const months = (t, rules = null) => aggregateTransactionsByMonth(t, { today: TODAY, rules });
// Wired as the Dashboard wires it: figures from the selected period, burn and
// cash from the whole history.
const run = (all, { from = null, balance = null, rules = null, mode = "safe" } = {}) => {
  const shown = from ? all.filter(t => t.txn_date >= from) : all;
  const moved = balance ? cashMovementSince(all, balance.on, rules) : null;
  return computeMetrics(months(shown, rules), NO, mode, {
    currency:"ZAR", today: TODAY, runRateRows: months(all, rules),
    cash: balance ? { ...balance, recorded: moved.recorded, lastDataOn: moved.lastDate } : null,
  });
};
const NINE = ["2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03"];
const LAST3 = ["2026-04","2026-05","2026-06"];
const SIX = ["2026-01","2026-02","2026-03","2026-04","2026-05","2026-06"];
// Burn R10,000 for nine months, then R40,000 for three.
const ROSE = [...NINE.flatMap(k => month(k, 90000, 100000)), ...LAST3.flatMap(k => month(k, 60000, 100000))];
const FRESH = amount => ({ amount, on: TODAY });

describe("Current burn", () => {
  it("averages the last 3 complete months", () => {
    // (40,000 + 40,000 + 40,000) / 3, not the 12-month 17,500.
    const r = currentRunRate(months(ROSE));
    expect(r.months).toBe(3);
    expect(r.revenue).toBe(60000);
    expect(r.expenses).toBe(100000);
    expect(r.burn).toBe(40000);
  });

  it("uses the last 3 when they differ from each other", () => {
    // Burn 10,000, 20,000, 30,000, 60,000. The last three: 110,000 / 3.
    const t = [...month("2026-03", 90000, 100000), ...month("2026-04", 80000, 100000), ...month("2026-05", 70000, 100000), ...month("2026-06", 40000, 100000)];
    expect(currentRunRate(months(t)).burn).toBeCloseTo(36666.67, 2);
  });

  it("leaves a month in progress out", () => {
    // July is to date, so its R500,000 is not a month of spending.
    const t = [...LAST3.flatMap(k => month(k, 60000, 100000)), { txn_date:"2026-07-03", amount:-500000, description:"Office costs", category:"other", currency:"ZAR" }];
    expect(currentRunRate(months(t)).burn).toBe(40000);
  });

  it("uses what there is with fewer than 3 complete months", () => {
    // (10,000 + 30,000) / 2.
    const t = [...month("2026-05", 90000, 100000), ...month("2026-06", 70000, 100000)];
    const r = currentRunRate(months(t));
    expect(r.months).toBe(2);
    expect(r.burn).toBe(20000);
  });

  it("counts money the owner takes out, because it empties the bank", () => {
    // Costs 100,000 + drawings 10,000 - revenue 90,000 = 20,000.
    const t = LAST3.flatMap(k => [...month(k, 90000, 100000), { txn_date:`${k}-15`, amount:-10000, description:"Owner drawings", category:"other", currency:"ZAR" }]);
    const r = currentRunRate(months(t));
    expect(r.financingOut).toBe(10000);
    expect(r.burn).toBe(20000);
  });

  it("does not let a loan received lower burn", () => {
    // Burn stays 10,000. A loan is a one-off addition to cash, not income.
    const t = [...LAST3.flatMap(k => month(k, 90000, 100000)), { txn_date:"2026-06-10", amount:200000, description:"Loan advance from Nedbank", category:null, currency:"ZAR" }];
    expect(currentRunRate(months(t)).burn).toBe(10000);
  });

  it("is safe with nothing to read", () => {
    expect(currentRunRate(null)).toMatchObject({ months: 0, burn: 0 });
    expect(currentRunRate([])).toMatchObject({ months: 0, burn: 0 });
  });
});

describe("Money recorded since a balance", () => {
  const T = [
    { txn_date:"2026-04-01", amount:-999, description:"Office costs" },
    { txn_date:"2026-04-02", amount:-100, description:"Office costs" },
    { txn_date:"2026-04-03", amount:500, description:"Client payment" },
    { txn_date:"2026-04-04", amount:-200, description:"Transfer to savings account" },
    { txn_date:"2026-04-05", amount:1000, description:"Loan advance from Nedbank" },
  ];

  it("counts what moved after the balance's date, not on it", () => {
    // -100 + 500 + 1,000. The -999 was already in a balance dated that day.
    const r = cashMovementSince(T, "2026-04-01", null);
    expect(r.recorded).toBe(1400);
    expect(r.lastDate).toBe("2026-04-05");
  });

  it("leaves out transfers, because the total across accounts did not change", () => {
    const r = cashMovementSince(T, "2026-04-03", null);
    expect(r.recorded).toBe(1000);
  });

  it("follows the founder's rule on what a transaction is", () => {
    // Told the loan is a transfer, it no longer adds to the total.
    const rules = buildRuleIndex([{ scope:"similar", match_key: classificationKey("Loan advance from Nedbank"), kind:"transfer" }]);
    expect(cashMovementSince(T, "2026-04-03", rules).recorded).toBe(0);
  });

  it("counts money nobody has identified, because it did reach the bank", () => {
    const t = [{ txn_date:"2026-04-02", amount:300, description:"EFT from K Ndlovu", reviewed:true }];
    expect(cashMovementSince(t, "2026-04-01", null).recorded).toBe(300);
  });

  it("still reports the newest date when nothing moved after the balance", () => {
    expect(cashMovementSince(T, "2026-06-01", null)).toMatchObject({ recorded: 0, lastDate: "2026-04-05" });
    expect(cashMovementSince([], "2026-06-01", null)).toMatchObject({ recorded: 0, lastDate: null });
  });
});

describe("Estimated cash today", () => {
  it("takes a balance dated today as it is", () => {
    expect(estimateCashToday({ amount: 300000, on: TODAY, burn: 40000, today: TODAY })).toMatchObject({ amount: 300000, estimated: 0, recorded: 0, gapDays: 0, usable: true });
  });

  it("adds what is recorded and estimates only the days with no data", () => {
    // 100,000 - 60,000 = 40,000 on 28 June. 17 days to 15 July at
    // 20,000 / 30.44 a day = 11,169.51. 40,000 - 11,169.51 = 28,830.49.
    const c = estimateCashToday({ amount: 100000, on: "2026-04-01", recorded: -60000, lastDataOn: "2026-06-28", burn: 20000, today: TODAY });
    expect(c.gapDays).toBe(17);
    expect(c.estimated).toBeCloseTo(11169.51, 2);
    expect(c.amount).toBeCloseTo(28830.49, 2);
    expect(c.usable).toBe(true);
  });

  it("never adds estimated income when there is no burn", () => {
    const c = estimateCashToday({ amount: 50000, on: "2026-06-01", recorded: 5000, lastDataOn: "2026-06-20", burn: -8000, today: TODAY });
    expect(c.amount).toBe(55000);
    expect(c.estimated).toBe(0);
  });

  it("treats an overdraft the records prove as real, with no estimate on top", () => {
    // 10,000 - 60,000 = -50,000, from transactions and not from a guess.
    const c = estimateCashToday({ amount: 10000, on: "2026-04-01", recorded: -60000, lastDataOn: "2026-06-28", burn: 20000, today: TODAY });
    expect(c).toMatchObject({ amount: -50000, estimated: 0, usable: true });
  });

  it("does not claim the money has gone when only the estimate says so", () => {
    // 70,000 - 60,000 = 10,000 recorded, less 11,169.51 estimated, is below zero.
    const c = estimateCashToday({ amount: 70000, on: "2026-04-01", recorded: -60000, lastDataOn: "2026-06-28", burn: 20000, today: TODAY });
    expect(c.usable).toBe(false);
    expect(c.reason).toBe("may_have_run_out");
  });

  it("will not estimate across more than 90 days with no data", () => {
    // 15 April to 15 July is 91 days. 16 April is 90.
    expect(estimateCashToday({ amount: 900000, on: "2026-04-15", burn: 1000, today: TODAY })).toMatchObject({ usable: false, reason: "too_old", gapDays: 91 });
    expect(estimateCashToday({ amount: 900000, on: "2026-04-16", burn: 1000, today: TODAY })).toMatchObject({ usable: true, gapDays: 90 });
  });

  it("uses the later of the balance's date and the last transaction", () => {
    const c = estimateCashToday({ amount: 100000, on: "2026-07-10", recorded: 0, lastDataOn: "2026-06-28", burn: 30440, today: TODAY });
    expect(c.gapDays).toBe(5);
    expect(c.estimated).toBe(5000);
  });

  it("does not estimate with no date to count from, or no today", () => {
    expect(estimateCashToday({ amount: 100000, burn: 40000, today: TODAY })).toMatchObject({ amount: 100000, estimated: 0, usable: true });
    expect(estimateCashToday({ amount: 100000, on: "2026-04-01", burn: 40000 })).toMatchObject({ amount: 100000, estimated: 0, usable: true });
  });

  it("does not estimate while the burn itself is on hold", () => {
    const c = estimateCashToday({ amount: 100000, on: "2026-06-01", burn: 40000, today: TODAY, burnOnHold: true });
    expect(c).toMatchObject({ amount: 100000, estimated: 0, usable: true });
  });

  it("shows its working, and is plainly an estimate", () => {
    const c = estimateCashToday({ amount: 100000, on: "2026-04-01", recorded: -60000, lastDataOn: "2026-06-28", burn: 20000, today: TODAY });
    const note = cashTodayNote(c, "ZAR");
    expect(note).toContain(`About ${fmt(28830.49, "ZAR")} today`);
    expect(note).toContain(`${fmt(100000, "ZAR")} on 2026-04-01`);
    expect(note).toContain(`less ${fmt(60000, "ZAR")} recorded since`);
    expect(note).toContain(`less about ${fmt(11169.51, "ZAR")} estimated for the 17 days with no data`);
    expect(note).not.toMatch(/[–—]/);
  });

  it("says plus when more came in than went out", () => {
    const c = estimateCashToday({ amount: 1000, on: TODAY, recorded: 500, today: TODAY });
    expect(cashTodayNote(c, "ZAR")).toContain(`plus ${fmt(500, "ZAR")} recorded since`);
  });

  it("has no working to show when nothing changed the balance", () => {
    expect(cashTodayNote(estimateCashToday({ amount: 1000, on: TODAY, today: TODAY }), "ZAR")).toBe("");
    expect(cashTodayNote(null, "ZAR")).toBe("");
  });
});

describe("Runway", () => {
  it("gives one business one answer, whatever period is selected", () => {
    // 300,000 / 40,000 = 7.5. The old code said 16.9, 11.8 and 7.3.
    const b = FRESH(300000);
    expect(run(ROSE, { balance: b, from: periodStartDate("12", TODAY) }).burnMonths).toBeCloseTo(7.5, 5);
    expect(run(ROSE, { balance: b, from: periodStartDate("6", TODAY) }).burnMonths).toBeCloseTo(7.5, 5);
    expect(run(ROSE, { balance: b, from: periodStartDate("3", TODAY) }).burnMonths).toBeCloseTo(7.5, 5);
  });

  it("still lets the period change the period's own totals", () => {
    // Twelve months of costs against three. The period filter keeps its job.
    const b = FRESH(300000);
    expect(run(ROSE, { balance: b, from: periodStartDate("12", TODAY) }).totExp).toBe(1200000);
    expect(run(ROSE, { balance: b, from: periodStartDate("3", TODAY) }).totExp).toBe(300000);
  });

  it("counts down from the money left, not from an old balance", () => {
    // 28,830.49 / 20,000 = 1.44. The old code said 4.8.
    const t = SIX.flatMap(k => month(k, 50000, 70000));
    const m = run(t, { balance: { amount: 100000, on: "2026-04-01" } });
    expect(m.burnMonths).toBeCloseTo(1.4415, 3);
    expect(m.activeCash).toBeCloseTo(28830.49, 2);
    expect(m.cashToday.recorded).toBe(-60000);
  });

  it("counts a 5-day-old balance down by 5 days", () => {
    // 40,000 x 5 / 30.44 = 6,570.30. 293,429.70 / 40,000 = 7.34.
    expect(run(ROSE, { balance: { amount: 300000, on: "2026-07-10" } }).burnMonths).toBeCloseTo(7.3357, 3);
  });

  it("sees a recovery as well as a decline", () => {
    // Burn fell to 10,000. 300,000 / 10,000 = 30. The old code said 9.0.
    const t = [...NINE.flatMap(k => month(k, 60000, 100000)), ...LAST3.flatMap(k => month(k, 90000, 100000))];
    expect(run(t, { balance: FRESH(300000) }).burnMonths).toBeCloseTo(30, 5);
  });

  it("follows the published formula, and the mode does not change it", () => {
    // 300,000 / 25,000 = 12. The old code said 11.8 in safe and 11.9 in growth.
    const t = SIX.flatMap(k => month(k, 75000, 100000));
    expect(run(t, { balance: FRESH(300000), mode: "safe" }).burnMonths).toBeCloseTo(12, 5);
    expect(run(t, { balance: FRESH(300000), mode: "growth" }).burnMonths).toBeCloseTo(12, 5);
  });

  it("reads no burn when the business has recovered, whatever its past", () => {
    const t = [...NINE.flatMap(k => month(k, 60000, 100000)), ...LAST3.flatMap(k => month(k, 110000, 100000))];
    const m = run(t, { balance: FRESH(300000) });
    expect(m.cashFlowPositive).toBe(true);
    expect(m.burnMonths).toBe(0);
  });

  it("reads burn when a profitable past has turned, whatever the average says", () => {
    // Nine months at +30,000 average out above three at -40,000. The old code said no burn.
    const t = [...NINE.flatMap(k => month(k, 130000, 100000)), ...LAST3.flatMap(k => month(k, 60000, 100000))];
    const m = run(t, { balance: FRESH(300000) });
    expect(m.cashFlowPositive).toBe(false);
    expect(m.burnMonths).toBeCloseTo(7.5, 5);
  });

  it("uses a month in progress for cash, but not for burn", () => {
    // Burn 10,000 from complete months. 300,000 on 1 July - 50,000 on 5 July.
    // 10 days at 10,000 / 30.44 = 3,285.15. 246,714.85 / 10,000 = 24.67.
    const t = [...LAST3.flatMap(k => month(k, 90000, 100000)), { txn_date:"2026-07-05", amount:-50000, description:"Office costs", category:"other", currency:"ZAR" }];
    const m = run(t, { balance: { amount: 300000, on: "2026-07-01" } });
    expect(m.netBurn).toBe(10000);
    expect(m.burnMonths).toBeCloseTo(24.6715, 3);
  });

  it("keeps a known overdraft at 0 months", () => {
    const m = run(ROSE, { balance: FRESH(-5000) });
    expect(m.burnMonths).toBe(0);
    expect(m.activeCash).toBe(-5000);
    expect(m.cashKnown).toBe(true);
  });

  it("shows nothing, not 0, when only an estimate says the money has gone", () => {
    const t = SIX.flatMap(k => month(k, 50000, 70000));
    const m = run(t, { balance: { amount: 70000, on: "2026-04-01" } });
    expect(m.runwayConfidence.shown).toBe(false);
    expect(m.runwayConfidence.reason).toMatch(/today's balance/);
    expect(m.hasCashData).toBe(false);
    expect(m.cashToday.usable).toBe(false);
  });

  it("waits while the money in is on hold, without estimating", () => {
    const t = LAST3.flatMap(k => [
      { txn_date:`${k}-05`, amount:60000, description:"EFT from K Ndlovu", category:null, currency:"ZAR", reviewed:true },
      { txn_date:`${k}-28`, amount:-100000, description:"Office costs", category:"other", currency:"ZAR" },
    ]);
    const m = run(t, { balance: { amount: 300000, on: "2026-07-01" } });
    expect(m.figuresOpen).toBe(true);
    expect(m.runwayConfidence.shown).toBe(false);
    expect(m.cashToday.estimated).toBe(0);
  });

  it("still takes a typed figure and a scenario by the plain formula", () => {
    // 300,000 / 25,000 = 12, with no history to read.
    const typed = computeMetrics(null, { ...NO, mRev: 75000, mExp: 100000, mCash: 300000 }, "safe", {});
    expect(typed.burnMonths).toBeCloseTo(12, 5);
    const s = runScenario({ revenue: 75000, expenses: 100000, cash: 300000 }, {}, "safe", { cashKnown: true });
    expect(s.before.burnMonths).toBeCloseTo(12, 5);
  });

  it("reads burn from the rows themselves when no longer history is given", () => {
    const m = computeMetrics(months(ROSE), NO, "safe", { currency:"ZAR", today: TODAY, cash: FRESH(300000) });
    expect(m.burnMonths).toBeCloseTo(7.5, 5);
  });
});

// Burn is read from the last 3 complete months, so whether burn can be trusted
// must be judged on those months too, not on the period on screen.
describe("Unidentified money and the burn window", () => {
  const unknown = (ym, amount) => ({ txn_date:`${ym}-10`, amount, description:"EFT from K Ndlovu", category:null, currency:"ZAR", reviewed:true });
  // Nine months: R100,000 revenue, R90,000 costs. Last three: R70,000 revenue,
  // R30,000 unidentified, R90,000 costs.
  // 12-month view: 90,000 / (1,110,000 + 90,000) = 7.5% unidentified, under the 10% line.
  // 3-month view: 90,000 / (210,000 + 90,000) = 30%.
  // Burn window, in every view: 30,000 / (70,000 + 30,000) = 30%. Confirmed burn is
  // 20,000, but if that money is revenue there is no burn at all. Nobody knows yet.
  const RECENT = [...NINE.flatMap(k => month(k, 100000, 90000)), ...LAST3.flatMap(k => [...month(k, 70000, 90000), unknown(k, 30000)])];

  it("waits in every view when the burn window itself is unidentified", () => {
    const b = FRESH(300000);
    const v12 = run(RECENT, { balance: b, from: periodStartDate("12", TODAY) });
    const v3 = run(RECENT, { balance: b, from: periodStartDate("3", TODAY) });
    expect(v12.figuresOpen).toBe(false);
    expect(v3.figuresOpen).toBe(true);
    for (const m of [v12, v3]) {
      expect(m.burnOpen).toBe(true);
      expect(m.runwayConfidence.shown).toBe(false);
      expect(m.burnMonths).toBe(0);
    }
  });

  it("does not estimate cash from a burn nobody can vouch for", () => {
    const m = run(RECENT, { balance: { amount: 300000, on: "2026-07-01" } });
    expect(m.cashToday.estimated).toBe(0);
  });

  it("does not score a runway nobody can vouch for as risk", () => {
    // Runway is 0 points when it is not known, whichever way the money turns out.
    const m = run(RECENT, { balance: FRESH(300000), from: periodStartDate("12", TODAY) });
    expect(m.risk.score).toBe(run(RECENT, { from: periodStartDate("12", TODAY) }).risk.score);
  });

  it("still gives the number when only older months are unidentified", () => {
    // Nine months: R50,000 revenue, R50,000 unidentified, R100,000 costs. Last
    // three: R60,000 revenue, nothing unidentified. Burn 40,000. 300,000 / 40,000 = 7.5.
    // The 12-month view's totals are on hold (450,000 of 1,080,000 is 41.7%), but
    // burn itself is known, so runway is the same in both views.
    const t = [...NINE.flatMap(k => [...month(k, 50000, 100000), unknown(k, 50000)]), ...LAST3.flatMap(k => month(k, 60000, 100000))];
    const b = FRESH(300000);
    const v12 = run(t, { balance: b, from: periodStartDate("12", TODAY) });
    const v3 = run(t, { balance: b, from: periodStartDate("3", TODAY) });
    expect(v12.figuresOpen).toBe(true);
    expect(v3.figuresOpen).toBe(false);
    expect(v12.burnOpen).toBe(false);
    expect(v12.burnMonths).toBeCloseTo(7.5, 5);
    expect(v3.burnMonths).toBeCloseTo(7.5, 5);
    expect(v12.runwayConfidence.shown).toBe(true);
  });

  it("still reads no burn when confirmed revenue already covers everything", () => {
    // R100,000 revenue against R90,000 costs. Unidentified money cannot create burn.
    const t = LAST3.flatMap(k => [...month(k, 100000, 90000), unknown(k, 50000)]);
    const m = run(t, { balance: FRESH(300000) });
    expect(m.burnOpen).toBe(true);
    expect(m.cashFlowPositive).toBe(true);
  });

  it("uses the same 10% line as the rest of the app", () => {
    // 10,000 / (90,000 + 10,000) = exactly 10%, on hold. 9,000 / 99,000 = 9.09%, not.
    const at = u => currentRunRate(months(LAST3.flatMap(k => [...month(k, 100000 - u, 150000), unknown(k, u)])));
    expect(at(10000).open).toBe(true);
    const under = currentRunRate(months(LAST3.flatMap(k => [...month(k, 90000, 150000), unknown(k, 9000)])));
    expect(under.open).toBe(false);
  });
});

describe("Burn follows the founder's own decisions", () => {
  it("moves when a cost is marked as a transfer", () => {
    // Costs 100,000 + a monthly R30,000 line, against 90,000 revenue: burn 40,000.
    // Told that line is a transfer between own accounts: burn 10,000.
    const t = LAST3.flatMap(k => [...month(k, 90000, 100000), { txn_date:`${k}-15`, amount:-30000, description:"Apex Holdings monthly payment", category:"other", currency:"ZAR" }]);
    expect(currentRunRate(months(t)).burn).toBe(40000);
    const rules = buildRuleIndex([{ scope:"similar", match_key: classificationKey("Apex Holdings monthly payment"), kind:"transfer" }]);
    expect(currentRunRate(months(t, rules)).burn).toBe(10000);
    expect(run(t, { balance: FRESH(300000), rules }).burnMonths).toBeCloseTo(30, 5);
  });
});

// Two cases the independent check of 9 November found. Both were live before
// this work: 3,435,973,836,800,000 months for a business that breaks even, and
// 19.8 and 49.8 months where 8.84 and an unknown were the truth.
describe("A business that breaks even exactly", () => {
  // In 100,001 + 100,000 + 100,000 = 300,001. Costs 66,667 + 66,667 + 66,666 =
  // 200,000. Drawings 33,334 + 33,333 + 33,334 = 100,001. Out 300,001. Burn 0.
  const parts = [["2026-04", 100001, 66667, 33334], ["2026-05", 100000, 66667, 33333], ["2026-06", 100000, 66666, 33334]];
  const even = parts.flatMap(([k, r, c, o]) => [...month(k, r, c), { txn_date:`${k}-15`, amount:-o, description:"Owner drawings", category:"other", currency:"ZAR" }]);

  it("reads no burn, not a runway of quadrillions of months", () => {
    expect(currentRunRate(months(even)).burn).toBe(0);
    const m = run(even, { balance: FRESH(50000) });
    expect(m.netBurn).toBe(0);
    expect(m.cashFlowPositive).toBe(true);
    expect(m.burnMonths).toBe(0);
  });

  it("still sees a burn of a few rand", () => {
    // Costs 300,000 + 1 against revenue 300,000 over three months: 0.33 a month.
    const t = [...month("2026-04", 100000, 100001), ...month("2026-05", 100000, 100000), ...month("2026-06", 100000, 100000)];
    const m = run(t, { balance: FRESH(50000) });
    expect(m.netBurn).toBe(0.33);
    expect(m.cashFlowPositive).toBe(false);
  });
});

describe("Data with no complete month", () => {
  const NOV9 = "2026-11-09";
  const spend = (from, to, perDay, description = "Office costs") => {
    const out = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      out.push({ txn_date: d.toISOString().slice(0, 10), amount: -perDay, description, category: "other", currency: "ZAR" });
    }
    return out;
  };
  const at = (t, balance) => {
    const rows = aggregateTransactionsByMonth(t, { today: NOV9 });
    const moved = cashMovementSince(t, balance.on, null);
    return computeMetrics(rows, NO, "safe", { currency:"ZAR", today: NOV9, runRateRows: rows, cash: { ...balance, recorded: moved.recorded, lastDataOn: moved.lastDate } });
  };

  it("measures burn per day across a 30-day statement", () => {
    // R1,000 a day from 10 September to 9 October: 30 days, R30,000. Both months
    // are partial. 1,000 x 30.44 = 30,440 a month.
    const t = spend("2026-09-10", "2026-10-09", 1000);
    const r = currentRunRate(aggregateTransactionsByMonth(t, { today: NOV9 }));
    expect(r.days).toBe(30);
    expect(r.burn).toBe(30440);
    // R300,000 on 9 October. 31 days to 9 November at 30,440 / 30.44 a day = 31,000.
    // 269,000 / 30,440 = 8.84. The old code said 19.8.
    const m = at(t, { amount: 300000, on: "2026-10-09" });
    expect(m.cashToday.estimated).toBe(31000);
    expect(m.activeCash).toBe(269000);
    expect(m.burnMonths).toBeCloseTo(8.8371, 3);
    expect(m.runwayConfidence).toMatchObject({ shown: true, level: "low" });
    expect(m.runwayConfidence.reason).toMatch(/30 days of data, with no complete month yet/);
  });

  it("accepts 28 days, the shortest February", () => {
    // 10 September to 7 October: 21 + 7 = 28 days.
    const r = currentRunRate(aggregateTransactionsByMonth(spend("2026-09-10", "2026-10-07", 1000), { today: NOV9 }));
    expect(r.days).toBe(28);
    expect(r.tooShort).toBeFalsy();
  });

  it("refuses 27 days", () => {
    // 10 September to 6 October: 21 + 6 = 27 days.
    const r = currentRunRate(aggregateTransactionsByMonth(spend("2026-09-10", "2026-10-06", 1000), { today: NOV9 }));
    expect(r.days).toBe(27);
    expect(r.tooShort).toBe(true);
  });

  it("shows nothing, and says why, with six days of data", () => {
    // 1 to 6 November. The old code said 49.8 months.
    const m = at(spend("2026-11-01", "2026-11-06", 1000), { amount: 300000, on: "2026-11-06" });
    expect(m.burnShort).toBe(true);
    expect(m.runwayConfidence.shown).toBe(false);
    expect(m.runwayConfidence.reason).toMatch(/28 days/);
    expect(m.burnMonths).toBe(0);
    expect(m.cashToday.estimated).toBe(0);
  });

  it("does not call six days of takings no burn", () => {
    // Money came in before the month's bills: it proves nothing about burn yet.
    const t = ["2026-11-02", "2026-11-04"].map(d => ({ txn_date: d, amount: 20000, description: "Client payment Coastal Retail", category: null, currency: "ZAR" }));
    const m = at(t, { amount: 300000, on: "2026-11-06" });
    expect(m.cashFlowPositive).toBe(false);
    expect(m.runwayConfidence.shown).toBe(false);
  });

  it("does not score a burn nobody has measured as risk", () => {
    const m = at(spend("2026-11-01", "2026-11-06", 1000), { amount: 300000, on: "2026-11-06" });
    const none = computeMetrics(aggregateTransactionsByMonth(spend("2026-11-01", "2026-11-06", 1000), { today: NOV9 }), NO, "safe", { currency:"ZAR", today: NOV9 });
    expect(m.risk.score).toBe(none.risk.score);
  });

  it("still holds a 30-day statement whose money in is unidentified", () => {
    // R70,000 identified, R30,000 unidentified over the 30 days: 30%, over the line.
    const t = [...spend("2026-09-10", "2026-10-09", 1000),
      { txn_date:"2026-09-20", amount:70000, description:"Client payment Coastal Retail", category:null, currency:"ZAR" },
      { txn_date:"2026-09-25", amount:30000, description:"EFT from K Ndlovu", category:null, currency:"ZAR", reviewed:true }];
    expect(at(t, { amount: 300000, on: "2026-10-09" }).burnOpen).toBe(true);
  });

  it("changes nothing once a month is complete", () => {
    // September complete, October partial: September alone, as before.
    const t = spend("2026-09-01", "2026-10-09", 1000);
    const r = currentRunRate(aggregateTransactionsByMonth(t, { today: NOV9 }));
    expect(r.months).toBe(1);
    expect(r.days).toBeUndefined();
    expect(r.burn).toBe(30000);
  });
});

describe("What runs on the same figures", () => {
  const m = run(ROSE, { balance: FRESH(300000) });

  it("runs the forward runway at the current rate", () => {
    // 300,000 at 40,000 / 30 a day crosses zero on day 225. The old code saw no crossing.
    const f = computeForwardRunway({ currentCash: m.activeCash, avgRev: m.runRev, avgExp: m.runExp, avgFinOut: m.runFinOut, obligations: [], fromDate: TODAY });
    expect(f.crossesZero).toBe(true);
    expect(f.daysUntilCross).toBe(225);
  });

  it("refuses a cost the business cannot carry at the current rate", () => {
    // 45,000 a month from R300,000 runs out in month 7. The old code said "holds for 12 months".
    const a = checkAffordability({ currentCash: m.activeCash, cashKnown: m.hasCashData, avgRev: m.runRev, avgExp: m.runExp, avgFinOut: m.runFinOut, obligations: [], monthlyCost: 5000, fromDate: TODAY, currency: "ZAR" });
    expect(a.affordable).toBe(false);
    expect(a.breaksInMonth).toBe(7);
  });

  it("does not ask the forward runway about an old balance", () => {
    const old = run(SIX.flatMap(k => month(k, 50000, 70000)), { balance: { amount: 70000, on: "2026-04-01" } });
    const a = checkAffordability({ currentCash: old.activeCash, cashKnown: old.hasCashData, avgRev: old.runRev, avgExp: old.runExp, avgFinOut: old.runFinOut, obligations: [], monthlyCost: 5000, fromDate: TODAY, currency: "ZAR" });
    expect(a.needsCash).toBe(true);
  });
});

// The wiring is the rule: these read the source, as the import checks do.
describe("How the app uses it", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const brief = readFileSync(new URL("../../supabase/functions/analyze-finances/index.ts", import.meta.url), "utf8");

  it("loads the whole history once and filters the period in the browser", () => {
    expect(app).not.toMatch(/\.gte\("txn_date", cutoff\)/);
    expect(app).toMatch(/runRateRows/);
  });

  it("gives the forward runway and the cost check the current rate", () => {
    expect(app).toMatch(/computeForwardRunway\(\{ currentCash: activeCash, avgRev: runRev, avgExp: runExp, avgFinOut: runFinOut,/);
    expect(app).toMatch(/checkAffordability\(\{ currentCash: activeCash, cashKnown: hasCashData, avgRev: runRev, avgExp: runExp, avgFinOut: runFinOut,/);
  });

  it("reads burn and cash from the business currency only", () => {
    expect(app).toMatch(/const \{ included: allBaseTxns \} = useMemo\(\(\) => partitionByCurrency\(allMarkedTxns, cur\)/);
    expect(app).toMatch(/aggregateTransactionsByMonth\(allBaseTxns,/);
    expect(app).toMatch(/cashMovementSince\(allBaseTxns,/);
  });

  it("holds everything built on burn on the same test as burn", () => {
    expect(app).toMatch(/activeObligations\.length > 0 && !burnOpen && !burnShort\)/);
    expect(app).toMatch(/: burnOpen \? \{ affordable: false, pendingReview: true/);
    expect(app).toMatch(/runwayKnown: hasCashData && !burnOpen && !burnShort,/);
  });

  it("waits for 28 days of data everywhere burn is used", () => {
    expect(app).toMatch(/activeObligations\.length > 0 && !burnOpen && !burnShort\)/);
    expect(app).toMatch(/: burnShort \? \{ affordable: false, pendingReview: true, message: "This cannot be answered yet: there is less than a month of data/);
    expect(app).toMatch(/runwayKnown: hasCashData && !burnOpen && !burnShort,/);
    expect(app).toMatch(/burnShort \? "Needs at least 28 days of data"/);
    expect(app).toMatch(/m\.burnShort \? "Needs at least 28 days of data\."/);
  });

  it("does not claim no balance was entered when the saved one cannot be used", () => {
    expect(app).toMatch(/cashToday && !cashToday\.usable \? \{ affordable: false, pendingReview: true, message: "This cannot be answered until you enter today's cash balance/);
  });

  it("no longer publishes the old formula anywhere", () => {
    expect(app).not.toMatch(/less the reserve mode's safety share/);
    expect(app).not.toMatch(/divided by average monthly net burn/);
    expect(app).not.toMatch(/on average burn/);
  });

  it("tells the advisor what runway is measured from", () => {
    expect(app).toMatch(/cashToday:/);
    expect(brief).toMatch(/cashToday/);
    expect(brief).not.toMatch(/smoothed/);
  });
});
