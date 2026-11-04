import { describe, it, expect } from "vitest";
import { fmtCompact, filterTransactions, searchWorkspace, buildAlerts, buildReportCsv } from "./financials.js";

const txns = [
  { txn_date: "2026-01-05", description: "AWS hosting", category: "software", amount: -1500 },
  { txn_date: "2026-02-03", description: "Acme Corp invoice 1041", category: null, amount: 12500.5 },
  { txn_date: "2026-03-01", description: "Office rent March", category: "rent", amount: -3200 },
  { txn_date: "2026-03-15", description: "Acme Corp invoice 1052", category: null, amount: 9800 },
];

describe("fmtCompact", () => {
  it("keeps exact figures below $100k so small businesses see real numbers", () => {
    expect(fmtCompact(5000)).toBe("$5,000");
    expect(fmtCompact(99999)).toBe("$99,999");
  });
  it("compacts large figures", () => {
    expect(fmtCompact(1234567)).toBe("$1.2M");
    expect(fmtCompact(-250000)).toBe("-$250K");
  });
});

describe("filterTransactions", () => {
  it("matches description and category case-insensitively", () => {
    expect(filterTransactions(txns, "acme").length).toBe(2);
    expect(filterTransactions(txns, "RENT").map(t => t.description)).toEqual(["Office rent March"]);
  });
  it("requires every word to match", () => {
    expect(filterTransactions(txns, "acme 1052").map(t => t.amount)).toEqual([9800]);
  });
  it("matches a date prefix", () => {
    expect(filterTransactions(txns, "2026-03").length).toBe(2);
  });
  it("matches amounts regardless of sign, $ and commas, whole dollars matching any cents", () => {
    expect(filterTransactions(txns, "1500").map(t => t.description)).toEqual(["AWS hosting"]);
    expect(filterTransactions(txns, "$12,500").map(t => t.amount)).toEqual([12500.5]);
    expect(filterTransactions(txns, "12500.50").map(t => t.amount)).toEqual([12500.5]);
    expect(filterTransactions(txns, "150")).toEqual([]); // no prefix matching on amounts
  });
  it("returns everything for an empty query", () => {
    expect(filterTransactions(txns, "  ").length).toBe(4);
  });
});

describe("searchWorkspace", () => {
  const destinations = [
    { id: "forecasts", label: "Forecasts", keywords: ["runway", "rent", "hire"] },
    { id: "reports", label: "Reports", keywords: ["export", "board"] },
  ];
  it("finds pages by label or keyword prefix", () => {
    expect(searchWorkspace("run", { destinations }).destinations.map(d => d.id)).toEqual(["forecasts"]);
    expect(searchWorkspace("board report", { destinations }).destinations.map(d => d.id)).toEqual(["reports"]);
  });
  it("ignores one-letter tokens for pages", () => {
    expect(searchWorkspace("r", { destinations }).destinations).toEqual([]);
  });
  it("returns matching transactions newest first, limited, with the full count", () => {
    const r = searchWorkspace("acme", { transactions: txns, limit: 1 });
    expect(r.transactions.map(t => t.txn_date)).toEqual(["2026-03-15"]);
    expect(r.transactionTotal).toBe(2);
  });
  it("returns nothing for an empty query", () => {
    expect(searchWorkspace("", { transactions: txns, destinations })).toEqual({ destinations: [], transactions: [], transactionTotal: 0 });
  });
});

describe("buildAlerts", () => {
  const today = "2026-10-31";
  it("asks for data when there is none", () => {
    expect(buildAlerts({ hasData: false, today }).map(a => a.id)).toEqual(["no-data"]);
  });
  it("orders critical before warning before info", () => {
    const alerts = buildAlerts({
      hasData: true, today,
      missedObligations: [{ label: "Rent", normalized_key: "rent", message: "Rent was expected 10 days ago and has not appeared." }],
      needsAcknowledgement: true, latestDirective: { id: "d1", directive_text: "Fix the funnel." },
      directives: [{ id: "d0", directive_text: "Cut spend.", outcome_at: "2026-10-25T00:00:00Z", target_metric: "free", metric_at_issue: -500, outcome_metric: 200, issued_at: "2026-08-20" }],
    });
    expect(alerts.map(a => a.severity)).toEqual(["critical", "warning", "info"]);
    expect(alerts[0].section).toBe("forecasts");
    expect(alerts[1].section).toBe("decisions");
  });
  it("flags data older than the 45-day recency window, and not before", () => {
    expect(buildAlerts({ hasData: true, today, lastTxnDate: "2026-09-01" }).map(a => a.id)).toEqual(["stale-data"]);
    expect(buildAlerts({ hasData: true, today, lastTxnDate: "2026-10-01" })).toEqual([]);
  });
  it("raises a critical directive and an obligation-aware runway warning", () => {
    const alerts = buildAlerts({
      hasData: true, today,
      currentDirective: { severity: "critical", rule: "low_runway", text: "Protect your runway." },
      showForwardRunway: true, forwardRunway: { crossesZero: true, crossDate: "2027-02-01", monthsUntilCross: 3.1 },
    });
    expect(alerts.map(a => a.id)).toEqual(["directive-low_runway", "forward-runway"]);
  });
  it("drops measured outcomes older than 14 days", () => {
    const old = { id: "d0", directive_text: "x", outcome_at: "2026-09-01T00:00:00Z", target_metric: "free", metric_at_issue: 1, outcome_metric: 2, issued_at: "2026-07-01" };
    expect(buildAlerts({ hasData: true, today, directives: [old] })).toEqual([]);
  });
});

describe("buildReportCsv marks a month in progress", () => {
  it("labels a partial month as to date", () => {
    const csv = buildReportCsv({ rows: [{ month: "Oct 26", revenue: 100, expenses: 50 }, { month: "Nov 26", partial: true, revenue: 10, expenses: 5 }] });
    const lines = csv.split(/\r\n/);
    expect(lines).toContain("Nov 26 (to date),10,5,5,50");
    expect(lines).toContain("Oct 26,100,50,50,50");
  });
});

describe("buildReportCsv", () => {
  const csv = buildReportCsv({
    periodLabel: "Last 3 months", generatedAt: "2026-10-31",
    rows: [{ month: "Jan 26", revenue: 10000, expenses: 6000 }, { month: "Feb 26", revenue: 0, expenses: 500 }],
    summary: [["Runway", "No burn"], ["Note", 'Said "hi", then left'], ["Formula", "=HYPERLINK(1)"], ["Profit after reserves", "-$5,000"], ["Sneaky", "-1+cmd"]],
  });
  const lines = csv.split("\r\n");
  it("writes the monthly table with net, margin and a totals row", () => {
    expect(lines).toContain("Jan 26,10000,6000,4000,40");
    expect(lines).toContain("Feb 26,0,500,-500,");        // no margin on zero revenue
    expect(lines).toContain("Total,10000,6500,3500,35");
  });
  it("quotes commas and quotes, and neutralises spreadsheet formulas", () => {
    expect(lines).toContain('Note,"Said ""hi"", then left"');
    expect(lines).toContain("Formula,'=HYPERLINK(1)");
    expect(lines).toContain("Sneaky,'-1+cmd");
  });
  it("leaves negative money readable", () => {
    expect(lines).toContain('Profit after reserves,"-$5,000"');
  });
});

// Every figure App.jsx shows must name its currency. fmt() still defaults to
// USD for older callers, so a call that forgets the currency would print "$"
// beside rand figures without any error. This reads the source and fails on
// any fmt( or fmtCompact( call with a single argument.
describe("App.jsx money formatting", () => {
  it("passes a currency to every fmt and fmtCompact call", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    const missing = [];
    const pattern = /(?<![.\w])(fmtCompact|fmt)\(/g;
    let match;
    while ((match = pattern.exec(src))) {
      let depth = 1, i = pattern.lastIndex, comma = false;
      while (depth > 0 && i < src.length) {
        const ch = src[i];
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        else if (ch === "," && depth === 1) comma = true;
        i++;
      }
      if (!comma) missing.push(`line ${src.slice(0, match.index).split("\n").length}: ${src.slice(match.index, i)}`);
    }
    expect(missing).toEqual([]);
  });
});
