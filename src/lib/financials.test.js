import { describe, it, expect } from "vitest";
import { fmt, pc, safe, detectExpenseCategory, parseAnyCSV, computeMetrics, trailingGrowthRate, computeGrowthScore, computeRiskScore, detectTrends, applyScenario, runScenario, computeHistoricalTrajectory, detectSeasonality, computeHistoricalConfidence, buildFounderNarrative, parseTransactions, normalizeDescription, dedupeHashInput, computeDedupeHash, aggregateTransactionsByMonth } from "./financials.js";

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
    expect(m.sov).toBeCloseTo(32, 5);             // 40*0.6 + 20*0.4 (lead data present, so the blended weighting applies)
    expect(m.sovLbl).toBe("Defensive");           // 30 <= 32 < 50
    expect(m.taxV).toBeCloseTo(1200, 5);          // 4000 profit * 30% (safe mode)
    expect(m.safV).toBeCloseTo(800, 5);           // 4000 profit * 20% (safe mode)
    expect(m.free).toBeCloseTo(2000, 5);          // 4000 - 1200 - 800
    // Revenue (10000) exceeds expenses (6000): net burn is negative, so
    // there's no runway to report — the company is cash-flow positive.
    expect(m.cashFlowPositive).toBe(true);
    expect(m.burnMonths).toBe(0);
    expect(m.hireReady).toBe(false);              // free (2000) is nowhere near 150,000
    expect(m.breakEven).toBeCloseTo(6000, 5);     // = avgExp (no fixed/variable split exists to do better)
    expect(m.hasData).toBe(true);
    expect(m.dataConfidence).toBe("low");         // a single manually-typed snapshot, no transaction history
  });

  it("computes real runway from net burn, not gross expenses, when a company is actually burning cash", () => {
    // Spending more than earning: $40k/mo expenses against $30k/mo revenue.
    const burning = { mRev: 30000, mExp: 40000, mCash: 100000, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, burning, "safe");
    const netBurn = 40000 - 30000; // 10000
    const safetyBuffer = (30000 - 40000) * 0.20; // totPro * sr, safe mode
    expect(m.cashFlowPositive).toBe(false);
    expect(m.burnMonths).toBeCloseTo((100000 + safetyBuffer) / netBurn, 5); // 9.8 months
  });

  it("scores the Sovereignty Score on margin alone when there's no conversion data, instead of capping it at 60", () => {
    // 90% margin, but no lead/close data at all — true for every CSV/bank
    // upload, since parseAnyCSV always sets leads and closures to 0.
    const noLeadData = { mRev: 90000, mExp: 9000, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, noLeadData, "safe");
    expect(m.hasConversionData).toBe(false);
    expect(m.sov).toBeCloseTo(90, 5);   // margin alone (90%), not margin*0.6 (54) capped by an unfillable conversion term
    expect(m.sovLbl).toBe("Sovereign"); // unreachable under the old formula for any CSV-only user
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
    expect(Number.isFinite(m.burnMonths)).toBe(true); // net burn === 0 short-circuits to 0, not Infinity/NaN
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

  it("flags revenue concentration from the single highest-revenue month, but marks it unreliable under 3 months of history", () => {
    const m = computeMetrics(rows, manual, "safe");
    expect(m.concentration).toBeCloseTo((12000 / 22000) * 100, 5);
    expect(m.concentrationReliable).toBe(false); // only 2 months uploaded — a high reading here is a data-volume artifact, not a signal
  });

  it("considers concentration reliable once there are 3+ months of history", () => {
    const threeRows = [...rows, { revenue: 9000, expenses: 6000, cash: 9000, cogs: 0, marketing: 0, leads: 0, closures: 0, cac: 0, ltv: 0 }];
    const m = computeMetrics(threeRows, manual, "safe");
    expect(m.concentrationReliable).toBe(true);
  });

  it("has medium data confidence for a short uploaded history, and high confidence at 3+ months", () => {
    expect(computeMetrics(rows, manual, "safe").dataConfidence).toBe("medium");
    const threeRows = [...rows, { revenue: 9000, expenses: 6000, cash: 9000, cogs: 0, marketing: 0, leads: 0, closures: 0, cac: 0, ltv: 0 }];
    expect(computeMetrics(threeRows, manual, "safe").dataConfidence).toBe("high");
  });

  it("has no conversion data from uploaded rows, and is cash-flow positive since revenue exceeds expenses", () => {
    const m = computeMetrics(rows, manual, "safe");
    expect(m.hasConversionData).toBe(false); // parseAnyCSV always sets leads/closures to 0
    expect(m.sov).toBeCloseTo(m.margin, 5);  // falls back to margin alone, not margin*0.6
    expect(m.cashFlowPositive).toBe(true);   // totRev (22000) > totExp (12500)
    expect(m.burnMonths).toBe(0);
  });

  it("projects 90-day revenue by compounding a growth rate three times", () => {
    // Only one month-over-month transition exists in this 2-row dataset, so
    // the trailing average and the raw single-period rate are identical here.
    const m = computeMetrics(rows, manual, "safe");
    expect(m.proj90GrowthRate).toBeCloseTo(20, 5);
    expect(m.proj90).toBeCloseTo(12000 * Math.pow(1.2, 3), 5);
  });

  it("clamps an extreme single-period growth rate instead of compounding it as-is", () => {
    // A one-time enterprise deal spikes one month from $5,000 to $40,000 —
    // a 700% jump. Uncapped, cubing that produces a $20M+ 90-day forecast
    // from a $40k base.
    const spike = [
      { revenue: 5000,  expenses: 3000, cash: 10000, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 40000, expenses: 20000, cash: 40000, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 },
    ];
    const m = computeMetrics(spike, manual, "safe");
    expect(m.vel).toBeCloseTo(700, 5);           // the raw, unclamped month-over-month rate
    expect(m.proj90GrowthRate).toBe(50);         // clamped to the ±50%/month heuristic bound
    expect(m.proj90).toBeCloseTo(40000 * Math.pow(1.5, 3), 5); // ~$135k, not ~$20.5M
  });

  it("smooths a recent outlier month using the trailing average instead of the single latest period", () => {
    const steady = [
      { revenue: 10000, expenses: 6000, cash: 0, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 10500, expenses: 6000, cash: 0, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 11000, expenses: 6000, cash: 0, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 16500, expenses: 6000, cash: 0, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 }, // +50% in one month
    ];
    const m = computeMetrics(steady, manual, "safe");
    expect(m.vel).toBeCloseTo(50, 5);            // raw last-period rate
    expect(m.proj90GrowthRate).toBeLessThan(m.vel); // averaged across the last 3 transitions, not just the spike
    expect(m.proj90GrowthRate).toBeCloseTo((5 + (500/10500*100) + 50) / 3, 3);
  });
});

describe("trailingGrowthRate", () => {
  it("falls back to the single-period rate when there's no row history to average", () => {
    expect(trailingGrowthRate(null, 12.5)).toBe(12.5);
    expect(trailingGrowthRate([{ revenue: 100 }], 12.5)).toBe(12.5);
  });
});

describe("computeGrowthScore", () => {
  it("rates flat/unknown growth as neutral, not good or bad", () => {
    const g = computeGrowthScore(null, 0);
    expect(g.score).toBeCloseTo(50, 5);
    expect(g.label).toBe("Flat");
  });

  it("rates consistent, strong growth across three months as Accelerating", () => {
    const rows = [
      { revenue: 10000 }, { revenue: 10500 }, { revenue: 11000 }, { revenue: 16500 },
    ];
    const g = computeGrowthScore(rows, 50);
    expect(g.consistency).toBe(1); // all three transitions were positive
    expect(g.score).toBe(100);
    expect(g.label).toBe("Accelerating");
  });

  it("rates a steady month-over-month decline as Declining", () => {
    const rows = [{ revenue: 20000 }, { revenue: 18000 }, { revenue: 16000 }];
    const g = computeGrowthScore(rows, -11.111111);
    expect(g.consistency).toBe(0); // both transitions were negative
    expect(g.rate).toBeCloseTo(-10.5556, 3);
    expect(g.label).toBe("Declining");
  });
});

describe("computeRiskScore", () => {
  it("scores a profitable, cash-flow-positive company as Low risk", () => {
    const r = computeRiskScore({ cashFlowPositive: true, burnMonths: 0, concentration: 100, concentrationReliable: false, ltvcac: 4, margin: 40 });
    expect(r.score).toBe(0);
    expect(r.label).toBe("Low");
  });

  it("scores a burning-but-well-funded, unprofitable company as Watch, not Critical", () => {
    // 9.8 months of runway (above the 8-month safe threshold) but a -33% margin.
    const r = computeRiskScore({ cashFlowPositive: false, burnMonths: 9.8, concentration: 100, concentrationReliable: false, ltvcac: 0, margin: -33.33 });
    expect(r.breakdown.runwayRisk).toBe(0); // runway itself isn't the problem here
    expect(r.breakdown.marginRisk).toBe(100);
    expect(r.score).toBeCloseTo(30, 1); // 100 * 0.3 (margin weight)
    expect(r.label).toBe("Watch");
  });

  it("scores a company with under a month of effective runway and negative margin as Critical", () => {
    const r = computeRiskScore({ cashFlowPositive: false, burnMonths: -0.159, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: -4900 });
    expect(r.breakdown.runwayRisk).toBe(100); // burnMonths <= 0
    expect(r.score).toBeCloseTo(70, 1); // 100*0.4 + 100*0.3
    expect(r.label).toBe("Critical");
  });

  it("never penalizes a signal for missing data", () => {
    const r = computeRiskScore({ cashFlowPositive: true, burnMonths: 0, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: 40 });
    expect(r.breakdown.concentrationRisk).toBe(0);
    expect(r.breakdown.unitEconRisk).toBe(0);
  });
});

describe("detectTrends", () => {
  const rows = [
    { revenue: 20000, expenses: 12000, payroll: 6000,  marketing:0, cogs:0, rent:0, software:0 },
    { revenue: 20000, expenses: 12500, payroll: 6200,  marketing:0, cogs:0, rent:0, software:0 },
    { revenue: 20000, expenses: 13000, payroll: 6300,  marketing:0, cogs:0, rent:0, software:0 },
    { revenue: 20000, expenses: 17000, payroll: 11000, marketing:0, cogs:0, rent:0, software:0 },
  ];

  it("requires at least 3 months of real rows before claiming any trend", () => {
    expect(detectTrends(null)).toEqual([]);
    expect(detectTrends([{ revenue: 100, expenses: 50 }])).toEqual([]);
  });

  it("flags a declining margin trend against the prior months' average", () => {
    const trends = detectTrends(rows);
    const marginTrend = trends.find(t => t.type === "margin");
    expect(marginTrend.direction).toBe("declining");
    expect(marginTrend.message).toContain("15.0%");
    expect(marginTrend.message).toContain("37.5%");
  });

  it("flags a category creeping up as a share of total expenses", () => {
    const trends = detectTrends(rows);
    const creep = trends.find(t => t.type === "expense_creep");
    expect(creep.category).toBe("payroll");
    expect(creep.direction).toBe("worsening");
  });

  it("flags a shrinking profit cushion as a worsening burn trend", () => {
    // expenses-minus-revenue went from -$7,500/mo (profitable) to -$3,000/mo —
    // still profitable, but the cushion shrank by $4,500, which is exactly
    // the kind of early warning a founder should see before it flips to a
    // real burn.
    const trends = detectTrends(rows);
    const burnTrend = trends.find(t => t.type === "burn");
    expect(burnTrend.direction).toBe("worsening");
  });

  it("stays quiet when nothing has moved meaningfully", () => {
    const flat = [
      { revenue: 20000, expenses: 12000, payroll: 6000, marketing:0, cogs:0, rent:0, software:0 },
      { revenue: 20000, expenses: 12050, payroll: 6010, marketing:0, cogs:0, rent:0, software:0 },
      { revenue: 20000, expenses: 12020, payroll: 6005, marketing:0, cogs:0, rent:0, software:0 },
    ];
    expect(detectTrends(flat)).toEqual([]);
  });
});

describe("applyScenario", () => {
  const baseline = { revenue: 50000, expenses: 40000, cash: 100000, cac: 200, ltv: 800, leads: 0, closures: 0 };

  it("returns the baseline unchanged when there are no adjustments", () => {
    const m = applyScenario(baseline, {});
    expect(m).toEqual({ mRev: 50000, mExp: 40000, mCash: 100000, mCac: 200, mLtv: 800, mLeads: 0, mClose: 0 });
  });

  it("applies a revenue drop as a percentage of the baseline", () => {
    const m = applyScenario(baseline, { revenuePct: -20 });
    expect(m.mRev).toBeCloseTo(40000, 5); // 50000 * 0.8
    expect(m.mExp).toBe(40000);
  });

  it("applies a cost cut as a percentage of expenses", () => {
    const m = applyScenario(baseline, { expensePct: -15 });
    expect(m.mExp).toBeCloseTo(34000, 5); // 40000 * 0.85
  });

  it("applies a flat expense addition, e.g. a new hire's monthly cost", () => {
    const m = applyScenario(baseline, { expenseDelta: 8000 });
    expect(m.mExp).toBe(48000); // 40000 + 8000
  });

  it("applies a one-time cash adjustment", () => {
    const m = applyScenario(baseline, { cashDelta: -25000 });
    expect(m.mCash).toBe(75000);
  });

  it("never lets an adjustment push revenue, expenses, or cash negative", () => {
    const m = applyScenario(baseline, { revenuePct: -150, expensePct: -150, cashDelta: -999999 });
    expect(m.mRev).toBe(0);
    expect(m.mExp).toBe(0);
    expect(m.mCash).toBe(0);
  });
});

describe("runScenario", () => {
  it("compares a cost-cut scenario against the unadjusted baseline using the real calculation engine", () => {
    const baseline = { revenue: 50000, expenses: 40000, cash: 100000, cac: 0, ltv: 0, leads: 0, closures: 0 };
    const { before, after } = runScenario(baseline, { expensePct: -15 }, "safe");
    expect(before.margin).toBeCloseTo(20, 5);   // (50000-40000)/50000*100
    expect(after.margin).toBeCloseTo(32, 5);    // (50000-34000)/50000*100
    expect(after.risk.score).toBeLessThanOrEqual(before.risk.score); // cutting costs should never look riskier
  });

  it("shows a new hire's cost pulling margin down and risk up", () => {
    const baseline = { revenue: 50000, expenses: 40000, cash: 100000, cac: 0, ltv: 0, leads: 0, closures: 0 };
    const { before, after } = runScenario(baseline, { expenseDelta: 8000 }, "safe");
    expect(after.margin).toBeLessThan(before.margin);
    expect(after.free).toBeLessThan(before.free);
  });
});

describe("computeHistoricalTrajectory", () => {
  // 6 months, revenue and margin both improving every single month.
  const snapshots = [
    { period_month: "2026-01-01", revenue: 10000, expenses: 8000 },
    { period_month: "2026-02-01", revenue: 10500, expenses: 8200 },
    { period_month: "2026-03-01", revenue: 11000, expenses: 8300 },
    { period_month: "2026-04-01", revenue: 11500, expenses: 8400 },
    { period_month: "2026-05-01", revenue: 12000, expenses: 8500 },
    { period_month: "2026-06-01", revenue: 12500, expenses: 8600 },
  ];

  it("detects a full-history improving-margin streak, not just latest-vs-prior", () => {
    const t = computeHistoricalTrajectory(snapshots);
    expect(t.monthsOfHistory).toBe(6);
    expect(t.margin.direction).toBe("improving");
    expect(t.margin.streak.length).toBe(5); // every one of the 5 month-over-month deltas was up
    expect(t.margin.current).toBeCloseTo(31.2, 1); // (12500-8600)/12500*100
  });

  it("detects a matching revenue growth streak", () => {
    const t = computeHistoricalTrajectory(snapshots);
    expect(t.revenue.direction).toBe("growing");
    expect(t.revenue.streak.length).toBe(5);
  });

  it("reads a widening profit cushion as improving cash flow", () => {
    const t = computeHistoricalTrajectory(snapshots);
    expect(t.cashFlow.direction).toBe("improving");
  });

  it("reads roughly flat concentration when growth is uniform across months", () => {
    const t = computeHistoricalTrajectory(snapshots);
    expect(t.concentration.direction).toBe("flat");
  });

  it("breaks a streak the moment a month moves the other direction", () => {
    const withDip = [
      { period_month: "2026-01-01", revenue: 10000, expenses: 8000 }, // margin 20%
      { period_month: "2026-02-01", revenue: 10000, expenses: 7800 }, // margin 22%
      { period_month: "2026-03-01", revenue: 10000, expenses: 7600 }, // margin 24%
      { period_month: "2026-04-01", revenue: 10000, expenses: 8200 }, // margin 18% — the dip
      { period_month: "2026-05-01", revenue: 10000, expenses: 8000 }, // margin 20%
      { period_month: "2026-06-01", revenue: 10000, expenses: 7800 }, // margin 22%
    ];
    const t = computeHistoricalTrajectory(withDip);
    expect(t.margin.streak.length).toBe(2); // only the last two improving deltas count, the dip breaks the longer run
  });

  it("returns null with fewer than 2 months — one point isn't a trajectory", () => {
    expect(computeHistoricalTrajectory([{ period_month: "2026-01-01", revenue: 10000, expenses: 8000 }])).toBeNull();
    expect(computeHistoricalTrajectory(null)).toBeNull();
  });
});

describe("detectSeasonality", () => {
  it("requires at least 13 months before claiming any seasonal pattern", () => {
    const short = Array.from({ length: 12 }, (_, i) => ({ period_month: `2026-${String((i % 12) + 1).padStart(2,"0")}-01`, revenue: 10000, expenses: 8000 }));
    expect(detectSeasonality(short)).toBeNull();
  });

  it("flags a calendar month that's consistently well above average across two occurrences", () => {
    // 24 months: every month is $10,000 except December (index 11), which is $13,000 both years.
    const snapshots = [];
    for (let y = 0; y < 2; y++) {
      for (let m = 0; m < 12; m++) {
        const revenue = m === 11 ? 13000 : 10000;
        snapshots.push({ period_month: `${2024 + y}-${String(m + 1).padStart(2,"0")}-01`, revenue, expenses: 8000 });
      }
    }
    const seasonal = detectSeasonality(snapshots);
    expect(seasonal).toHaveLength(1);
    expect(seasonal[0].month).toBe("December");
    expect(seasonal[0].occurrences).toBe(2);
    expect(seasonal[0].avgDeltaPct).toBeGreaterThan(15);
  });

  it("does not flag a month that only occurred once, even if unusual", () => {
    // 13 consecutive months starting January always re-lands on January at
    // i=12 — so the outlier must sit somewhere else (i=6, July) to actually
    // test a month that occurs exactly once in this span.
    const snapshots = Array.from({ length: 13 }, (_, i) => ({
      period_month: `2025-${String((i % 12) + 1).padStart(2,"0")}-01`,
      revenue: i === 6 ? 50000 : 10000,
      expenses: 8000,
    }));
    expect(detectSeasonality(snapshots)).toEqual([]);
  });
});

describe("computeHistoricalConfidence", () => {
  it("scales confidence with months of real history", () => {
    expect(computeHistoricalConfidence(1)).toMatchObject({ score: 40, label: "low" });
    expect(computeHistoricalConfidence(3)).toMatchObject({ score: 60, label: "medium" });
    expect(computeHistoricalConfidence(8)).toMatchObject({ score: 80, label: "high" });
    expect(computeHistoricalConfidence(15)).toMatchObject({ score: 92, label: "very high" });
  });

  it("a single month never scores as high as a full year", () => {
    expect(computeHistoricalConfidence(1).score).toBeLessThan(computeHistoricalConfidence(12).score);
  });
});

describe("buildFounderNarrative", () => {
  it("gives context, not just a number, when a real trajectory exists", () => {
    const snapshots = [
      { period_month: "2026-01-01", revenue: 10000, expenses: 8000 },
      { period_month: "2026-02-01", revenue: 10500, expenses: 8200 },
      { period_month: "2026-03-01", revenue: 11000, expenses: 8300 },
      { period_month: "2026-04-01", revenue: 11500, expenses: 8400 },
      { period_month: "2026-05-01", revenue: 12000, expenses: 8500 },
      { period_month: "2026-06-01", revenue: 12500, expenses: 8600 },
    ];
    const t = computeHistoricalTrajectory(snapshots);
    const narrative = buildFounderNarrative(t, t.margin.current);
    expect(narrative).toContain("improved for 6 consecutive months");
    expect(narrative).toContain("Revenue has been growing for 6 consecutive months");
  });

  it("falls back to a plain statement with no invented context when there's no trajectory", () => {
    const narrative = buildFounderNarrative(null, 20);
    expect(narrative).toContain("20.0%");
    expect(narrative).toContain("one data point isn't a trend");
  });
});

describe("parseTransactions", () => {
  it("emits one signed record per row from a single-Amount bank export", () => {
    const csv = "Date,Description,Amount\n2026-01-05,Client payment received,5000\n2026-01-10,AWS hosting fee,-200\n";
    const result = parseTransactions(csv);
    expect(result.mode).toBe("bank");
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({ txn_date: "2026-01-05", amount: 5000, category: null });
    expect(result.transactions[1]).toMatchObject({ txn_date: "2026-01-10", amount: -200, category: "software" });
  });

  it("nets named Revenue/Expenses columns into one signed amount per row", () => {
    const csv = "Date,Revenue,Expenses\n2026-01-01,10000,6000\n";
    const result = parseTransactions(csv);
    expect(result.mode).toBe("named");
    expect(result.transactions[0].amount).toBe(4000); // net of the two columns on that row
  });

  it("parses day-before-month for ambiguous DD/MM/YYYY dates, matching parseAnyCSV's convention", () => {
    const csv = "Date,Description,Amount\n05/01/2026,Client payment,1000\n";
    const result = parseTransactions(csv);
    expect(result.transactions[0].txn_date).toBe("2026-01-05"); // 05/01 read as 5 January, not May 1st
  });

  it("skips rows with no parseable date rather than guessing one", () => {
    const csv = "Date,Description,Amount\nnot-a-date,Mystery transaction,500\n2026-02-01,Real transaction,500\n";
    const result = parseTransactions(csv);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].description).toBe("Real transaction");
  });

  it("returns null when nothing usable is found", () => {
    expect(parseTransactions("Date,Revenue,Expenses\n")).toBeNull();
  });
});

describe("normalizeDescription / dedupeHashInput", () => {
  it("normalizes case, punctuation, and whitespace so equivalent descriptions match", () => {
    expect(normalizeDescription("Payment - Acme Corp.")).toBe(normalizeDescription("payment  acme corp"));
    expect(normalizeDescription("Payment - Acme Corp.")).toBe("payment acme corp");
  });

  it("builds the same hash input for the same date/description/amount regardless of formatting", () => {
    const a = { txn_date: "2026-01-05", description: "Payment - Acme Corp.", amount: 1250 };
    const b = { txn_date: "2026-01-05", description: "payment  acme corp", amount: 1250.001 }; // sub-cent float noise
    expect(dedupeHashInput(a)).toBe(dedupeHashInput(b));
  });

  it("produces a different hash input when the amount actually differs", () => {
    const a = { txn_date: "2026-01-05", description: "Rent", amount: 1000 };
    const b = { txn_date: "2026-01-05", description: "Rent", amount: 1000.5 };
    expect(dedupeHashInput(a)).not.toBe(dedupeHashInput(b));
  });
});

describe("computeDedupeHash", () => {
  it("produces a stable 64-character hex SHA-256 digest", async () => {
    const hash = await computeDedupeHash({ txn_date: "2026-01-05", description: "Client payment received", amount: 5000 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces identical hashes for two uploads describing the same real-world transaction", async () => {
    const first  = await computeDedupeHash({ txn_date: "2026-04-03", description: "Client Invoice - Acme Retainer", amount: 18500 });
    const second = await computeDedupeHash({ txn_date: "2026-04-03", description: "client invoice   acme retainer", amount: 18500 });
    expect(first).toBe(second); // this is exactly what makes an overlapping re-upload deduplicate silently
  });

  it("produces different hashes for genuinely different transactions", async () => {
    const a = await computeDedupeHash({ txn_date: "2026-04-03", description: "Client Invoice - Acme", amount: 18500 });
    const b = await computeDedupeHash({ txn_date: "2026-04-04", description: "Client Invoice - Acme", amount: 18500 });
    expect(a).not.toBe(b);
  });
});

describe("aggregateTransactionsByMonth", () => {
  it("buckets signed transactions into the same monthly-row shape computeMetrics expects", () => {
    const txns = [
      { txn_date: "2026-03-05", description: "Client invoice", amount: 18500, category: null },
      { txn_date: "2026-03-10", description: "AWS hosting",    amount: -1240, category: "software" },
      { txn_date: "2026-03-12", description: "Payroll run",    amount: -14200, category: "payroll" },
      { txn_date: "2026-04-02", description: "Client invoice", amount: 20000, category: null },
    ];
    const rows = aggregateTransactionsByMonth(txns);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ period_month: "2026-03-01", revenue: 18500, expenses: 15440, software: 1240, payroll: 14200 });
    expect(rows[1]).toMatchObject({ period_month: "2026-04-01", revenue: 20000, expenses: 0 });
  });

  it("feeds directly into computeMetrics with correct results", () => {
    const txns = [
      { txn_date: "2026-03-01", description: "Revenue", amount: 50000, category: null },
      { txn_date: "2026-03-05", description: "Costs",   amount: -40000, category: "cogs" },
    ];
    const rows = aggregateTransactionsByMonth(txns);
    const m = computeMetrics(rows, { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 }, "safe");
    expect(m.margin).toBeCloseTo(20, 5); // (50000-40000)/50000*100
    expect(m.cogsRatio).toBeCloseTo(80, 5); // 40000/50000*100
  });

  it("returns an empty array for no transactions, not null or an error", () => {
    expect(aggregateTransactionsByMonth([])).toEqual([]);
    expect(aggregateTransactionsByMonth(null)).toEqual([]);
  });
});
