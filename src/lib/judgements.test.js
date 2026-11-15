// One definition of "now" and honest gaps (correction plan, revision 4:
// Phases 2 and 3; defects 5, 6, 3, 11, 2, 1, 14, 7, 9, 13 and 16; decisions
// D1, D4, D5, D6, D7, D8, D9 and D10b). Every judgement reads the 3 calendar
// months ending with the latest month that has ended, the same months as
// runway's burn. Every expected figure is worked by hand from the plan.
import { describe, it, expect } from "vitest";
import {
  computeMetrics, aggregateTransactionsByMonth, accountCoverage, judgementWindow, runRateRowsWithQuietMonths,
  cashMovementSince, runScenario, periodStartDate, fmt,
} from "./financials.js";

const TODAY = "2026-07-15";
const NO = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHEQUE = { id: ID(1), currency: "ZAR", filename: "cheque.csv", account_label: "Cheque", reconciliation_status: null };
const tx = (txn_date, amount, description, extra = {}) => ({
  source_batch_id: ID(1), txn_date, amount, category: null, currency: "ZAR",
  description: description || (amount > 0 ? "Invoice Acme Trading" : "Office rent"), ...extra,
});
// One month: revenue on the 5th, costs on the 28th.
const month = (ym, revenue, costs) => [tx(`${ym}-05`, revenue), tx(`${ym}-28`, -costs)];
const span = (list, revenue, costs) => list.flatMap(ym => month(ym, revenue, costs));
const Y25 = ["2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
const LAST3 = ["2026-04", "2026-05", "2026-06"];
const R = n => fmt(n, "ZAR");

// Wired as the Dashboard wires it: the period is a filter; burn, the window and
// every judgement read the whole history.
function dash(all, { today = TODAY, batches = [CHEQUE], answers = [], cash = null, view = null, mode = "safe", concentration = null } = {}) {
  const sorted = [...all].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const coverage = accountCoverage({ transactions: sorted, batches, answers, today });
  const window = judgementWindow(coverage, { today });
  const allRows = aggregateTransactionsByMonth(sorted, { today });
  const from = view ? periodStartDate(view, today) : null;
  const rows = aggregateTransactionsByMonth(from ? sorted.filter(t => t.txn_date >= from) : sorted, { today });
  const moved = cash ? cashMovementSince(sorted, cash.on) : null;
  return computeMetrics(rows, NO, mode, {
    currency: "ZAR", today, lastTxnDate: sorted[sorted.length - 1]?.txn_date || null, revenueConcentration: concentration,
    runRateRows: runRateRowsWithQuietMonths(allRows, coverage), window, coverageMonths: coverage.months,
    cash: cash ? { ...cash, recorded: moved.recorded, lastDataOn: moved.lastDate } : null,
  });
}
const VIEWS = [3, 6, 12, null];
const fresh = amount => ({ amount, on: TODAY });

// ─── Defect 5: hiring capacity ──────────────────────────────────
describe("hiring capacity comes from the last 3 complete months", () => {
  it("a business that was profitable last year and burns now: R0 on every view, runway 7.5 months", () => {
    // July 2025 to March 2026: +30,000 a month. April to June 2026: -40,000 a month. Cash 300,000.
    const all = [...span(Y25, 130000, 100000), ...span(LAST3, 60000, 100000)];
    VIEWS.forEach(view => {
      const m = dash(all, { view, cash: fresh(300000) });
      expect(m.hiringCapacity).toBe(0);
      expect(m.burnMonths).toBe(7.5); // 300,000 / 40,000
    });
  });

  it("twelve steady months of R30,000 profit: R24,000 on every view; Growth mode R27,000", () => {
    const all = span([...Y25, ...LAST3], 130000, 100000);
    VIEWS.forEach(view => expect(dash(all, { view }).hiringCapacity).toBe(24000)); // 30,000 x 0.8
    expect(dash(all, { mode: "growth" }).hiringCapacity).toBe(27000);              // 30,000 x 0.9
  });

  it("loan repayments come out first: (30,000 - 10,000) x 0.8 = R16,000", () => {
    const all = [...Y25, ...LAST3].flatMap(ym => [...month(ym, 130000, 100000), tx(`${ym}-20`, -10000, "Loan repayment")]);
    expect(dash(all).hiringCapacity).toBe(16000);
  });

  it("is not shown when money in is unconfirmed or there are under 28 days of data", () => {
    const open = LAST3.flatMap(ym => [...month(ym, 50000, 40000), tx(`${ym}-10`, 30000, "Deposit 4471", { reviewed: true })]);
    expect(dash(open).hiringCapacityConfidence.shown).toBe(false);
    const short = [tx("2026-07-01", 5000), tx("2026-07-10", -2000)];
    expect(dash(short).hiringCapacityConfidence.shown).toBe(false);
  });
});

// ─── Defect 6: two break-evens ──────────────────────────────────
describe("operating and cash break-even", () => {
  it("costs 70,000, loan repayments 20,000, revenue 75,000: 5,000 above operating, 15,000 below cash", () => {
    const all = LAST3.flatMap(ym => [...month(ym, 75000, 70000), tx(`${ym}-20`, -20000, "Loan repayment")]);
    const m = dash(all);
    expect(m.breakEven).toBe(70000);
    expect(m.cashBreakEven).toBe(90000);
    expect(m.runRev - m.breakEven).toBe(5000);
    expect(m.cashIn - m.cashBreakEven).toBe(-15000);
    expect(m.cashIn - m.cashBreakEven).toBe(-m.netBurn);
  });

  it("costs 50,000 for 9 months then 110,000 for 3: R110,000 on every view", () => {
    const all = [...span(Y25, 120000, 50000), ...span(LAST3, 120000, 110000)];
    VIEWS.forEach(view => expect(dash(all, { view }).breakEven).toBe(110000));
  });

  it("with no loan repayments or drawings the two figures are equal", () => {
    const m = dash(span(LAST3, 100000, 80000));
    expect(m.cashBreakEven).toBe(m.breakEven);
    expect(m.cashIn - m.cashBreakEven).toBe(20000);
    expect(m.netBurn).toBe(-20000);
  });
});

// ─── Defect 3: the risk score ───────────────────────────────────
describe("the risk score does not read missing data as safety", () => {
  const burning = [...span(Y25, 130000, 100000), ...span(LAST3, 60000, 100000)];
  const client = pct => ({ shown: true, largestPct: pct, severity: pct > 60 ? "critical" : pct > 40 ? "warn" : null, distinctPayers: 6, aggregatorRevenue: 0 });

  it("a known balance of R0 while burning is Critical on every view", () => {
    VIEWS.forEach(view => expect(dash(burning, { view, cash: fresh(0) }).risk.label).toBe("Critical"));
  });

  it("the same business with no balance entered has no score", () => {
    VIEWS.forEach(view => {
      const m = dash(burning, { view });
      expect(m.risk.score).toBeNull();
      expect(m.risk.label).toBeNull();
      expect(m.risk.unknown).toMatch(/cash balance/i);
    });
  });

  it("a profitable business with no balance entered still scores, because it is not burning", () => {
    const m = dash(span([...Y25, ...LAST3], 130000, 100000));
    expect(Number.isFinite(m.risk.score)).toBe(true);
    expect(m.risk.label).not.toBeNull();
  });

  it("runway under 3 months is Critical", () => {
    expect(dash(burning, { cash: fresh(100000) }).risk.label).toBe("Critical"); // 2.5 months
  });

  // Revenue 100,000, costs 75,000 a month; one client 65%. Without the client:
  // 35,000 in, 75,000 out, 40,000 short a month.
  const healthy = span([...Y25, ...LAST3], 100000, 75000);
  it("one client at 65%: Elevated with R400,000 (10.0 months without it)", () => {
    VIEWS.forEach(view => {
      const m = dash(healthy, { view, cash: fresh(400000), concentration: client(65) });
      expect(m.risk.label).toBe("Elevated");
      expect(m.clientRunway).toBe(10);
    });
  });
  it("one client at 65%: Critical with R100,000 (2.5 months without it)", () => {
    const m = dash(healthy, { cash: fresh(100000), concentration: client(65) });
    expect(m.risk.label).toBe("Critical");
    expect(m.clientRunway).toBe(2.5);
  });
  it("one client at 65% and no cash balance: Elevated", () => {
    expect(dash(healthy, { concentration: client(65) }).risk.label).toBe("Elevated");
  });
  it("one client at 90%, otherwise healthy: at least Elevated, never Low", () => {
    expect(["Elevated", "Critical"]).toContain(dash(healthy, { cash: fresh(2000000), concentration: client(90) }).risk.label);
  });

  it("a case that touches no floor keeps its weighted score", () => {
    // Revenue growing 6% a month, costs 75,000: margin above 15%, not burning, no
    // warning finding, no concentration. Every part scores 0: Low.
    const growing = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].flatMap((ym, i) => month(ym, Math.round(100000 * Math.pow(1.06, i)), 75000));
    const m = dash(growing, { cash: fresh(400000) });
    expect(m.findings[0].severity).not.toBe("warn");
    expect(m.risk.score).toBe(0);
    expect(m.risk.label).toBe("Low");
  });

  it("the margin behind the score is the 3-month margin, whatever the view", () => {
    // 12-month margin is positive; the last 3 months lose 40%.
    const scores = VIEWS.map(view => dash(burning, { view, cash: fresh(600000) }).risk.score);
    expect(new Set(scores).size).toBe(1);
  });
});

// ─── Defect 11: the scenario's "before" ─────────────────────────
describe("the scenario starts from the dashboard's own figures", () => {
  // April and May: 90,000 in, 100,000 out. June: 60,000 in, 100,000 out. Cash 200,000.
  const all = [...span(["2026-04", "2026-05"], 90000, 100000), ...month("2026-06", 60000, 100000)];
  const scenario = (m, adjustments = {}) => runScenario(
    { revenue: m.runRev, expenses: m.runExp, financingOut: m.runFinOut, cash: m.activeCash, cac: 0, ltv: 0, leads: 0, closures: 0 },
    adjustments, "safe", { cashKnown: m.hasCashData, base: m });

  it("before: burn 20,000, runway 10.0 months, margin -25.0%, as the dashboard, on every view", () => {
    VIEWS.forEach(view => {
      const m = dash(all, { view, cash: fresh(200000) });
      const s = scenario(m);
      expect(s.before.netBurn).toBe(20000);           // (10,000 + 10,000 + 40,000) / 3
      expect(s.before.burnMonths).toBe(10);
      expect(s.before.burnMonths).toBe(m.burnMonths);
      expect(s.before.margin).toBeCloseTo(-25, 6);    // (240,000 - 300,000) / 240,000
      expect(s.before.margin).toBeCloseTo(m.runMargin, 6);
      expect(s.before.risk.label).toBe(m.risk.label);
      expect(s.before.risk.score).toBe(m.risk.score);
    });
  });

  it("revenue +10%: 88,000 in, burn 12,000, 16.7 months", () => {
    const s = scenario(dash(all, { cash: fresh(200000) }), { revenuePct: 10 });
    expect(s.after.netBurn).toBe(12000);
    expect(s.after.burnMonths).toBeCloseTo(16.67, 2);
  });

  it("a profitable baseline shows no burn; no cash entered shows no runway", () => {
    const profit = dash(span(LAST3, 100000, 80000), { cash: fresh(50000) });
    expect(scenario(profit).before.cashFlowPositive).toBe(true);
    const noCash = dash(all);
    expect(scenario(noCash).before.runwayConfidence.shown).toBe(false);
  });
});

// ─── Defects 2, 1 and 14: one ordered list of findings ──────────
describe("the directive and the headline read the same finding", () => {
  const first = m => m.findings[0];

  it("revenue 100,000 for 5 months then 60,000: a warning that June fell 40%", () => {
    const all = [...span(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"], 100000, 50000), ...month("2026-06", 60000, 50000)];
    const m = dash(all, { cash: fresh(1000000) });
    expect(first(m)).toMatchObject({ rule: "revenue_fall", severity: "warn" });
    expect(first(m).reason).toContain("40%");
    expect(first(m).reason).toContain(R(100000));
    expect(m.directive.rule).toBe("revenue_fall");
    expect(m.directive.text).not.toMatch(/Increase lead volume/);
  });

  it("a 19% fall does not warn; a 20% fall does", () => {
    const fall = latest => dash([...span(["2026-03", "2026-04", "2026-05"], 100000, 50000), ...month("2026-06", latest, 50000)], { cash: fresh(1000000) });
    expect(fall(81000).findings.some(f => f.rule === "revenue_fall")).toBe(false);
    expect(fall(80000).findings.some(f => f.rule === "revenue_fall")).toBe(true);
  });

  it("a loss of 0.08% of revenue with years of cash: near break-even, not critical", () => {
    // Three months: 1,200,000 in, 1,201,000 out. Cash 500,000.
    const all = [...month("2026-04", 400000, 400000), ...month("2026-05", 400000, 400000), ...month("2026-06", 400000, 401000)];
    const m = dash(all, { cash: fresh(500000) });
    expect(first(m)).toMatchObject({ rule: "near_break_even", severity: "warn" });
    expect(m.findings.some(f => f.severity === "critical")).toBe(false);
    expect(first(m).text).not.toMatch(/Cut all non-essential spend/);
  });

  it("a 1.9% loss reads near break-even; a 2% loss warns as a loss", () => {
    const loss = costs => dash(span(LAST3, 100000, costs), { cash: fresh(5000000) });
    expect(first(loss(101900)).rule).toBe("near_break_even");
    expect(first(loss(102000))).toMatchObject({ rule: "negative_free_cash", severity: "warn" });
  });

  it("a loss with 2.9 months of runway is critical", () => {
    // Loss 10,000 a month; cash 29,000: 2.9 months.
    const m = dash(span(LAST3, 100000, 110000), { cash: fresh(29000) });
    expect(first(m).severity).toBe("critical");
    expect(m.burnMonths).toBe(2.9);
  });

  it("a loss with long runway is a warning, not critical", () => {
    const m = dash(span(LAST3, 100000, 110000), { cash: fresh(900000) });
    expect(first(m)).toMatchObject({ rule: "negative_free_cash", severity: "warn" });
  });

  it("one month of data: growth is not measured, so no growth claim is made", () => {
    const m = dash(month("2026-06", 200000, 60000));
    expect(m.findings.some(f => f.rule === "stalled_growth")).toBe(false);
    expect(m.velKnown).toBe(false);
  });

  it("two months growing 3% still read stalled", () => {
    const m = dash([...month("2026-05", 100000, 60000), ...month("2026-06", 103000, 60000)], { cash: fresh(900000) });
    expect(first(m).rule).toBe("stalled_growth");
  });

  it("profitable over 12 months, losing 40,000 a month now, no cash entered: a warning to enter the balance", () => {
    const m = dash([...span(Y25, 130000, 100000), ...span(LAST3, 60000, 100000)]);
    expect(first(m).severity).toBe("warn");
    expect(first(m).reason).toContain(R(40000));
    expect(first(m).reason).toMatch(/cash balance/i);
  });

  it("one client at 90%: a warning to reduce reliance; critical only if it could not last 3 months without it", () => {
    const client = { shown: true, largestPct: 90, severity: "critical", distinctPayers: 6, aggregatorRevenue: 0 };
    const all = span([...Y25, ...LAST3], 100000, 75000);
    // Without the client: 10,000 in, 75,000 out, 65,000 short. 2,000,000 lasts 30.8 months; 100,000 lasts 1.5.
    expect(first(dash(all, { cash: fresh(2000000), concentration: client }))).toMatchObject({ rule: "client_concentration", severity: "warn" });
    expect(first(dash(all, { cash: fresh(100000), concentration: client }))).toMatchObject({ rule: "client_concentration", severity: "critical" });
  });

  it("one month with a loss is not critical (defect 14)", () => {
    const m = dash(month("2026-06", 50000, 60000), { cash: fresh(5000) });
    expect(m.findings.every(f => f.severity !== "critical")).toBe(true);
    expect(m.directive.severity).not.toBe("critical");
  });

  it("the headline cases for runway under 3 and under 6 months are unchanged", () => {
    const burn10 = span(LAST3, 90000, 100000);
    expect(first(dash(burn10, { cash: fresh(25000) }))).toMatchObject({ severity: "critical" });      // 2.5 months
    expect(first(dash(burn10, { cash: fresh(45000) }))).toMatchObject({ severity: "warn" });          // 4.5 months
  });

  it("across these cases the risk label is never milder than the first finding", () => {
    const rank = { Low: 0, Watch: 1, Elevated: 2, Critical: 3 };
    [dash(span(LAST3, 100000, 110000), { cash: fresh(29000) }), dash(span(LAST3, 100000, 110000), { cash: fresh(900000) }),
      dash([...span(["2026-03", "2026-04", "2026-05"], 100000, 50000), ...month("2026-06", 60000, 50000)], { cash: fresh(1000000) })].forEach(m => {
      const need = m.findings[0].severity === "critical" ? 3 : m.findings[0].severity === "warn" ? 1 : 0;
      expect(rank[m.risk.label]).toBeGreaterThanOrEqual(need);
    });
  });
});

// ─── Defect 7 (D9): unidentified money that could reverse the result ────
describe("unidentified money that could reverse a loss holds the figures", () => {
  const unknown = (ym, amount) => tx(`${ym}-10`, amount, "Deposit 4471", { reviewed: true });
  const biz = (identified, unidentified, costs) => LAST3.flatMap(ym => [...month(ym, identified, costs), unknown(ym, unidentified)]);

  it("91,000 identified, 9,000 unidentified, 95,000 costs: held, with both ends stated", () => {
    // 273,000 - 285,000 = a loss of 12,000; with the 27,000, a profit of 15,000. Share 9%.
    const m = dash(biz(91000, 9000, 95000), { cash: fresh(500000) });
    expect(m.figuresOpen).toBe(true);
    expect(m.burnOpen).toBe(true);
    expect(m.openRange).toEqual({ low: -12000, high: 15000, unidentified: 27000 });
    expect(m.directive.rule).toBe("unconfirmed_money_in");
    expect(m.directive.reason).toContain(R(12000));
    expect(m.directive.reason).toContain(R(15000));
    expect(m.directive.reason).toContain(R(27000));
    expect(m.findings.some(f => f.severity === "critical")).toBe(false);
  });

  it("3,000 unidentified a month cannot cover the 12,000 loss: the loss stands", () => {
    const m = dash(biz(91000, 3000, 95000), { cash: fresh(500000) });
    expect(m.figuresOpen).toBe(false);
    expect(m.totPro).toBe(-12000);
  });

  it("unidentified money exactly equal to the loss: held", () => {
    expect(dash(biz(91000, 4000, 95000), { cash: fresh(500000) }).figuresOpen).toBe(true);
  });

  it("a profit is not held by unidentified money under 10%", () => {
    expect(dash(biz(100000, 5000, 95000), { cash: fresh(500000) }).figuresOpen).toBe(false);
  });
});

// ─── Defect 9 (D4): the month in progress ───────────────────────
describe("profit and margin are measured over complete months", () => {
  const base = span(LAST3, 100000, 100000);
  it("9 July and 29 July give the same profit and margin: 0 and 0.0%", () => {
    const early = dash([...base, tx("2026-07-03", 30000), tx("2026-07-07", 20000)], { today: "2026-07-09", view: 3 });
    const late = dash([...base, tx("2026-07-03", 30000), tx("2026-07-07", 20000), tx("2026-07-28", -100000)], { today: "2026-07-29", view: 3 });
    [early, late].forEach(m => { expect(m.totPro).toBe(0); expect(m.margin).toBe(0); expect(m.free).toBe(0); });
    expect(early.toDate).toMatchObject({ revenue: 50000, expenses: 0 });
    expect(early.toDate.label).toMatch(/Jul 26/);
    expect(late.toDate).toMatchObject({ revenue: 50000, expenses: 100000 });
  });

  it("a period with no partial month is unchanged, and has nothing to date", () => {
    const m = dash(span(LAST3, 100000, 80000), { today: "2026-07-01" });
    expect(m.totPro).toBe(60000);
    expect(m.toDate).toBeNull();
  });

  it("a monthly summary dated the 1st is still a complete month", () => {
    const summary = ["2026-04", "2026-05", "2026-06"].flatMap(ym => [tx(`${ym}-01`, 100000), tx(`${ym}-01`, -70000)]);
    const m = dash(summary);
    expect(m.totPro).toBe(90000);
    expect(m.toDate).toBeNull();
  });
});

// ─── Defect 13 (D10b): a missing month ──────────────────────────
describe("a missing month is named, never skipped", () => {
  // March and April: 90,000 in, 100,000 out. No May. June: 60,000 in, 100,000 out. Cash 200,000 on 15 July.
  const caseB = [...span(["2026-03", "2026-04"], 90000, 100000), ...month("2026-06", 60000, 100000)];

  it("burn is (10,000 + 40,000) / 2 = 25,000 and runway 8.0 months, at low confidence, naming May", () => {
    const m = dash(caseB, { cash: fresh(200000) });
    expect(m.netBurn).toBe(25000);
    expect(m.burnMonths).toBe(8);
    expect(m.runMonths).toBe(2);
    expect(m.runwayConfidence.level).toBe("low");
    expect(m.runwayConfidence.reason).toMatch(/May/);
    expect(m.runMissing).toEqual(["2026-05"]);
  });

  it("June against the month before is not known", () => {
    const m = dash(caseB, { cash: fresh(200000) });
    expect(m.velKnown).toBe(false);
  });

  it("only June complete among April to June: burn and runway are held", () => {
    const m = dash([tx("2026-04-20", 500), tx("2026-04-28", -100), ...month("2026-06", 60000, 100000)], { cash: fresh(200000) });
    expect(m.burnGap).toBe(true);
    expect(m.runwayConfidence.shown).toBe(false);
    expect(m.runwayConfidence.reason).toMatch(/April|May/);
    expect(m.hiringCapacityConfidence.shown).toBe(false);
  });

  it("consecutive months with transactions give the same burn as before", () => {
    const m = dash([...span(Y25, 90000, 100000), ...span(LAST3, 60000, 100000)], { cash: fresh(300000) });
    expect(m.netBurn).toBe(40000);
    expect(m.runMonths).toBe(3);
    expect(m.burnGap).toBe(false);
  });
});

// ─── Defect 16: cost categories nothing matched ─────────────────
describe("an unrecognised cost category is not known, not zero", () => {
  it("costs nobody categorised: cost of sales and marketing are not known, with the total", () => {
    const m = dash([tx("2026-06-05", 100000), tx("2026-06-10", -40000, "Purchase Makro Germiston"), tx("2026-06-28", -20000, "Payment J Smith")]);
    expect(m.uncategorised).toBe(60000);
    expect(m.cogsKnown).toBe(false);
    expect(m.mktKnown).toBe(false);
  });

  it("every cost categorised and no marketing: 0.0% is a real zero", () => {
    const m = dash([tx("2026-06-05", 100000), tx("2026-06-10", -40000, "Stock purchase", { category: "cogs" }), tx("2026-06-28", -20000, "Salaries", { category: "payroll" })]);
    expect(m.uncategorised).toBe(0);
    expect(m.mktKnown).toBe(true);
    expect(m.mktRatio).toBe(0);
    expect(m.cogsRatio).toBe(40);
  });

  it("a matched category is shown, with the uncategorised total beside it", () => {
    const m = dash([tx("2026-06-05", 100000), tx("2026-06-10", -40000, "Stock purchase", { category: "cogs" }), tx("2026-06-28", -20000, "Payment J Smith")]);
    expect(m.cogsKnown).toBe(true);
    expect(m.cogsRatio).toBe(40);
    expect(m.uncategorised).toBe(20000);
    expect(m.mktKnown).toBe(false);
  });
});

// ─── Defect 10 (D11): growth is measured between levels ─────────
describe("growth and the projection do not reward volatility", () => {
  const revenue = list => list.map((r, i) => month(`2026-${String(i + 1).padStart(2, "0")}`, r, 5000)).flat();
  const at = (list, today) => dash(revenue(list), { today });

  it("10,000, 20,000, 10,000, 20,000: growth 0%, score 50 Flat, projection 15,000", () => {
    // Changes +100%, -50%, +100%: not one direction. Last 2 months average 15,000; the 2 before, 15,000.
    const m = at([10000, 20000, 10000, 20000], "2026-05-15");
    expect(m.proj90GrowthRate).toBe(0);
    expect(m.growth.score).toBe(50);
    expect(m.growth.label).toBe("Flat");
    expect(m.proj90).toBe(15000);
  });

  it("a steady 10% a month still projects 16,105 x 1.1^3 = 21,436", () => {
    // 10,000 to 16,105 over 6 months. Last 3 average 14,685; the 3 before 11,033; ratio 1.331 = 1.1^3.
    const m = at([10000, 11000, 12100, 13310, 14641, 16105], "2026-07-15");
    expect(m.proj90GrowthRate).toBeCloseTo(10, 1);
    expect(Math.round(m.proj90)).toBe(21436);
    expect(m.growth.score).toBeCloseTo(80, 1); // 50 + 10 x 3, every change upward
  });

  it("a steady 10% decline reads -10% and Declining", () => {
    const m = at([16105, 14641, 13310, 12100, 11000, 10000], "2026-07-15");
    expect(m.proj90GrowthRate).toBeCloseTo(-9.09, 1); // each month is 1/1.1 of the one before
    expect(m.growth.label).toBe("Declining");
    expect(m.proj90).toBeLessThan(10000);
  });

  it("flat revenue is 50, Flat, and projects itself", () => {
    const m = at([10000, 10000, 10000, 10000], "2026-05-15");
    expect(m.growth.score).toBe(50);
    expect(m.proj90).toBe(10000);
  });

  it("a block with a missing month gives no reading", () => {
    // January to March, then May and June: the run of neighbouring months is May and June only.
    const rows = [...month("2026-01", 10000, 5000), ...month("2026-02", 20000, 5000), ...month("2026-03", 30000, 5000), ...month("2026-05", 10000, 5000), ...month("2026-06", 10000, 5000)];
    const m = dash(rows);
    expect(m.proj90GrowthRate).toBe(0);
    expect(m.proj90).toBe(10000);
  });
});
