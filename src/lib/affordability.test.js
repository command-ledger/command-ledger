// Affordability (correction plan, revision 4: defect 4, D1, D2, D9, D10a,
// D10c; Phase 1, task 4). A cost is affordable only when it passes both the
// survival test and the safety-floor test, over 12 monthly payments, from the
// same three calendar months runway uses. Anything missing holds the answer.
// Every expected figure is worked by hand from the plan's examples.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkAffordability, accountCoverage, judgementWindow, aggregateTransactionsByMonth, currentRunRate,
  runRateRowsWithQuietMonths, computeMetrics, fmt,
} from "./financials.js";

const TODAY = "2026-07-15";
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tx = (batch, txn_date, amount, description) => ({
  source_batch_id: batch, txn_date, amount, category: null, currency: "ZAR",
  description: description || (amount > 0 ? "Invoice Acme Trading" : "Office rent"),
});
const cheque = (n, fields = {}) => ({ id: ID(n), currency: "ZAR", filename: `file-${n}.csv`, account_label: "Cheque", reconciliation_status: null, ...fields });
const named = (n, label, fields = {}) => cheque(n, { account_label: label, ...fields });
const verified = (fields = {}) => ({ reconciliation_status: "verified", duplicate_count: 0, ...fields });
// One month: revenue on the 5th, costs on the 28th.
const month = (b, ym, revenue, costs) => [tx(b, `${ym}-05`, revenue), tx(b, `${ym}-28`, -costs)];
const WINDOW = ["2026-04", "2026-05", "2026-06"];
const R = n => fmt(n, "ZAR");

// A business with the same revenue and costs in April, May and June.
function steady(revenue = 100000, costs = 100000) {
  return { batches: [cheque(1)], transactions: WINDOW.flatMap(ym => month(ID(1), ym, revenue, costs)) };
}
function check(biz, { cash = 131000, cost = 10000, answers = [], today = TODAY, from = today, ...rest } = {}) {
  const sorted = [...biz.transactions].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const coverage = accountCoverage({ transactions: sorted, batches: biz.batches, answers, today });
  return checkAffordability({
    currentCash: cash, cashKnown: cash !== null, window: judgementWindow(coverage, { today }), coverage,
    obligations: [], monthlyCost: cost, fromDate: from, currency: "ZAR", ...rest,
  });
}

describe("affordability: 12 payments, two tests", () => {
  it("counts 12 payments, 15 July 2026 to 15 June 2027; the 15 July 2027 payment opens the next year", () => {
    const r = check(steady());
    expect(r.payments).toHaveLength(12);
    expect(r.payments[0]).toBe("2026-07-15");
    expect(r.payments[11]).toBe("2027-06-15");
    expect(r.payments).not.toContain("2027-07-15");
  });

  // Cash R131,000; revenue and costs R100,000 a month; R10,000 a month from today.
  // Floor 100,000 + 10,000 = 110,000. Balances: 121,000 (15 Jul), 111,000 (15 Aug),
  // 101,000 (15 Sep): below the floor. After the 12th: 131,000 - 120,000 = 11,000.
  it("R131,000: survival passes, the floor fails on 15 September 2026, not affordable, R11,000 left", () => {
    const r = check(steady());
    expect(r).toMatchObject({ status: "not_affordable", affordable: false, held: false, reason: "floor",
      floor: 110000, floorDate: "2026-09-15", lowest: 11000, afterTwelfth: 11000 });
    expect(r.message).toContain(`Not affordable: cash does not run out in 12 months, but it falls below your safety floor of ${R(110000)} on 15 September 2026.`);
    expect(r.message).toContain(`${R(11000)} would be left after the 12th payment`);
  });

  it("R230,000 ends exactly on the floor: affordable. R229,000 fails at the 12th payment, at R109,000", () => {
    const pass = check(steady(), { cash: 230000 });
    expect(pass).toMatchObject({ status: "affordable", affordable: true, held: false, floor: 110000, lowest: 110000, afterTwelfth: 110000 });
    expect(pass.message).toContain(`Affordable: cash stays above your safety floor of ${R(110000)} through all 12 payments`);
    const fail = check(steady(), { cash: 229000 });
    expect(fail).toMatchObject({ status: "not_affordable", reason: "floor", floorDate: "2027-06-15", lowest: 109000, afterTwelfth: 109000 });
  });

  it("with the floor at zero the two tests are one: R131,000 and R125,000 pass, R120,000 runs out in month 12", () => {
    expect(check(steady(), { floorBasis: "zero" })).toMatchObject({ status: "affordable", afterTwelfth: 11000 });
    expect(check(steady(), { cash: 125000, floorBasis: "zero" })).toMatchObject({ status: "affordable", afterTwelfth: 5000 });
    const out = check(steady(), { cash: 120000, floorBasis: "zero" });
    expect(out).toMatchObject({ status: "not_affordable", reason: "runs_out", breaksInMonth: 12, breakDate: "2027-06-15" });
    expect(out.message).toContain("cash runs out in month 12");
    expect(out.message).toContain("15 June 2027");
  });

  it("revenue R120,000 with R131,000 cash: affordable, and the lowest balance is R121,000", () => {
    // Flow +20,000 a month; the low point is straight after the first payment.
    expect(check(steady(120000, 100000))).toMatchObject({ status: "affordable", lowest: 121000, floor: 110000 });
  });

  it("revenue R120,000 with R100,000 cash: cash starts below the R110,000 floor, not affordable", () => {
    const r = check(steady(120000, 100000), { cash: 100000 });
    expect(r).toMatchObject({ status: "not_affordable", reason: "below_floor_today", floor: 110000 });
    expect(r.message).toContain("Not affordable");
  });

  it("the floor counts loan repayments and owner drawings with costs", () => {
    // Each month: 100,000 in, 80,000 costs, 15,000 loan repayment. Outgoings 95,000; floor 105,000.
    const biz = { batches: [cheque(1)], transactions: WINDOW.flatMap(ym => [...month(ID(1), ym, 100000, 80000), tx(ID(1), `${ym}-20`, -15000, "Loan repayment")]) };
    const r = check(biz, { cash: 300000 });
    expect(r.floor).toBe(105000);
    // Flow 100,000 - 95,000 = +5,000 a month against 10,000: the balance falls about 5,000 a month.
    expect(r.status).toBe("affordable");
  });

  it("starting 31 January 2027: payments fall on the last day of shorter months, the 12th on 31 December 2027", () => {
    const biz = { batches: [cheque(1)], transactions: ["2026-10", "2026-11", "2026-12"].flatMap(ym => month(ID(1), ym, 100000, 100000)) };
    const r = check(biz, { cash: 500000, today: "2027-01-31" });
    expect(r.payments.slice(0, 4)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(r.payments[11]).toBe("2027-12-31");
  });

  it("a start on the 28th of February stays on the 28th", () => {
    const biz = { batches: [cheque(1)], transactions: ["2026-11", "2026-12", "2027-01"].flatMap(ym => month(ID(1), ym, 100000, 100000)) };
    const r = check(biz, { cash: 500000, today: "2027-02-28" });
    expect(r.payments.slice(0, 3)).toEqual(["2027-02-28", "2027-03-28", "2027-04-28"]);
  });

  it("known bills are paid on their real dates", () => {
    // Costs of 100,000 include rent of 20,000 on the 1st. Background flow is then
    // 100,000 - 80,000 = +20,000 a month (666.67 a day), and rent leaves on each 1st.
    // 15 Jul: 121,000. 1 Aug (17 days): +11,333.33 - 20,000 = 112,333.33.
    // 15 Aug (14 days): +9,333.33 - 10,000 = 111,666.67. 1 Sep (17 days): +11,333.33 - 20,000 = 103,000.
    const rent = { label: "Rent", cadence: "monthly", typical_amount: 20000, next_expected: "2026-08-01", day_of_month: 1, active: true };
    const r = check(steady(), { obligations: [rent] });
    expect(r).toMatchObject({ status: "not_affordable", reason: "floor", floorDate: "2026-09-01" });
  });
});

describe("affordability: when an answer is given at all", () => {
  it("no cash balance entered: held, even for a profitable business", () => {
    const r = check(steady(120000, 100000), { cash: null });
    expect(r).toMatchObject({ status: "held", held: true, affordable: false, reason: "no_cash" });
    expect(r.message).toMatch(/enter today's cash balance/i);
  });

  it("a cash estimate that cannot be used: held", () => {
    const r = check(steady(), { cashUsable: false });
    expect(r).toMatchObject({ status: "held", reason: "cash_unusable" });
    expect(r.message).toMatch(/enter today's cash balance/i);
  });

  it("a recorded overdraft: not affordable, whatever the window shows", () => {
    expect(check(steady(200000, 100000), { cash: -500 })).toMatchObject({ status: "not_affordable", reason: "no_cash_left", held: false });
    expect(check(steady(), { cash: 0 })).toMatchObject({ status: "not_affordable", reason: "no_cash_left" });
    // Even with a month missing: the overdraft is decided first.
    const gap = { batches: [cheque(1)], transactions: ["2026-04", "2026-06"].flatMap(ym => month(ID(1), ym, 100000, 100000)) };
    expect(check(gap, { cash: -500 })).toMatchObject({ status: "not_affordable", reason: "no_cash_left" });
  });

  it("the missing-month business: held, naming May, with no date and no month number", () => {
    // March and April 90,000 in, 100,000 out; no May; June 60,000 in, 100,000 out. Cash 200,000.
    const biz = { batches: [cheque(1)], transactions: [...month(ID(1), "2026-03", 90000, 100000), ...month(ID(1), "2026-04", 90000, 100000), ...month(ID(1), "2026-06", 60000, 100000)] };
    const r = check(biz, { cash: 200000 });
    expect(r).toMatchObject({ status: "held", reason: "window", missingMonths: ["2026-05"] });
    expect(r.message).toContain("May 2026 has no transactions on file for Cheque");
    expect(r.message).toContain("Upload May's statement");
    expect(r.message).not.toMatch(/month \d|2027|runs out/);
    expect(r.breakDate).toBeUndefined();
    expect(r.breaksInMonth).toBeUndefined();
  });

  it("data starting 1 May, today 15 July: only May and June are complete, held", () => {
    const biz = { batches: [cheque(1)], transactions: [tx(ID(1), "2026-05-01", 100000), tx(ID(1), "2026-05-28", -100000), ...month(ID(1), "2026-06", 100000, 100000)] };
    const r = check(biz);
    expect(r).toMatchObject({ status: "held", reason: "window", missingMonths: ["2026-04"] });
    expect(r.message).toContain("April 2026");
  });

  it("June data stops on 20 June: June is part of a month inside April to June, held", () => {
    // The window never moves back to March to May (D1, 14 November 2026).
    const biz = { batches: [cheque(1)], transactions: [...["2026-03", "2026-04", "2026-05"].flatMap(ym => month(ID(1), ym, 100000, 100000)), tx(ID(1), "2026-06-05", 100000), tx(ID(1), "2026-06-20", -100000)] };
    const r = check(biz);
    expect(r).toMatchObject({ status: "held", reason: "window", missingMonths: ["2026-06"] });
    expect(r.message).toContain("June 2026");
  });

  it("two named accounts, one with no May and no confirmation: held; confirmed with a verified balance: answered", () => {
    const savings = named(2, "Savings", verified({ period_start: "2026-04-02", period_end: "2026-06-28" }));
    const biz = { batches: [cheque(1), savings], transactions: [...steady().transactions,
      tx(ID(2), "2026-04-02", 250), tx(ID(2), "2026-04-28", 250), tx(ID(2), "2026-06-02", 250), tx(ID(2), "2026-06-28", 250)] };
    const held = check(biz);
    expect(held).toMatchObject({ status: "held", reason: "window", missingMonths: ["2026-05"] });
    expect(held.message).toContain("Savings");
    const answered = check(biz, { answers: [{ account_key: "savings", kind: "no_transactions_month", slot: "month:2026-05", month: "2026-05-01" }] });
    expect(answered.held).toBe(false);
    expect(answered.windowMonths).toEqual(WINDOW);
  });

  it("a stopped account not yet answered: held, asking; closed on 31 March: answered from the remaining account", () => {
    const payroll = named(2, "Payroll");
    const biz = { batches: [cheque(1), payroll], transactions: [
      ...["2026-01", "2026-02", "2026-03"].flatMap(ym => month(ID(1), ym, 100000, 100000)), ...steady().transactions,
      ...["2026-01", "2026-02", "2026-03"].flatMap(ym => month(ID(2), ym, 5000, 4000))] };
    const held = check(biz);
    expect(held).toMatchObject({ status: "held", reason: "account_question" });
    expect(held.message).toMatch(/Tell us whether Payroll is closed/);
    const answered = check(biz, { answers: [{ account_key: "payroll", kind: "closed", slot: "status", closed_on: "2026-03-31" }] });
    expect(answered.held).toBe(false);
    expect(answered).toMatchObject({ status: "not_affordable", reason: "floor", floor: 110000 });
  });

  it("an older unnamed upload nobody has identified, with months missing: held, asking which account it is", () => {
    const old = { id: ID(2), currency: "ZAR", filename: "old-export.csv", account_label: null, reconciliation_status: null };
    const biz = { batches: [cheque(1), old], transactions: [...steady().transactions, ...month(ID(2), "2026-04", 500, 100)] };
    const r = check(biz);
    expect(r).toMatchObject({ status: "held", reason: "account_question" });
    expect(r.message).toContain("old-export.csv");
  });

  it("no uploaded history: held", () => {
    const r = checkAffordability({ currentCash: 50000, cashKnown: true, window: judgementWindow(accountCoverage({ transactions: [], batches: [], answers: [], today: TODAY }), { today: TODAY }),
      coverage: null, obligations: [], monthlyCost: 1000, fromDate: TODAY, currency: "ZAR" });
    expect(r).toMatchObject({ status: "held", reason: "window" });
  });
});

// D9: money nobody has identified can hold the answer.
describe("affordability: unidentified money in the window (D9)", () => {
  const unidentified = (b, ym, amount) => ({ ...tx(b, `${ym}-10`, amount, "Deposit 4471"), reviewed: true });
  const biz = (identified, unknown, costs) => ({ batches: [cheque(1)],
    transactions: WINDOW.flatMap(ym => [...month(ID(1), ym, identified, costs), unidentified(ID(1), ym, unknown)]) });

  it("R27,000 unidentified could reverse a R12,000 loss: held, with both ends stated", () => {
    // 3 x 91,000 = 273,000 in, 3 x 95,000 = 285,000 out: a loss of 12,000.
    // With the 27,000: 300,000 - 285,000 = a profit of 15,000. Share 27,000 / 300,000 = 9%.
    const r = check(biz(91000, 9000, 95000), { cash: 500000 });
    expect(r).toMatchObject({ status: "held", reason: "unconfirmed" });
    expect(r.message).toContain(R(27000));
    expect(r.message).toContain(R(12000));
    expect(r.message).toContain(R(15000));
    expect(r.message).toMatch(/Identify your money in first/);
  });

  it("R9,000 unidentified cannot cover a R12,000 loss: the answer is given", () => {
    const r = check(biz(91000, 3000, 95000), { cash: 500000 });
    expect(r.held).toBe(false);
    expect(r.floor).toBe(105000); // 95,000 + 10,000
  });

  it("unidentified money exactly equal to the loss: held", () => {
    expect(check(biz(91000, 4000, 95000), { cash: 500000 })).toMatchObject({ status: "held", reason: "unconfirmed" });
  });

  it("unidentified money at 10% or more of money in: held, as before", () => {
    // 3 x 20,000 of 3 x 120,000 + 3 x 20,000 = 14.3%. The business is profitable either way.
    expect(check(biz(120000, 20000, 95000), { cash: 500000 })).toMatchObject({ status: "held", reason: "unconfirmed" });
  });

  it("a profit cannot be reversed by more money in: under 10%, the answer is given", () => {
    // 3 x 5,000 = 15,000 unidentified against a profit of 3 x 5,000 = 15,000; share 15,000 / 315,000 = 4.8%.
    expect(check(biz(100000, 5000, 95000), { cash: 500000 }).held).toBe(false);
  });
});

describe("affordability: wording and consistency", () => {
  const everyCase = () => {
    const gap = { batches: [cheque(1)], transactions: ["2026-04", "2026-06"].flatMap(ym => month(ID(1), ym, 100000, 100000)) };
    return [
      check(steady()), check(steady(), { cash: 230000 }), check(steady(), { cash: 229000 }), check(steady(), { cash: 120000, floorBasis: "zero" }),
      check(steady(120000, 100000), { cash: 100000 }), check(steady(), { cash: null }), check(steady(), { cashUsable: false }),
      check(steady(), { cash: -500 }), check(gap), check(steady(60000, 100000), { cash: 150000 }),
    ];
  };

  it("only a pass says affordable or holds; a failed or held result never does", () => {
    everyCase().forEach(r => {
      if (r.status === "affordable") { expect(r.message).toMatch(/^Affordable/); return; }
      expect(r.affordable).toBe(false);
      expect(r.message).not.toMatch(/\bholds\b/i);
      expect(r.message.replace(/not affordable/gi, "")).not.toMatch(/affordable/i);
    });
  });

  it("every answer given states the lowest balance and the balance after the 12th payment", () => {
    everyCase().filter(r => !r.held && !["no_cash_left", "below_floor_today"].includes(r.reason)).forEach(r => {
      expect(Number.isFinite(r.lowest)).toBe(true);
      expect(Number.isFinite(r.afterTwelfth)).toBe(true);
      expect(r.message).toMatch(/lowest balance/);
      expect(r.message).toMatch(/12th payment/);
    });
  });

  it("a held answer is neither a pass nor a fail and carries no result figures", () => {
    everyCase().filter(r => r.held).forEach(r => {
      expect(r.status).toBe("held");
      expect(r.lowest).toBeUndefined();
      expect(r.message).toMatch(/^Not answered yet/);
    });
  });

  it("cash runs out: the month is numbered by payment", () => {
    // Revenue 60,000, costs 100,000: burn 40,000 a month plus the new 10,000. Cash 150,000.
    // 15 Jul: 140,000. Each day -1,333.33. 15 Aug (31 days): 140,000 - 41,333.33 - 10,000 = 88,666.67.
    // 15 Sep: 88,666.67 - 41,333.33 - 10,000 = 37,333.33. Then 28 days of 1,333.33 = 37,333.33: zero on 13 October,
    // inside the month that starts with the 3rd payment (15 September).
    const r = check(steady(60000, 100000), { cash: 150000, floorBasis: "zero" });
    expect(r).toMatchObject({ status: "not_affordable", reason: "runs_out", breaksInMonth: 3, breakDate: "2026-10-13" });
  });

  it("reads its flows from the window, never from the run rate", () => {
    const src = readFileSync(new URL("./financials.js", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function checkAffordability("), src.indexOf("export function detectMissedObligations("));
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/currentRunRate|avgRev|runRev/);
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(app).toMatch(/checkAffordability\(\{[^}]*window: judgement/);
    expect(app).not.toMatch(/checkAffordability\(\{[^}]*avgRev/);
  });

  it("whenever an answer is given, the window's months are the run rate's, and burn and cash today equal runway's", () => {
    const NO_MANUAL = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const cases = [steady(), steady(60000, 100000), steady(120000, 100000),
      { batches: [cheque(1)], transactions: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].flatMap((ym, i) => month(ID(1), ym, 80000 + i * 5000, 100000)) }];
    cases.forEach(biz => {
      const sorted = [...biz.transactions].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
      const coverage = accountCoverage({ transactions: sorted, batches: biz.batches, answers: [], today: TODAY });
      const window = judgementWindow(coverage, { today: TODAY });
      const rows = runRateRowsWithQuietMonths(aggregateTransactionsByMonth(sorted, { today: TODAY }), coverage);
      // The balance was true on 30 June; today is 15 July.
      const m = computeMetrics(aggregateTransactionsByMonth(sorted, { today: TODAY }), NO_MANUAL, "safe", { currency: "ZAR", today: TODAY, runRateRows: rows,
        cash: { amount: 400000, on: "2026-06-30", recorded: 0, lastDataOn: "2026-06-28" } });
      const r = checkAffordability({ currentCash: m.cashToday.amount, cashKnown: true, cashUsable: m.cashToday.usable, window, coverage,
        obligations: [], monthlyCost: 10000, fromDate: TODAY, currency: "ZAR" });
      expect(r.held).toBe(false);
      expect(r.windowMonths).toEqual(rows.filter(x => !x.partial).slice(-3).map(x => x.period_month.slice(0, 7)));
      expect(r.burn).toBe(currentRunRate(rows).burn);
      expect(r.burn).toBe(Math.round((m.runExp + m.runFinOut - m.runRev) * 100) / 100);
      expect(r.cashToday).toBe(Math.round(m.cashToday.amount * 100) / 100);
    });
  });
});

describe("affordability: linked accounts that overlap", () => {
  it("is held, with the reason, while window months may be counted twice", () => {
    const biz = { batches: [cheque(1), named(2, "Business cheque")], transactions: [...steady().transactions, ...WINDOW.flatMap(ym => month(ID(2), ym, 100000, 100000))] };
    const r = check(biz, { cash: 900000, answers: [{ account_key: "business cheque", kind: "same_as", slot: "status", same_as_key: "cheque" }] });
    expect(r).toMatchObject({ status: "held", reason: "window", missingMonths: WINDOW });
    expect(r.message).toMatch(/may be counted twice/);
    expect(r.message).toContain("Cheque");
    expect(r.message).toContain("Business cheque");
  });
});
