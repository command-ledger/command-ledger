// Tax paid and VAT (correction plan, revision 4: defect 8; D3a, D3b). Profit and
// cash answer different questions and are never mixed. Profit leaves out VAT the
// business collects or can claim, and is measured before income tax. Cash keeps
// every rand as it moved. Every tax figure is the app's own estimate from bank
// data, never a SARS calculation. Each expected figure is worked by hand.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  aggregateTransactionsByMonth, computeMetrics, buildRuleIndex, classificationKey, kindRuleRow, reviewRuleRows,
  taxYearToDate, taxYearNote, taxQuestions, resolveKind, VAT_RATE, VAT_CLASSES, fmt, profitBasisRows, profitTotals, buildReportCsv,
} from "./financials.js";

const NO = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
const R = n => fmt(n, "ZAR");
let seq = 0;
const tx = (txn_date, amount, description) => ({ txn_date, amount, description, category: null, currency: "ZAR", dedupe_hash: `h${++seq}` });
const similar = (description, kind, vat_class = null) => ({ scope: "similar", match_key: classificationKey(description), kind, vat_class });
const single = (t, kind, vat_class = null) => ({ scope: "single", match_key: t.dedupe_hash, kind, vat_class });
const REGISTERED = { applies: true, registered: true, from: "2025-03-01" };
const NOT_REGISTERED = { applies: true, registered: false, from: null };
const metrics = (txns, { rules = [], vat = NOT_REGISTERED, today, view = null, yearEndMonth = null, mode = "safe" }) => {
  const index = buildRuleIndex(rules);
  const sorted = [...txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const all = aggregateTransactionsByMonth(sorted, { rules: index, today, vat });
  const rows = view ? all.slice(-view) : all;
  return computeMetrics(rows.filter(r => !r.partial).length ? rows : all, NO, mode, { currency: "ZAR", today, runRateRows: all, vat, taxYear: { yearEndMonth } });
};

// ─── Income tax: the plan's worked example ─────────────────────
// A February year-end, so the tax year began on 1 March 2026. March to August:
// 100,000 in and 60,000 out every month. One payment of 60,000 to SARS on 31 August.
describe("income tax paid is not a cost, and the reserve is not taken twice", () => {
  const months = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
  const base = months.flatMap(m => [tx(`${m}-05`, 100000, "Invoice Acme Trading"), tx(`${m}-25`, -60000, "Supplier Makro")]);
  const sars = tx("2026-08-31", -60000, "SARS payment");
  const TODAY = "2026-09-10";
  const run = (rules, extra = {}) => metrics([...base, sars], { rules, today: TODAY, yearEndMonth: 2, ...extra });
  // The period on screen: June to August (the last 3 complete months).
  const period = rules => run(rules, { view: 4 }); // June, July, August and September so far (none)

  it("marked income tax for the current year: profit 120,000, reserve 36,000, after reserves 60,000; year to date 72,000, paid 60,000, 12,000 still to set aside", () => {
    const m = metrics([...base, sars], { rules: [single(sars, "income_tax_current")], today: TODAY, yearEndMonth: 2, view: 3 });
    expect(m.totPro).toBe(120000);            // 300,000 - 180,000
    expect(m.taxV).toBe(36000);               // 30%
    expect(m.free).toBe(60000);               // 120,000 - 36,000 - 24,000
    expect(m.taxYear).toMatchObject({ available: true, from: "2026-03", to: "2026-08", estimate: 72000, paid: 60000, stillToSetAside: 12000, beyond: 0, priorYears: 0 });
  });

  it("marked income tax for an earlier year: nothing counted against this year, shown on its own line", () => {
    const m = metrics([...base, sars], { rules: [single(sars, "income_tax_prior")], today: TODAY, yearEndMonth: 2, view: 3 });
    expect(m.totPro).toBe(120000);
    expect(m.free).toBe(60000);
    expect(m.taxYear).toMatchObject({ estimate: 72000, paid: 0, priorYears: 60000, stillToSetAside: 72000 });
  });

  it("not marked, or marked a payroll cost: it stays a cost", () => {
    for (const rules of [[], [single(sars, "operating")]]) {
      const m = metrics([...base, sars], { rules, today: TODAY, yearEndMonth: 2, view: 3 });
      expect(m.totPro).toBe(60000);             // 300,000 - 240,000
      expect(m.taxV).toBe(18000);
      expect(m.free).toBe(30000);               // 60,000 - 18,000 - 12,000
      expect(m.taxYear).toMatchObject({ estimate: 54000, paid: 0, stillToSetAside: 54000 }); // 180,000 x 30%
    }
  });

  it("the tax-year line is the same on the 3-month, 6-month and all-time views", () => {
    const rules = [single(sars, "income_tax_current")];
    const lines = [3, 6, null].map(view => metrics([...base, sars], { rules, today: TODAY, yearEndMonth: 2, view }).taxYear);
    expect(lines[1]).toEqual(lines[0]);
    expect(lines[2]).toEqual(lines[0]);
  });

  it("cash is identical whatever the payment is called: burn and cash out never change with the label", () => {
    const labels = [[], [single(sars, "income_tax_current")], [single(sars, "income_tax_prior")], [single(sars, "vat")], [single(sars, "operating")]];
    const all = labels.map(rules => metrics([...base, sars], { rules, today: TODAY, yearEndMonth: 2 }));
    all.forEach(m => {
      expect(m.netBurn).toBe(all[0].netBurn);           // (180,000 + 60,000 - 300,000) / 3 = -20,000
      expect(m.cashBreakEven).toBe(all[0].cashBreakEven);
      expect(m.runExp).toBe(all[0].runExp);
    });
    expect(all[0].netBurn).toBe(-20000);
    expect(all[0].cashBreakEven).toBe(80000);            // 240,000 / 3
  });

  it("a seventh month at 40,000 profit: estimate 84,000, paid 60,000, 24,000 still to set aside", () => {
    const sept = [tx("2026-09-05", 100000, "Invoice Acme Trading"), tx("2026-09-25", -60000, "Supplier Makro")];
    const m = metrics([...base, sars, ...sept], { rules: [single(sars, "income_tax_current")], today: "2026-10-10", yearEndMonth: 2 });
    expect(m.taxYear).toMatchObject({ to: "2026-09", estimate: 84000, paid: 60000, stillToSetAside: 24000 });
  });

  it("80,000 paid against a 72,000 estimate: nothing further, and 8,000 more than the estimate, never a credit", () => {
    const big = tx("2026-08-31", -80000, "SARS payment");
    const m = metrics([...base, big], { rules: [single(big, "income_tax_current")], today: TODAY, yearEndMonth: 2 });
    expect(m.taxYear).toMatchObject({ estimate: 72000, paid: 80000, stillToSetAside: 0, beyond: 8000 });
    const note = taxYearNote(m.taxYear, "ZAR", 0.3);
    expect(note).toContain("nothing further to set aside by this estimate");
    expect(note).toContain(`${R(8000)} more than this estimate`);
    expect(note).toContain("not a SARS calculation");
    expect(note).not.toMatch(/credit|refund due|overpaid|owed/i);
  });

  it("60,000 paid and a 5,000 income tax refund: paid 55,000, 17,000 still to set aside, and the refund is not revenue", () => {
    const refund = tx("2026-08-20", 5000, "SARS refund");
    const m = metrics([...base, sars, refund], { rules: [single(sars, "income_tax_current"), single(refund, "income_tax_current")], today: TODAY, yearEndMonth: 2 });
    expect(m.taxYear).toMatchObject({ paid: 55000, stillToSetAside: 17000 });
    expect(m.totRev).toBe(600000); // six months of 100,000; the refund is not in it
  });

  it("no financial year-end: nothing is compared; the period's reserve and income tax paid stand side by side", () => {
    const m = metrics([...base, sars], { rules: [single(sars, "income_tax_current")], today: TODAY, yearEndMonth: null, view: 3 });
    expect(m.taxYear.available).toBe(false);
    expect(m.taxYear.stillToSetAside).toBeUndefined();
    expect(m.taxV).toBe(36000);
    expect(m.incomeTaxPaid).toBe(60000);
    expect(taxYearNote(m.taxYear, "ZAR", 0.3)).not.toMatch(/still to set aside/);
  });

  it("statements starting in May: the tax year is not covered from its start, so nothing is compared", () => {
    const fromMay = base.filter(t => t.txn_date >= "2026-05-01");
    const m = metrics([...fromMay, sars], { rules: [single(sars, "income_tax_current")], today: TODAY, yearEndMonth: 2 });
    expect(m.taxYear.available).toBe(false);
    expect(m.taxYear.reason).toMatch(/March 2026/);
  });

  it("a description containing SARS with no answer stays a cost and is asked about, with nothing chosen for it", () => {
    const index = buildRuleIndex([]);
    expect(resolveKind(sars, index)).toMatchObject({ kind: "operating", source: "auto" });
    expect(taxQuestions([...base, sars], index).map(t => t.dedupe_hash)).toEqual([sars.dedupe_hash]);
    expect(taxQuestions([...base, sars], buildRuleIndex([single(sars, "operating")]))).toEqual([]);
  });
});

// ─── Saving a rule ─────────────────────────────────────────────
describe("rule rows: complete, and income tax one payment at a time", () => {
  const t = { description: "SARS payment 0042", dedupe_hash: "abc" };
  it("every row carries vat_class, so an upsert never keeps an old class", () => {
    const row = kindRuleRow({ userId: "u", txn: t, kind: "transfer", scope: "similar" });
    expect(Object.prototype.hasOwnProperty.call(row, "vat_class")).toBe(true);
    expect(row).toMatchObject({ user_id: "u", scope: "similar", match_key: "sars payment", kind: "transfer", vat_class: null, description_key: null });
    expect(kindRuleRow({ userId: "u", txn: t, kind: "operating", scope: "similar", vatClass: "claimable" }).vat_class).toBe("claimable");
    expect(kindRuleRow({ userId: "u", txn: t, kind: "refund", scope: "single", vatClass: "standard" })).toMatchObject({ scope: "single", match_key: "abc", vat_class: "standard", description_key: "sars payment" });
  });
  it("a class on a kind that cannot carry one is dropped, not sent", () => {
    expect(kindRuleRow({ userId: "u", txn: t, kind: "financing", scope: "similar", vatClass: "standard" }).vat_class).toBeNull();
    expect(kindRuleRow({ userId: "u", txn: t, kind: "vat", scope: "similar", vatClass: "standard" }).vat_class).toBeNull();
  });
  it("income tax cannot be set for every payment like this", () => {
    expect(() => kindRuleRow({ userId: "u", txn: t, kind: "income_tax_current", scope: "similar" })).toThrow(/one payment at a time/);
    expect(() => kindRuleRow({ userId: "u", txn: t, kind: "income_tax_prior", scope: "similar" })).toThrow(/one payment at a time/);
    expect(kindRuleRow({ userId: "u", txn: t, kind: "income_tax_current", scope: "single" }).scope).toBe("single");
  });
  it("refuses an unknown kind or class", () => {
    expect(() => kindRuleRow({ userId: "u", txn: t, kind: "tax", scope: "single" })).toThrow();
    expect(() => kindRuleRow({ userId: "u", txn: t, kind: "operating", scope: "single", vatClass: "reduced" })).toThrow();
  });
  it("review rows carry vat_class too", () => {
    expect(reviewRuleRows([{ description: "Loan from owner", kind: "financing" }]).rows[0]).toHaveProperty("vat_class", null);
  });
  it("the app saves rules only through these rows, and never deletes an income tax mark with a wider choice", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(app).toMatch(/kindRuleRow\(\{ userId: user\.id, txn, kind, scope, vatClass \}\)/);
    expect(app).not.toMatch(/from\("transaction_rules"\)\.upsert\(\s*scope ===/);
    expect(app).toMatch(/\.eq\("scope", "single"\)\.eq\("description_key", key\)\.not\("kind", "in", "\(income_tax_current,income_tax_prior\)"\)/);
    expect(app).toMatch(/select\("id, scope, match_key, description_key, kind, vat_class"\)/);
  });
});

// ─── VAT ───────────────────────────────────────────────────────
describe("VAT is left out of profit and kept in cash", () => {
  it("the rate is one named value with the date it was checked", () => {
    expect(VAT_RATE).toMatchObject({ rate: 0.15 });
    expect(VAT_RATE.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VAT_CLASSES.moneyIn).toEqual(["standard", "zero_rated", "exempt"]);
    expect(VAT_CLASSES.cost).toEqual(["claimable", "not_claimable", "no_vat", "partly_claimable"]);
  });

  // May and June 2026: customers pay 115,000 a month (standard-rated), suppliers are paid
  // 57,500 a month (claimable), and 15,000 net VAT is paid to SARS on 25 June.
  const sale = m => tx(`2026-${m}-05`, 115000, "Invoice Acme Trading");
  const buy = m => tx(`2026-${m}-20`, -57500, "Supplier Makro");
  const vatPay = tx("2026-06-25", -15000, "SARS VAT 201");
  const txns = [sale("05"), buy("05"), sale("06"), buy("06"), vatPay];
  const classed = [similar("Invoice Acme Trading", "operating", "standard"), similar("Supplier Makro", "operating", "claimable"), single(vatPay, "vat")];
  const TODAY = "2026-07-10";

  it("everything classified: revenue 200,000, costs 100,000, profit 100,000, margin 50.0%", () => {
    const m = metrics(txns, { rules: classed, vat: REGISTERED, today: TODAY });
    expect(m.totRev).toBe(200000);     // 230,000 / 1.15
    expect(m.totExp).toBe(100000);     // 115,000 / 1.15; the VAT payment is not a cost
    expect(m.totPro).toBe(100000);
    expect(m.margin).toBeCloseTo(50, 6);
    expect(m.profitRange).toEqual({ low: 100000, high: 100000, atLeast: false });
    expect(m.vatPeriod).toEqual({ collected: 30000, claimable: 15000, paid: 15000 });
  });

  it("May alone: profit 50,000, cash +57,500, VAT collected 15,000, claimable 7,500, paid 0", () => {
    const rows = aggregateTransactionsByMonth(txns, { rules: buildRuleIndex(classed), today: TODAY, vat: REGISTERED });
    const may = rows[0];
    expect(may.profitRevenue - may.profitExpenses).toBe(50000);
    expect(may.revenue - may.expenses).toBe(57500);
    expect([may.vatCollected, may.vatClaimable, may.vatPaid]).toEqual([15000, 7500, 0]);
  });

  it("cash keeps every rand: money in 230,000, money out 130,000, burn as if nothing were classified", () => {
    const a = metrics(txns, { rules: classed, vat: REGISTERED, today: TODAY });
    const b = metrics(txns, { rules: [], vat: NOT_REGISTERED, today: TODAY });
    expect(a.netBurn).toBe(b.netBurn);
    expect(a.cashBreakEven).toBe(b.cashBreakEven);
    expect(a.cashIn).toBe(115000);
    expect(a.cashBreakEven).toBe(65000);        // (57,500 x 2 + 15,000) / 2
    expect(a.breakEven).toBe(50000);            // operating: 57,500 / 1.15
  });

  it("suppliers not classified: profit at least 85,000, margin 42.5%, up to 15,000 higher", () => {
    const m = metrics(txns, { rules: [classed[0], classed[2]], vat: REGISTERED, today: TODAY });
    expect(m.totPro).toBe(85000);               // 200,000 - 115,000
    expect(m.margin).toBeCloseTo(42.5, 6);
    expect(m.profitRange).toEqual({ low: 85000, high: 100000, atLeast: true });
    expect(m.vatHold).toBeNull();
  });

  it("a mixed, partly classified month: revenue 170,000 to 173,000, profit 55,500 to 61,500, margin 32.6% to 35.5%, cash +66,000", () => {
    const rows = [
      tx("2026-06-02", 115000, "Invoice Acme Trading"), tx("2026-06-03", 40000, "Invoice Export Co"), tx("2026-06-04", 10000, "Invoice Tuition Trust"), tx("2026-06-05", 23000, "Invoice New Client"),
      tx("2026-06-10", -57500, "Supplier Makro"), tx("2026-06-11", -11500, "Client lunch Rockets"), tx("2026-06-25", -30000, "Wages June"), tx("2026-06-28", -23000, "Supplier Unknown"),
    ];
    const rules = [similar("Invoice Acme Trading", "operating", "standard"), similar("Invoice Export Co", "operating", "zero_rated"), similar("Invoice Tuition Trust", "operating", "exempt"),
      similar("Supplier Makro", "operating", "claimable"), similar("Client lunch Rockets", "operating", "not_claimable"), similar("Wages June", "operating", "no_vat")];
    const m = metrics(rows, { rules, vat: REGISTERED, today: TODAY });
    expect(m.totRev).toBe(170000);                       // 100,000 + 40,000 + 10,000 + 20,000
    expect(m.revenueHigh).toBe(173000);
    expect(m.totExp).toBe(114500);                       // 50,000 + 11,500 + 30,000 + 23,000
    expect(m.expensesLow).toBe(111500);
    expect(m.profitRange).toEqual({ low: 55500, high: 61500, atLeast: true });
    expect(m.margin).toBeCloseTo(32.647, 2);             // 55,500 / 170,000
    expect(m.marginHigh).toBeCloseTo(35.549, 2);         // 61,500 / 173,000
    expect(m.cashIn - m.cashBreakEven).toBe(66000);      // 188,000 - 122,000
  });

  it("115,000 of unclassified receipts against 102,000 of wages: between a 2,000 loss and a 13,000 profit, so it is held", () => {
    const rows = [tx("2026-06-05", 115000, "Invoice New Client"), tx("2026-06-25", -102000, "Wages June")];
    const m = metrics(rows, { rules: [similar("Wages June", "operating", "no_vat")], vat: REGISTERED, today: TODAY });
    expect(m.profitRange).toEqual({ low: -2000, high: 13000, atLeast: true });
    expect(m.vatHold).toMatchObject({ reason: "unclassified" });
    expect(m.directive.rule).toBe("vat_answers_needed");
    expect(m.directive.reason).toContain(R(2000));
    expect(m.directive.reason).toContain(R(13000));
    expect(m.findings.some(f => f.severity === "critical")).toBe(false);
  });

  it("receipts before the registration date are counted whole", () => {
    const rows = [tx("2025-02-10", 115000, "Invoice Acme Trading"), tx("2025-02-20", -1000, "Bank fee"), tx("2025-03-10", 115000, "Invoice Acme Trading"), tx("2025-03-20", -1000, "Bank fee")];
    const months = aggregateTransactionsByMonth(rows, { rules: buildRuleIndex([similar("Invoice Acme Trading", "operating", "standard")]), today: "2025-05-10", vat: REGISTERED });
    expect(months.map(r => r.profitRevenue)).toEqual([115000, 100000]);
  });

  it("with no registration answer, profit figures wait, and cash figures do not", () => {
    const m = metrics(txns, { rules: [], vat: { applies: true, registered: null, from: null }, today: TODAY });
    expect(m.vatHold).toMatchObject({ reason: "unanswered" });
    expect(m.directive.rule).toBe("vat_answers_needed");
    expect(m.netBurn).toBe(-50000);   // (230,000 - 130,000) / 2, as cash moved
  });

  it("a business not registered for VAT, or not asked, gets the same figures as before", () => {
    const plain = computeMetrics(aggregateTransactionsByMonth(txns, { today: TODAY }), NO, "safe", { currency: "ZAR", today: TODAY });
    for (const vat of [NOT_REGISTERED, { applies: false, registered: null, from: null }]) {
      const m = metrics(txns, { rules: [], vat, today: TODAY });
      expect([m.totRev, m.totExp, m.totPro, m.margin, m.free, m.netBurn]).toEqual([plain.totRev, plain.totExp, plain.totPro, plain.margin, plain.free, plain.netBurn]);
      expect(m.vatHold).toBeNull();
    }
    expect(plain.totRev).toBe(230000);
    expect(plain.totExp).toBe(130000);
  });

  it("a class that does not fit the direction of the money is not used", () => {
    // A cost class on money in, and a money-in class on a cost: both read as unclassified.
    const rows = [tx("2026-06-05", 115000, "Acme"), tx("2026-06-20", -57500, "Makro")];
    const rules = [similar("Acme", "operating", "claimable"), similar("Makro", "operating", "standard")];
    const [june] = aggregateTransactionsByMonth(rows, { rules: buildRuleIndex(rules), today: TODAY, vat: REGISTERED });
    expect([june.profitRevenue, june.profitRevenueHigh]).toEqual([100000, 115000]);
    expect([june.profitExpensesLow, june.profitExpenses]).toEqual([50000, 57500]);
    expect(june.vatUnclassified).toBe(172500);
  });

  it("a refund of a standard-rated sale carries its VAT too", () => {
    // 115,000 sold, 23,000 refunded: revenue (115,000 - 23,000) / 1.15 = 80,000.
    const rows = [tx("2026-06-05", 115000, "Invoice Acme Trading"), tx("2026-06-15", -23000, "Refund Acme Trading"), tx("2026-06-20", -1150, "Supplier Makro")];
    const rules = [similar("Invoice Acme Trading", "operating", "standard"), similar("Refund Acme Trading", "refund", "standard"), similar("Supplier Makro", "operating", "claimable")];
    const [june] = aggregateTransactionsByMonth(rows, { rules: buildRuleIndex(rules), today: TODAY, vat: REGISTERED });
    expect(june.profitRevenue).toBe(80000);
    expect(june.profitRevenueHigh).toBe(80000);
    expect(june.revenue).toBe(92000); // cash: 115,000 - 23,000
  });
});

// ─── The monthly tables say the same profit as the tiles ────────────
// Found in the release check: with a SARS payment marked as income tax, the
// margin tile read 20.0% and R60,000 while the monthly table on the same page
// read 18.0% and R54,000, because the table still added cash costs.
describe("monthly profit tables use the profit basis, like every profit tile", () => {
  const ROWS = [
    { period_month: "2026-08-01", month: "Aug 26", revenue: 100000, expenses: 80000, profitRevenue: 100000, profitExpenses: 80000 },
    { period_month: "2026-09-01", month: "Sep 26", revenue: 100000, expenses: 80000, profitRevenue: 100000, profitExpenses: 80000 },
    { period_month: "2026-10-01", month: "Oct 26", revenue: 100000, expenses: 86000, profitRevenue: 100000, profitExpenses: 80000 }, // 6,000 income tax
    { period_month: "2026-11-01", month: "Nov 26", partial: true, revenue: 30000, expenses: 1000, profitRevenue: 30000, profitExpenses: 1000 },
  ];

  it("profitBasisRows puts profit revenue and costs where the tables read them, keeping cash beside them", () => {
    const rows = profitBasisRows(ROWS);
    expect(rows.map(r => [r.revenue, r.expenses])).toEqual([[100000, 80000], [100000, 80000], [100000, 80000], [30000, 1000]]);
    expect(rows[2].cashExpenses).toBe(86000);
    expect(profitBasisRows([{ month: "Jan 26", revenue: 5, expenses: 3 }])[0]).toMatchObject({ revenue: 5, expenses: 3 }); // older rows
  });

  it("profitTotals adds complete months only when a month is in progress, as the margin tile does", () => {
    // 300,000 - 240,000 = 60,000; 20.0%, the tile's own figures.
    expect(profitTotals(profitBasisRows(ROWS))).toEqual({ rev: 300000, exp: 240000, net: 60000, label: "Total, complete months", partialLeftOut: 1 });
    expect(profitTotals(profitBasisRows(ROWS.slice(0, 3)))).toEqual({ rev: 300000, exp: 240000, net: 60000, label: "Total", partialLeftOut: 0 });
  });

  it("the report CSV gives the same monthly figures and total", () => {
    const lines = buildReportCsv({ rows: profitBasisRows(ROWS), currency: "ZAR" }).split("\r\n");
    expect(lines).toContain("Oct 26,100000,80000,20000,20");
    expect(lines).toContain("Nov 26 (to date),30000,1000,29000,96.67");
    expect(lines).toContain("\"Total, complete months\",300000,240000,60000,20");
  });

  it("the app's monthly chart and both profit-and-loss tables read the profit basis", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(app).toMatch(/<BChart data=\{profitBasisRows\(rows\)\}/);
    expect((app.match(/const totals = profitTotals\(profitBasisRows\(/g) || []).length).toBe(2);
    expect(app).toMatch(/buildReportCsv\(\{ periodLabel, generatedAt: todayStr, rows: profitBasisRows\(monthly\)/);
  });
});
