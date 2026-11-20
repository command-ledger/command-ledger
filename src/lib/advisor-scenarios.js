// The eleven evaluation scenarios of the Project 3 brief (section 7), as invented
// businesses. Every name and figure here is made up; none comes from a real
// customer. Each scenario runs through the same pipeline the Dashboard runs
// (coverage, D1's window, monthly rows, computeMetrics, the 12-month client
// share, bills, affordability), and buildAdvisorEvidence() turns the result into
// what the advisor is sent. `expect` holds what was worked out by hand.
//
// Used by advisor.test.js (the engine and the checks, no model) and by
// advisor.eval.test.js (the real model, run only on request).
import {
  accountCoverage, judgementWindow, aggregateTransactionsByMonth, runRateRowsWithQuietMonths, computeMetrics, computeRevenueConcentration,
  periodStartDate, cashMovementSince, buildRuleIndex, classificationKey, checkAffordability, detectMissedObligations, buildAdvisorEvidence,
} from "./financials.js";

export const TODAY = "2026-07-15";
const NO = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
const BATCH = "00000000-0000-4000-8000-000000000001";
const CHEQUE = { id: BATCH, currency: "ZAR", filename: "cheque.csv", account_label: "Cheque", reconciliation_status: "verified", import_status: "accepted" };
let seq = 0;
const tx = (txn_date, amount, description, extra = {}) => ({
  id: ++seq, source_batch_id: BATCH, txn_date, amount, category: null, currency: "ZAR", description, dedupe_hash: `s${seq}`, ...extra,
});
const MONTHS_12 = ["2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
const CLIENTS = ["Acme Trading", "Baobab Studio", "Karoo Foods", "Umhlanga Dental", "Tafelberg Logistics"];

// One month: each payer pays on the 5th, each cost leaves on the 28th.
function month(ym, { revenue = [], costs = [] }) {
  return [
    ...revenue.map(([payer, amount], i) => tx(`${ym}-${String(5 + i).padStart(2, "0")}`, amount, `Payment from ${payer}`)),
    ...costs.map(([description, amount, category = null]) => tx(`${ym}-28`, -amount, description, { category })),
  ];
}
// Revenue shared evenly between the five clients.
const even = total => CLIENTS.map(c => [c, total / CLIENTS.length]);
const basicCosts = total => [["Office rent Sandton", total * 0.25, "rent"], ["Salaries", total * 0.6, "payroll"], ["Supplier invoice Makro", total * 0.15, "cogs"]];

// The Dashboard's wiring, from transactions to the advisor's evidence.
export function scenarioEvidence({ txns, cash = null, view = 12, mode = "safe", vat = { applies: true, registered: false, from: null }, rules = [],
  yearEndMonth = 2, obligations = [], question = null, monthlyCost = null, today = TODAY, batches = [CHEQUE] }) {
  const ruleIndex = buildRuleIndex(rules);
  const sorted = [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id - b.id);
  const coverage = accountCoverage({ transactions: sorted, batches, answers: [], rules: ruleIndex, today, vat });
  const window = judgementWindow(coverage, { today });
  const allRows = aggregateTransactionsByMonth(sorted, { rules: ruleIndex, today, vat });
  const from = view ? periodStartDate(view, today) : null;
  const shown = from ? sorted.filter(t => t.txn_date >= from) : sorted;
  const history = aggregateTransactionsByMonth(shown, { rules: ruleIndex, today, vat });
  const before = `${today.slice(0, 7)}-01`, since = periodStartDate(12, today);
  const concentration = computeRevenueConcentration(sorted.filter(t => t.txn_date >= since && t.txn_date < before), ruleIndex);
  const moved = cash ? cashMovementSince(sorted, cash.on, ruleIndex) : null;
  const m = computeMetrics(history.length ? history : null, NO, mode, {
    currency: "ZAR", today, lastTxnDate: sorted[sorted.length - 1]?.txn_date || null, revenueConcentration: concentration,
    cash: cash ? { amount: cash.amount, on: cash.on, recorded: moved.recorded, lastDataOn: moved.lastDate } : null,
    runRateRows: runRateRowsWithQuietMonths(allRows, coverage), window, coverageMonths: coverage.months, vat, taxYear: { yearEndMonth },
  });
  const cashToday = m.cashToday;
  const affordability = monthlyCost ? {
    monthlyCost,
    result: checkAffordability({ currentCash: cashToday ? (cashToday.usable ? cashToday.amount : null) : null, cashKnown: !!cashToday,
      cashUsable: !cashToday || cashToday.usable, window, coverage, obligations, monthlyCost, fromDate: today, currency: "ZAR" }),
  } : null;
  const evidence = buildAdvisorEvidence({
    m, currency: "ZAR", today, mode, periodLabel: view ? `Last ${view} months` : "All time", window,
    verification: { status: "verified", notReconciledFiles: 0, totalFiles: 1 },
    cashBalance: cash ? { amount: cash.amount, on: cash.on, source: "manual" } : null, concentration, obligations,
    uncheckedBills: detectMissedObligations(obligations, today), affordability, question, directives: [], vat, history,
  });
  return { m, evidence, affordability: affordability?.result || null };
}

const fresh = amount => ({ amount, on: TODAY });

export const SCENARIOS = [
  {
    id: "healthy",
    title: "Healthy business",
    // R120,000 a month from five clients, R90,000 of costs, June up 5% to
    // R126,000. Last 3 months: revenue (120,000 + 120,000 + 126,000) / 3 =
    // 122,000 a month, result 32,000, so no burn and no runway to count. June
    // against May: +5.0%, so growth has not stalled. Largest client 20%.
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym === "2026-06" ? 126000 : 120000), costs: basicCosts(90000) })),
      cash: fresh(500000),
    }),
    expect: {
      status: "no_material_issue", firstRule: "stable_foundation",
      values: { window_revenue: 122000, window_result: 32000, latest_revenue: 126000, revenue_change: 5, client_share: 20, cash_balance: 500000 },
      displays: { runway: "No burn", latest_revenue: "R 126 000" },
      mustCite: ["window_result"],
    },
  },
  {
    id: "revenue_decline",
    title: "Revenue decline after a volatile year",
    // July to February swing between R100,000 and R140,000; March R120,000,
    // April R125,000, May R115,000, June R84,000. The 3 months before June
    // average (120,000 + 125,000 + 115,000) / 3 = 120,000; June is 36,000 or
    // 30% below it (D6). Costs R90,000: last 3 months revenue
    // (125,000 + 115,000 + 84,000) / 3 = 108,000, result 18,000 a month.
    build: () => {
      const rev = { "2026-03": 120000, "2026-04": 125000, "2026-05": 115000, "2026-06": 84000 };
      return scenarioEvidence({
        txns: MONTHS_12.flatMap((ym, i) => month(ym, { revenue: even(rev[ym] ?? (i % 2 ? 140000 : 100000)), costs: basicCosts(90000) })),
        cash: fresh(500000),
      });
    },
    expect: {
      status: "action_needed", firstRule: "revenue_fall",
      values: { revenue_fall_latest: 84000, revenue_fall_average: 120000, revenue_fall_pct: 30, window_revenue: 108000, window_result: 18000 },
      displays: { revenue_fall_pct: "30%", revenue_fall_latest: "R 84 000" },
      mustCite: ["revenue_fall_pct"],
      noCauseAsFact: true,
    },
  },
  {
    id: "concentration",
    title: "One client carries most of the revenue",
    // R120,000 a month: Acme Trading R84,000 (70%), four others R9,000 each;
    // in June Acme pays R90,300 (+5.25% in total, so growth has not stalled).
    // Over 12 months Acme is (11 x 84,000 + 90,300) / (11 x 120,000 + 126,300)
    // = 1,014,300 / 1,446,300 = 70.1%. Costs R90,000. Without Acme: revenue 36,000 against costs 90,000, a
    // shortfall of 54,000 a month; cash 500,000 lasts 500,000 / 54,000 = 9.3
    // months, so the share is a warning, not critical (D7).
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, {
        revenue: [["Acme Trading", ym === "2026-06" ? 90300 : 84000], ...CLIENTS.slice(1).map(c => [c, 9000])], costs: basicCosts(90000) })),
      cash: fresh(500000),
    }),
    expect: {
      status: "action_needed", rule: "client_concentration",
      values: { client_share: 70.1, paying_clients: 5, client_runway: 9.3 },
      mustCite: ["client_share"],
    },
  },
  {
    id: "cost_increase",
    title: "Payroll rose sharply in the latest month",
    // Revenue R130,000 (June R136,500, +5%). Payroll R40,000 a month, June
    // R60,000: the 3 months before average 40,000, so June is 20,000 or 50%
    // above. Rent R20,000 and cost of sales R10,000 unchanged.
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, {
        revenue: even(ym === "2026-06" ? 136500 : 130000),
        costs: [["Salaries", ym === "2026-06" ? 60000 : 40000, "payroll"], ["Office rent Sandton", 20000, "rent"], ["Supplier invoice Makro", 10000, "cogs"]],
      })),
      cash: fresh(500000),
    }),
    expect: {
      values: { cost_rise_payroll: 60000, cost_rise_payroll_before: 40000, cost_rise_payroll_change: 20000 },
      displays: { cost_rise_payroll_change: "R 20 000" },
      mustCite: ["cost_rise_payroll_change"],
    },
  },
  {
    id: "profit_cash_constrained",
    title: "Profitable, but loan repayments drain the bank",
    // Revenue R100,000, costs R80,000: profit R20,000 a month. Loan repayments
    // R35,000 a month leave the bank too: net burn 80,000 + 35,000 - 100,000 =
    // 15,000. Cash R30,000: runway 30,000 / 15,000 = 2.0 months, under 3:
    // critical (D5), with no loss. Cash break-even 115,000, money in 100,000:
    // 15,000 below. Hiring capacity (20,000 - 35,000) x 0.8 < 0: none.
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => [...month(ym, { revenue: even(100000), costs: basicCosts(80000) }), tx(`${ym}-20`, -35000, "Loan repayment Nedbank")]),
      cash: fresh(30000),
    }),
    expect: {
      status: "action_needed", firstRule: "low_runway",
      values: { window_result: 20000, net_burn: 15000, runway: 2, break_even_cash: 115000, cash_gap: 15000, hiring_capacity: 0 },
      displays: { hiring_capacity: "None", runway: "2.0 months" },
      mustCite: ["runway"],
    },
  },
  {
    id: "hiring_request",
    title: "Asks to hire a developer at R45,000 a month",
    // Revenue R120,000 (June R126,000), costs R100,000 (June R106,000). Cash R150,000. The
    // floor is one month of outgoings plus the cost: April to June costs
    // average (100,000 + 100,000 + 106,000) / 3 = 102,000, so 102,000 + 45,000
    // = 147,000. The first payment today leaves 105,000, already under the
    // floor. Money in less costs over April to June is (122,000 - 102,000) =
    // 20,000 a month, so cash falls about 25,000 a month: after the 5th payment
    // (15 November, day 123) 150,000 + 20,000/30 x 123 - 5 x 45,000 = 7,000;
    // after the 6th (15 December, day 153) 102,000 + 150,000 - 270,000 =
    // -18,000. Cash runs out in month 6. Not affordable.
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym === "2026-06" ? 126000 : 120000), costs: basicCosts(ym === "2026-06" ? 106000 : 100000) })),
      cash: fresh(150000), monthlyCost: 45000, question: "Can I hire a developer at R45,000 a month?",
    }),
    expect: {
      affordability: "not_affordable", affordabilityReason: "runs_out",
      mustCite: ["hiring_capacity"],
      mustNotRecommendSpend: true,
    },
  },
  {
    id: "missing_month",
    title: "May's statement is missing",
    // Revenue R100,000, costs R110,000, no transactions at all in May 2026.
    // The window April to June has May as a gap: burn is measured from April
    // and June only (D10b), loss 10,000 a month, runway 200,000 / 10,000 = 20
    // months at low confidence, naming May.
    build: () => scenarioEvidence({
      txns: MONTHS_12.filter(ym => ym !== "2026-05").flatMap(ym => month(ym, { revenue: even(100000), costs: basicCosts(110000) })),
      cash: fresh(200000),
    }),
    expect: {
      values: { runway: 20, window_result: -10000 },
      confidence: { runway: "low" },
      windowStatus: { "May 2026": "missing" },
      mustMention: [/May/],
    },
  },
  {
    id: "unidentified_material",
    title: "Unidentified money in could turn the loss into a profit",
    // Revenue R50,000, costs R60,000: a loss of 10,000 a month. Unidentified
    // deposits of R15,000 a month: more than 10% of money in, and more than
    // the loss. Every profit, runway and risk figure is held; the advisor does
    // not run and the engine explains the range over April to June: a loss of
    // 3 x 10,000 = 30,000, or a profit of 45,000 - 30,000 = 15,000, depending
    // on 3 x 15,000 = 45,000 unidentified.
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => [...month(ym, { revenue: even(50000), costs: basicCosts(60000) }), tx(`${ym}-12`, 15000, "Deposit 4471", { reviewed: true })]),
      cash: fresh(200000),
    }),
    expect: { status: "held", firstRule: "unconfirmed_money_in", engineOnly: true },
  },
  {
    id: "unidentified_small",
    title: "A small unidentified deposit that cannot change the conclusion",
    // As the healthy business, with one unidentified deposit of R3,000 in
    // June: 2.4% of June's money in, and the business is profitable, so it
    // cannot turn a profit into a loss (D9). Nothing is held.
    build: () => scenarioEvidence({
      txns: [...MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym === "2026-06" ? 126000 : 120000), costs: basicCosts(90000) })),
        tx("2026-06-12", 3000, "Deposit 9902", { reviewed: true })],
      cash: fresh(500000),
    }),
    expect: { values: { unconfirmed_in: 3000 }, mustCite: ["unconfirmed_in"], notHeld: true },
  },
  {
    id: "vat_registered",
    title: "VAT registered, sales and costs not classified",
    // Registered from 1 March 2025; no VAT classes set. Profit is shown at its
    // lowest (nothing divided) and is an estimate, "at least". Tax year from
    // March (year-end February).
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym === "2026-06" ? 126000 : 120000), costs: basicCosts(90000) })),
      cash: fresh(500000), vat: { applies: true, registered: true, from: "2025-03-01" },
    }),
    expect: { vat: "registered", noTaxLiabilityWords: true },
  },
  {
    id: "vat_unanswered",
    title: "VAT question not answered",
    // A rand business that has not said whether it is VAT registered: profit
    // figures wait (vatHold); cash figures do not. The advisor does not run.
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym === "2026-06" ? 126000 : 120000), costs: basicCosts(90000) })),
      cash: fresh(500000), vat: { applies: true, registered: null, from: null },
    }),
    expect: { status: "held", firstRule: "vat_answers_needed", engineOnly: true },
  },
  {
    id: "conflicting",
    title: "Profitable over the year, burning now, no cash balance",
    // July to March: revenue R130,000, costs R100,000. April to June: revenue
    // R60,000, costs R100,000, a loss of 40,000 a month. The 12-month period
    // shows a profit; the last 3 months a loss. No cash balance: runway and
    // the risk score are not known (less data never reads as safer).
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym >= "2026-04" ? 60000 : 130000), costs: basicCosts(100000) })),
    }),
    expect: {
      status: "action_needed", firstRule: "negative_free_cash",
      values: { window_result: -40000, period_profit: 150000 },
      held: ["runway", "risk_score"],
      mustCite: ["window_result"],
    },
  },
  {
    id: "no_action",
    title: "Nothing needs doing; the founder asks anyway",
    build: () => scenarioEvidence({
      txns: MONTHS_12.flatMap(ym => month(ym, { revenue: even(ym === "2026-06" ? 105000 : 100000), costs: basicCosts(70000) })),
      cash: fresh(600000), question: "Is there anything I need to do this month?",
    }),
    expect: { status: "no_material_issue", firstRule: "stable_foundation", answerRequired: true },
  },
];
