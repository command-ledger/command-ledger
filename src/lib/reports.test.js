// Held profit figures never reach Reports or its CSV as numbers (Project 3,
// found in the advisor's coverage map). Before this, the Reports summary
// printed "Net profit -R 120 000" and a -20.0% margin for a business whose
// tiles showed --- because R45,000 of money in over the last 3 months (R180,000
// over the year) was unidentified, and "Net profit R 366 000" for one that had
// not answered the VAT question. The rule is the tiles' own: while profit is
// held, every profit-basis figure is held, with its reason. No formula changes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCENARIOS, scenarioEvidence } from "./advisor-scenarios.js";
import { buildReportSummary, buildReportCsv, profitHold, profitBasisRows, aggregateTransactionsByMonth, fmt, pc, HELD_MARK } from "./financials.js";

const run = id => SCENARIOS.find(s => s.id === id).build().m;
const value = (summary, label) => summary.find(([k]) => k === label)?.[1];
const PROFIT_ROWS = ["Profit margin", "Net profit", "Profit after reserves"];

// A registered business with no VAT classes, close to break-even: dividing
// revenue gives 100,000 / 1.15 - 95,000 = -8,043.48 a month, dividing costs
// gives 100,000 - 95,000 / 1.15 = +17,391.30, so the profit could be either
// sign and is held (vatHold "unclassified").
function unclassified() {
  let n = 0;
  const t = (txn_date, amount, description) => ({ id: ++n, source_batch_id: "00000000-0000-4000-8000-000000000001", txn_date, amount, description, category: null, currency: "ZAR", dedupe_hash: `r${n}` });
  const txns = ["2026-04", "2026-05", "2026-06"].flatMap(ym => [t(`${ym}-05`, 100000, "Payment from Acme Trading"), t(`${ym}-28`, -95000, "Supplier invoice Makro")]);
  return scenarioEvidence({ txns, cash: { amount: 200000, on: "2026-07-15" }, vat: { applies: true, registered: true, from: "2025-03-01" } }).m;
}

describe("why profit is held", () => {
  it("names the hold the tiles use, or none", () => {
    expect(profitHold(run("healthy"))).toBeNull();
    expect(profitHold(run("unidentified_material")).kind).toBe("unconfirmed_money");
    expect(profitHold(run("vat_unanswered")).kind).toBe("vat_unanswered");
    expect(profitHold(unclassified()).kind).toBe("vat_unclassified");
  });
});

describe("the Reports summary", () => {
  it("unconfirmed money in: no profit figure is printed; the hidden loss of R120,000 appears nowhere", () => {
    const m = run("unidentified_material");
    expect(m.totPro).toBe(-120000); // the figure the tiles hold back
    const s = buildReportSummary({ m, currency: "ZAR" });
    PROFIT_ROWS.forEach(k => expect(value(s, k), k).toBe(HELD_MARK));
    expect(value(s, "Profit figures held")).toMatch(/not confirmed/);
    expect(value(s, "Tax reserve and tax paid")).toMatch(/^--- .*held/);
    const text = JSON.stringify(s);
    expect(text).not.toContain(fmt(-120000, "ZAR"));
    expect(text).not.toContain(pc(m.margin));
    // Growth was not measured (money in unconfirmed): not a score.
    expect(value(s, "Growth score")).toBe("Not enough data");
  });

  it("VAT unanswered: the R366,000 profit and its reserves are held; cash figures stand", () => {
    const m = run("vat_unanswered");
    expect(m.totPro).toBe(366000);
    const s = buildReportSummary({ m, currency: "ZAR", cashBalance: { amount: 500000, on: "2026-07-15" } });
    PROFIT_ROWS.forEach(k => expect(value(s, k), k).toBe(HELD_MARK));
    expect(value(s, "Profit figures held")).toMatch(/registered for VAT/);
    expect(JSON.stringify(s)).not.toContain(fmt(366000, "ZAR"));
    expect(value(s, "Cash balance")).toBe(`${fmt(500000, "ZAR")} on 2026-07-15`);
    expect(value(s, "Runway")).toBe("No burn");
  });

  it("VAT unclassified could flip the result: held, and no 'lowest figure' row is offered instead", () => {
    const m = unclassified();
    expect(m.vatHold.reason).toBe("unclassified");
    const s = buildReportSummary({ m, currency: "ZAR", vatInfo: { registered: true } });
    PROFIT_ROWS.forEach(k => expect(value(s, k), k).toBe(HELD_MARK));
    expect(s.find(([k]) => k === "Profit is a lowest figure")).toBeUndefined();
  });

  it("no hold: the figures print exactly as before", () => {
    const m = run("healthy");
    const s = buildReportSummary({ m, currency: "ZAR" });
    expect(value(s, "Net profit")).toBe(fmt(366000, "ZAR"));          // 11 x 30,000 + 36,000
    expect(value(s, "Profit after reserves")).toBe(fmt(183000, "ZAR")); // x (1 - 0.3 - 0.2)
    expect(value(s, "Profit margin")).toBe(pc(m.margin));
    expect(value(s, "Growth score")).toBe("50/100 (Flat)");
    expect(s.find(([k]) => k === "Profit figures held")).toBeUndefined();
  });
});

describe("the Reports CSV", () => {
  it("held: every month's net and margin, and the total's, read 'held'; revenue and costs stand", () => {
    const sc = SCENARIOS.find(s => s.id === "unidentified_material");
    const { m } = sc.build();
    const hold = profitHold(m);
    // The period's monthly rows, as Reports passes them.
    const months = ["2025-07", "2025-08"].map(ym => ({ period_month: `${ym}-01`, month: ym, revenue: 50000, expenses: 60000, profitRevenue: 50000, profitExpenses: 60000, partial: false }));
    const csv = buildReportCsv({ rows: profitBasisRows(months), summary: buildReportSummary({ m, currency: "ZAR" }), currency: "ZAR", profitHold: hold });
    const lines = csv.split("\r\n");
    // The reason has commas, so the cell is quoted.
    expect(lines).toContain(`Profit figures held,"${hold.reason}"`);
    expect(lines).toContain("2025-07,50000,60000,held,held");
    expect(lines).toContain("Total,100000,120000,held,held");
    expect(csv).not.toMatch(/-10000|-20000|-120000/);
    expect(lines).toContain("Net profit,held");
    expect(csv).not.toContain("'---");
  });

  it("no hold: net and margin are numbers, as before", () => {
    const rows = [{ period_month: "2026-06-01", month: "Jun 26", revenue: 100, expenses: 40, partial: false }];
    expect(buildReportCsv({ rows, currency: "ZAR" }).split("\r\n")).toContain("Jun 26,100,40,60,60");
  });
});

// The wiring: the page and the file use the one summary, and the hold reaches
// both tables and the CSV. These read the source, as workspace.test.js does.
describe("App.jsx", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const reports = app.slice(app.indexOf("function ReportsSection"), app.indexOf("// ─── SECTION:", app.indexOf("function ReportsSection") + 10));
  const financials = app.slice(app.indexOf("function FinancialsSection"), app.indexOf("function ReportsSection"));
  it("builds the summary in one place and passes the hold to the CSV", () => {
    expect(app).toMatch(/const reportSummary = buildReportSummary\(\{ m, currency: cur,/);
    expect(app).not.toMatch(/\["Profit margin", pc\(margin\)\]/);
    expect(reports).toMatch(/buildReportCsv\(\{[^}]*profitHold: reportHold/);
  });
  it("holds net and margin in both monthly tables, and the allocator's amounts", () => {
    expect((reports.match(/reportHold \? HELD_MARK/g) || []).length).toBeGreaterThanOrEqual(4);
    expect((financials.match(/hold \? HELD_MARK/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(financials).toMatch(/Tax year to date is not shown/);
  });
  it("holds the dashboard chart's net as well", () => {
    expect(app).toMatch(/<BChart data=\{profitBasisRows\(rows\)\} currency=\{cur\} held=\{!!ctx\.reportHold\}\/>/);
    expect(app).toMatch(/\{held \? HELD_MARK : fmt\(net, currency\)\}/);
  });
});

// Project 3, founder's decision of 20 November 2026: while profit is held for
// VAT, every figure built on that profit is held with it, on every screen.
// Hiring capacity, operating break-even, the 3-month result and the risk score
// all read the profit basis; cash break-even, burn, runway, revenue and costs
// do not, and stand.
describe("the VAT hold reaches every figure built on profit", () => {
  const item = (ev, id) => ev.items.find(i => i.id === id);
  for (const [name, get] of [["VAT unanswered", () => SCENARIOS.find(s => s.id === "vat_unanswered").build()], ["VAT unclassified", () => {
    let n = 0;
    const t = (txn_date, amount, description) => ({ id: ++n, source_batch_id: "00000000-0000-4000-8000-000000000001", txn_date, amount, description, category: null, currency: "ZAR", dedupe_hash: `v${n}` });
    const txns = ["2026-04", "2026-05", "2026-06"].flatMap(ym => [t(`${ym}-05`, 100000, "Payment from Acme Trading"), t(`${ym}-28`, -95000, "Supplier invoice Makro")]);
    return scenarioEvidence({ txns, cash: { amount: 200000, on: "2026-07-15" }, vat: { applies: true, registered: true, from: "2025-03-01" } });
  }]]) {
    it(`${name}: the engine holds them and keeps the cash figures`, () => {
      const { m } = get();
      expect(m.vatHold).toBeTruthy();
      expect(m.hiringCapacityConfidence.shown).toBe(false);
      expect(m.operatingBreakEvenConfidence.shown).toBe(false);
      expect(m.risk.score).toBeNull();
      expect(m.risk.unknown).toMatch(/VAT/);
      expect(m.breakEvenConfidence.shown).toBe(true); // cash break-even stands
    });
    it(`${name}: Reports and the CSV show them as held`, () => {
      const { m } = get();
      const s = buildReportSummary({ m, currency: "ZAR" });
      ["Hiring capacity", "Operating break-even, monthly revenue (last 3 months)", "Risk score"].forEach(k => expect(value(s, k), k).toBe(HELD_MARK));
      expect(value(s, "Cash break-even, monthly money in from customers (last 3 months)")).toBe(fmt(m.cashBreakEven, "ZAR"));
      const csv = buildReportCsv({ rows: [], summary: s, currency: "ZAR", profitHold: profitHold(m) });
      expect(csv).toContain("Hiring capacity,held");
      expect(csv).toContain("Risk score,held");
    });
    it(`${name}: the Advisor's evidence holds them, with no value`, () => {
      const { evidence } = get();
      ["window_result", "window_margin", "hiring_capacity", "break_even_operating", "risk_score"].forEach(id => {
        expect(item(evidence, id), id).toMatchObject({ status: "held", value: null, display: "Not available" });
      });
      expect(item(evidence, "operating_gap")).toBeUndefined();
      ["break_even_cash", "window_revenue", "window_costs", "net_burn"].forEach(id => expect(item(evidence, id).status, id).toBe("available"));
    });
  }

  it("unanswered VAT, by hand: cash break-even R 90 000 and R 32 000 above it still show", () => {
    const { m } = SCENARIOS.find(s => s.id === "vat_unanswered").build();
    expect(m.cashBreakEven).toBe(90000);
    expect(m.cashIn - m.cashBreakEven).toBe(32000);
    expect(m.cashFlowPositive).toBe(true);
  });

  it("no VAT hold: the four figures are unchanged (registered, profit at its lowest but not flipped)", () => {
    const { m } = SCENARIOS.find(s => s.id === "vat_registered").build();
    expect(m.vatHold).toBeNull();
    expect(m.hiringCapacity).toBe(12869.57);            // 16,086.96 x 0.8
    expect(m.hiringCapacityConfidence.shown).toBe(true);
    expect(m.operatingBreakEvenConfidence.shown).toBe(true);
    expect(m.risk.score).not.toBeNull();
  });

  it("the screens use the same holds: the hiring tile says why, Financials holds operating break-even", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(app).toMatch(/sub: vatWait \|\| \(burnGap \?/);
    expect(app).toMatch(/\{operatingBreakEvenConfidence\.shown\s*\? <p/);
  });
});

// Founder's decision of 20 November 2026: the trend and history lines read cash
// (revenue and costs as they moved), so they say "cash margin", never a bare
// "margin" that reads as the profit margin a VAT hold keeps back. Wording only:
// the figures are worked by hand and unchanged.
describe("cash margin lines are labelled as cash", async () => {
  const { detectTrends, buildFounderNarrative, computeHistoricalTrajectory } = await import("./financials.js");
  const rows = [{ revenue: 100000, expenses: 80000 }, { revenue: 100000, expenses: 80000 }, { revenue: 100000, expenses: 86000 }];
  it("the trend: (100,000 - 86,000) / 100,000 = 14.0% against an average of 20.0%", () => {
    const t = detectTrends(rows, null, "ZAR").find(x => x.type === "margin");
    expect(t.message).toBe("Cash margin fell to 14.0% in the latest complete month, vs a 20.0% average over the prior 2 month(s).");
  });
  it("the history: the latest month's cash margin, 14.0%", () => {
    expect(buildFounderNarrative(computeHistoricalTrajectory(rows.slice(1)), 0)).toBe("Cash margin was 14.0% in the latest complete month.");
  });
  it("with one month on file the profit margin is named, and held while profit is held", () => {
    expect(buildFounderNarrative(null, 25.3)).toMatch(/^Profit margin is 25\.3% this period\./);
    expect(buildFounderNarrative(null, null)).toBe("Connect more months of history for trend context: one data point isn't a trend.");
  });
  it("under a VAT hold, no trend or history line says a bare 'Margin'", () => {
    const { m } = SCENARIOS.find(s => s.id === "vat_unanswered").build();
    const lines = [...m.trends.map(t => t.message), m.founderNarrative || ""];
    lines.forEach(l => expect(l, l).not.toMatch(/(^|[.] )Margin\b/));
    expect(lines.join(" ")).toMatch(/Cash margin/);
  });
});
