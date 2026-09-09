import { describe, it, expect } from "vitest";
import { fmt, pc, safe, detectExpenseCategory, parseAnyCSV, computeMetrics, trailingGrowthRate, computeGrowthScore, computeRiskScore, detectTrends, applyScenario, runScenario, computeHistoricalTrajectory, detectSeasonality, computeHistoricalConfidence, buildFounderNarrative, parseTransactions, normalizeDescription, dedupeHashInput, computeDedupeHash, aggregateTransactionsByMonth, computeConfidence, capSeverityForVolume, extractCounterparty, isAggregatorCounterparty, nameSimilarity, groupCounterparties, computeRevenueConcentration, classifyCadence, obligationConfidence, detectRecurringObligations, projectForwardCalendar, summarizeCalendarByWeek, computeForwardRunway, checkAffordability, detectMissedObligations, computeDirective, getDirectiveMetricValue, describeDirectiveOutcome } from "./financials.js";

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

  it("defaults concentration to unreliable/zero when no revenueConcentration context is supplied", () => {
    // computeMetrics can't derive real client concentration from monthly
    // rows alone — it needs raw transaction descriptions, passed in via
    // context.revenueConcentration. Without it, this never fabricates a
    // reading or penalizes Risk Score for data it was never given.
    const m = computeMetrics(rows, manual, "safe");
    expect(m.concentration).toBe(0);
    expect(m.concentrationReliable).toBe(false);
  });

  it("feeds a supplied revenueConcentration result through to concentration/concentrationReliable", () => {
    const revenueConcentration = { shown: true, largestPct: 72 };
    const m = computeMetrics(rows, manual, "safe", { revenueConcentration });
    expect(m.concentration).toBe(72);
    expect(m.concentrationReliable).toBe(true);
    expect(m.revenueConcentration).toBe(revenueConcentration);
  });

  it("ignores a low-confidence revenueConcentration result rather than treating it as reliable", () => {
    const revenueConcentration = { shown: false, largestPct: null };
    const m = computeMetrics(rows, manual, "safe", { revenueConcentration });
    expect(m.concentration).toBe(0);
    expect(m.concentrationReliable).toBe(false);
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

  it("extracts a counterparty for a positive-amount row, and never for an expense row", () => {
    const csv = "Date,Description,Amount\n2026-01-05,Client Payment - Coastal Retail Group,5000\n2026-01-10,AWS hosting fee,-200\n";
    const result = parseTransactions(csv);
    expect(result.transactions[0].counterparty).toBe("coastal retail group");
    expect(result.transactions[1].counterparty).toBeNull(); // expense row — not in scope
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

describe("computeConfidence", () => {
  it("scores volume alone into low/moderate/high bands", () => {
    expect(computeConfidence(1).level).toBe("low");
    expect(computeConfidence(2).level).toBe("low");
    expect(computeConfidence(4).level).toBe("moderate");
    expect(computeConfidence(5).level).toBe("moderate");
    expect(computeConfidence(8).level).toBe("high");
    expect(computeConfidence(14).level).toBe("high");
  });

  it("states the month count in the reason, singular vs plural", () => {
    expect(computeConfidence(1).reason).toBe("based on 1 month of data");
    expect(computeConfidence(6).reason).toBe("based on 6 months of data");
  });

  it("degrades one level when the most recent transaction is over 45 days old", () => {
    const fresh = new Date();
    fresh.setDate(fresh.getDate() - 10);
    const stale = new Date();
    stale.setDate(stale.getDate() - 60);

    expect(computeConfidence(8, fresh.toISOString()).level).toBe("high");
    expect(computeConfidence(8, stale.toISOString()).level).toBe("moderate");
    expect(computeConfidence(8, stale.toISOString()).reason).toContain("days since your last upload");
  });

  it("never degrades low below low — there's no lower floor", () => {
    const stale = new Date();
    stale.setDate(stale.getDate() - 100);
    expect(computeConfidence(1, stale.toISOString()).level).toBe("low");
  });
});

describe("capSeverityForVolume", () => {
  it("caps a critical directive to warn from a single month of data", () => {
    expect(capSeverityForVolume("critical", 1)).toBe("warn");
    expect(capSeverityForVolume("critical", 0)).toBe("warn");
  });

  it("leaves critical alone once there are 2+ months of data", () => {
    expect(capSeverityForVolume("critical", 2)).toBe("critical");
  });

  it("leaves non-critical severities untouched regardless of volume", () => {
    expect(capSeverityForVolume("warn", 1)).toBe("warn");
    expect(capSeverityForVolume("go", 1)).toBe("go");
    expect(capSeverityForVolume("stable", 1)).toBe("stable");
  });
});

describe("computeMetrics — per-metric confidence", () => {
  it("suppresses runway when the business is burning cash but no cash balance was entered", () => {
    const burningNoCash = { mRev: 30000, mExp: 40000, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, burningNoCash, "safe");
    expect(m.hasCashData).toBe(false);
    expect(m.runwayConfidence).toEqual({ shown: false, level: null, reason: expect.stringContaining("no cash balance entered") });
  });

  it("shows runway confidence once a cash balance is entered, even from one month of data", () => {
    const burning = { mRev: 30000, mExp: 40000, mCash: 100000, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, burning, "safe");
    expect(m.runwayConfidence).toMatchObject({ shown: true, level: "low" });
  });

  it("does not require a cash balance to show runway confidence when already cash-flow positive", () => {
    const healthy = { mRev: 30000, mExp: 20000, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, healthy, "safe");
    expect(m.cashFlowPositive).toBe(true);
    expect(m.runwayConfidence.shown).toBe(true);
  });

  it("suppresses LTV:CAC unless both CAC and LTV are present, never showing it as a real 0", () => {
    const missingCac = { mRev: 10000, mExp: 6000, mCash: 0, mCac: 0, mLtv: 800, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, missingCac, "safe");
    expect(m.hasUnitEconomicsData).toBe(false);
    expect(m.ltvcacConfidence.shown).toBe(false);
    expect(m.ltvcac).toBe(0); // the raw number stays 0 internally — the UI layer is responsible for not rendering it
  });

  it("shows LTV:CAC confidence once both inputs are present", () => {
    const manual = { mRev: 10000, mExp: 6000, mCash: 0, mCac: 200, mLtv: 800, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, manual, "safe");
    expect(m.ltvcacConfidence).toMatchObject({ shown: true, level: "low" }); // one manual snapshot = 1 month
  });

  it("raises confidence level as more months of uploaded history accumulate", () => {
    const row = { revenue: 10000, expenses: 6000, cash: 5000, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 };
    const manual = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const oneMonth = computeMetrics([row], manual, "safe");
    const fourMonths = computeMetrics(Array(4).fill(row), manual, "safe");
    const eightMonths = computeMetrics(Array(8).fill(row), manual, "safe");
    expect(oneMonth.breakEvenConfidence.level).toBe("low");
    expect(fourMonths.breakEvenConfidence.level).toBe("moderate");
    expect(eightMonths.breakEvenConfidence.level).toBe("high");
  });

  it("passes the most recent transaction date through to degrade confidence on stale history", () => {
    const rows = Array(8).fill({ revenue: 10000, expenses: 6000, cash: 5000, cogs:0, marketing:0, leads:0, closures:0, cac:0, ltv:0 });
    const manual = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const stale = new Date();
    stale.setDate(stale.getDate() - 90);
    const m = computeMetrics(rows, manual, "safe", { lastTxnDate: stale.toISOString() });
    expect(m.breakEvenConfidence.level).toBe("moderate"); // degraded from high
  });
});

describe("extractCounterparty", () => {
  it("strips known transactional prefixes and leading separators", () => {
    expect(extractCounterparty("Client Payment - Coastal Retail Group")).toBe("coastal retail group");
    expect(extractCounterparty("Wholesale Order - Northgate Distributors")).toBe("northgate distributors");
    expect(extractCounterparty("Direct Sales - Shopify Payout")).toBe("shopify payout");
    expect(extractCounterparty("Invoice: Acme Corp")).toBe("acme corp");
    expect(extractCounterparty("Payment from Jane Doe")).toBe("jane doe");
    expect(extractCounterparty("Deposit / Northwind Traders")).toBe("northwind traders");
  });

  it("normalizes case and collapses whitespace", () => {
    expect(extractCounterparty("CLIENT PAYMENT -   Acme   Corp")).toBe("acme corp");
  });

  it("strips trailing entity suffixes, including multi-word ones before shorter ones", () => {
    expect(extractCounterparty("Client Payment - Acme Pty Ltd")).toBe("acme");
    expect(extractCounterparty("Client Payment - Acme Ltd")).toBe("acme");
    expect(extractCounterparty("Client Payment - Acme Inc")).toBe("acme");
    expect(extractCounterparty("Client Payment - Acme LLC")).toBe("acme");
    expect(extractCounterparty("Client Payment - Acme CC")).toBe("acme");
  });

  it("returns null for empty or unparseable input, never an empty string", () => {
    expect(extractCounterparty("")).toBeNull();
    expect(extractCounterparty(null)).toBeNull();
    expect(extractCounterparty("Client Payment -")).toBeNull();
  });
});

describe("isAggregatorCounterparty", () => {
  it("flags known payment processors", () => {
    expect(isAggregatorCounterparty("shopify payout")).toBe(true);
    expect(isAggregatorCounterparty("stripe transfer")).toBe(true);
    expect(isAggregatorCounterparty("paypal transfer")).toBe(true);
  });

  it("does not flag a real client whose name happens to share no processor keywords", () => {
    expect(isAggregatorCounterparty("coastal retail group")).toBe(false);
    expect(isAggregatorCounterparty("northgate distributors")).toBe(false);
  });
});

describe("nameSimilarity / groupCounterparties", () => {
  it("scores near-identical names above the 0.85 threshold and distinct names below it", () => {
    expect(nameSimilarity("coastal retail grp", "coastal retail group")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("coastal retail group", "northgate distributors")).toBeLessThan(0.85);
  });

  it("merges near-identical spellings into one entity, keeping the highest-revenue spelling as the label", () => {
    const grouped = groupCounterparties([
      { name: "coastal retail grp", revenue: 2000 },
      { name: "coastal retail group", revenue: 8000 },
      { name: "northgate distributors", revenue: 5000 },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ name: "coastal retail group", revenue: 10000 }); // merged: 8000 + 2000
    expect(grouped[0].members).toContain("coastal retail grp");
    expect(grouped[1]).toMatchObject({ name: "northgate distributors", revenue: 5000 });
  });

  it("keeps genuinely distinct names separate", () => {
    const grouped = groupCounterparties([
      { name: "acme corp", revenue: 1000 },
      { name: "beta industries", revenue: 1000 },
    ]);
    expect(grouped).toHaveLength(2);
  });
});

describe("computeRevenueConcentration", () => {
  it("returns a not-shown result with no income transactions", () => {
    const r = computeRevenueConcentration([]);
    expect(r.shown).toBe(false);
    expect(r.largestPct).toBeNull();
    expect(r.severity).toBeNull();
  });

  it("computes largest/top3/HHI/distinct-payer figures once extraction confidence is adequate", () => {
    const txns = [
      { amount: 6000, description: "Client Payment - Coastal Retail Group" },
      { amount: 2000, description: "Client Payment - Northgate Distributors" },
      { amount: 1000, description: "Client Payment - Third Client Ltd" },
      { amount: 1000, description: "Client Payment - Fourth Client Ltd" },
      { amount: -500, description: "Office rent" }, // expense — excluded from income
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.shown).toBe(true);
    expect(r.confidenceLevel).toBe("high"); // 4/4 income transactions extracted
    expect(r.distinctPayers).toBe(4);
    expect(r.largestPct).toBeCloseTo(60, 5); // 6000/10000
    expect(r.top3Pct).toBeCloseTo(90, 5);    // (6000+2000+1000)/10000
    expect(r.hhi).toBeCloseTo(0.36 + 0.04 + 0.01 + 0.01, 5);
  });

  it("merges fuzzy-matched payer names before computing concentration", () => {
    const txns = [
      { amount: 5000, description: "Client Payment - Coastal Retail Group" },
      { amount: 3000, description: "Client Payment - Coastal Retail Grp" },
      { amount: 2000, description: "Client Payment - Northgate Distributors" },
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.distinctPayers).toBe(2); // the two Coastal spellings merged into one
    expect(r.largestPct).toBeCloseTo(80, 5); // (5000+3000)/10000
  });

  it("marks low confidence and suppresses percentages when under 60% of income transactions yield a payer name", () => {
    const txns = [
      { amount: 1000, description: "Client Payment - Acme Corp" }, // extracts fine
      { amount: 1000, description: "Deposit" },  // prefix-only — strips to nothing
      { amount: 1000, description: "Receipt" },  // prefix-only — strips to nothing
      { amount: 1000, description: "Invoice" },  // prefix-only — strips to nothing
      { amount: 1000, description: "Sales" },    // prefix-only — strips to nothing
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.extractionRate).toBeCloseTo(0.2, 5); // only 1 of 5
    expect(r.confidenceLevel).toBe("low");
    expect(r.shown).toBe(false);
    expect(r.largestPct).toBeNull();
    expect(r.severity).toBeNull();
    expect(r.reason).toContain("could not be reliably extracted from 80%");
  });

  it("excludes payment processors from concentration risk while still reporting their revenue", () => {
    const txns = [
      { amount: 7000, description: "Direct Sales - Shopify Payout" },
      { amount: 1500, description: "Client Payment - Acme Corp" },
      { amount: 1500, description: "Client Payment - Beta Industries" },
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.payers.map(p => p.name)).not.toContain("shopify payout");
    expect(r.aggregatorRevenue).toBe(7000);
    expect(r.aggregatorPct).toBeCloseTo(70, 5);
    // Concentration is judged against total revenue, not just the
    // identified-client slice, so a big processor share doesn't inflate
    // the apparent client concentration among the two real clients.
    expect(r.largestPct).toBeCloseTo(15, 5); // 1500/10000
  });

  it("flags fewer than 3 distinct payers as warn even when the split looks even", () => {
    const txns = [
      { amount: 5000, description: "Client Payment - Acme Corp" },
      { amount: 5000, description: "Client Payment - Beta Industries" },
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.distinctPayers).toBe(2);
    expect(r.severity).toBe("warn");
  });

  it("flags warn above 40% and critical above 60% for the largest client", () => {
    const warnCase = computeRevenueConcentration([
      { amount: 4500, description: "Client Payment - Acme Corp" },
      { amount: 2000, description: "Client Payment - Beta Industries" },
      { amount: 2000, description: "Client Payment - Gamma LLC" },
      { amount: 1500, description: "Client Payment - Delta Inc" },
    ]);
    expect(warnCase.largestPct).toBeCloseTo(45, 5);
    expect(warnCase.severity).toBe("warn");

    const criticalCase = computeRevenueConcentration([
      { amount: 6500, description: "Client Payment - Acme Corp" },
      { amount: 1500, description: "Client Payment - Beta Industries" },
      { amount: 1000, description: "Client Payment - Gamma LLC" },
      { amount: 1000, description: "Client Payment - Delta Inc" },
    ]);
    expect(criticalCase.largestPct).toBeCloseTo(65, 5);
    expect(criticalCase.severity).toBe("critical");
  });

  it("issues no severity at all when the split is healthy", () => {
    const r = computeRevenueConcentration([
      { amount: 2500, description: "Client Payment - Acme Corp" },
      { amount: 2500, description: "Client Payment - Beta Industries" },
      { amount: 2500, description: "Client Payment - Gamma LLC" },
      { amount: 2500, description: "Client Payment - Delta Inc" },
    ]);
    expect(r.largestPct).toBeCloseTo(25, 5);
    expect(r.distinctPayers).toBe(4);
    expect(r.severity).toBeNull();
  });
});

// Independent of financials.js's own addDaysUTC — computes an expected
// date without relying on the same code being tested.
function addDays(base, days) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("classifyCadence", () => {
  it("classifies each interval band", () => {
    expect(classifyCadence(7)).toBe("weekly");
    expect(classifyCadence(6)).toBe("weekly");
    expect(classifyCadence(8)).toBe("weekly");
    expect(classifyCadence(30)).toBe("monthly");
    expect(classifyCadence(28)).toBe("monthly");
    expect(classifyCadence(33)).toBe("monthly");
    expect(classifyCadence(90)).toBe("quarterly");
    expect(classifyCadence(365)).toBe("annual");
  });

  it("returns null for an interval that doesn't fit any known band", () => {
    expect(classifyCadence(15)).toBeNull();
    expect(classifyCadence(200)).toBeNull();
    expect(classifyCadence(0)).toBeNull();
  });
});

describe("obligationConfidence", () => {
  it("marks an annual obligation low confidence when the dataset is under 13 months, regardless of occurrence count", () => {
    expect(obligationConfidence(10, "annual", "fixed", 300)).toBe("low");
  });

  it("scores 6+ consistent occurrences as high confidence", () => {
    expect(obligationConfidence(6, "monthly", "fixed", 200)).toBe("high");
    expect(obligationConfidence(8, "annual", "fixed", 400)).toBe("high");
  });

  it("does not grant high confidence to a variable-amount obligation even with many occurrences", () => {
    expect(obligationConfidence(8, "monthly", "variable", 200)).toBe("moderate");
  });

  it("scores 4-5 occurrences as moderate and exactly 3 as low", () => {
    expect(obligationConfidence(4, "monthly", "fixed", 100)).toBe("moderate");
    expect(obligationConfidence(5, "monthly", "fixed", 100)).toBe("moderate");
    expect(obligationConfidence(3, "monthly", "fixed", 100)).toBe("low");
  });
});

describe("detectRecurringObligations", () => {
  it("detects a monthly rent payment from 3 consistent occurrences", () => {
    const txns = [
      { txn_date: "2026-01-02", amount: -12000, description: "Rent - Unit 14 Epping" },
      { txn_date: "2026-02-02", amount: -12000, description: "Rent - Unit 14 Epping" },
      { txn_date: "2026-03-02", amount: -12000, description: "Rent - Unit 14 Epping" },
    ];
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-03-10" });
    expect(ob.cadence).toBe("monthly");
    expect(ob.typical_amount).toBe(12000);
    expect(ob.amount_variance).toBe("fixed");
    expect(ob.occurrences).toBe(3);
    expect(ob.confidence).toBe("low"); // only 3 occurrences
    expect(ob.day_of_month).toBe(2);
    expect(ob.last_seen).toBe("2026-03-02");
    expect(ob.active).toBe(true);
  });

  it("raises confidence to high with 6+ consistent occurrences", () => {
    const txns = Array.from({ length: 6 }, (_, i) => ({
      txn_date: addDays("2026-01-02", i * 30), amount: -5000, description: "Payroll Run",
    }));
    const [ob] = detectRecurringObligations(txns, { asOf: addDays("2026-01-02", 5 * 30 + 5) });
    expect(ob.confidence).toBe("high");
  });

  it("groups differently-formatted descriptions of the same obligation via normalization", () => {
    const txns = [
      { txn_date: "2026-01-05", amount: -800, description: "SARS - PAYE" },
      { txn_date: "2026-02-05", amount: -800, description: "sars  paye" },
      { txn_date: "2026-03-05", amount: -800, description: "SARS - PAYE." },
    ];
    const obligations = detectRecurringObligations(txns, { asOf: "2026-03-10" });
    expect(obligations).toHaveLength(1);
    expect(obligations[0].occurrences).toBe(3);
  });

  it("detects a weekly cadence", () => {
    const txns = [
      { txn_date: "2026-01-05", amount: -500, description: "Weekly Cleaning Service" },
      { txn_date: "2026-01-12", amount: -500, description: "Weekly Cleaning Service" },
      { txn_date: "2026-01-19", amount: -500, description: "Weekly Cleaning Service" },
    ];
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-01-25" });
    expect(ob.cadence).toBe("weekly");
  });

  it("detects a quarterly cadence", () => {
    const txns = [
      { txn_date: "2026-01-15", amount: -9000, description: "VAT Payment" },
      { txn_date: "2026-04-15", amount: -9000, description: "VAT Payment" },
      { txn_date: "2026-07-15", amount: -9000, description: "VAT Payment" },
    ];
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-07-20" });
    expect(ob.cadence).toBe("quarterly");
  });

  it("flags an inconsistent-amount obligation as variable and uses the trailing 3-occurrence mean", () => {
    const txns = [
      { txn_date: "2026-01-10", amount: -1000, description: "Electricity" },
      { txn_date: "2026-02-10", amount: -1400, description: "Electricity" },
      { txn_date: "2026-03-10", amount: -1800, description: "Electricity" },
      { txn_date: "2026-04-10", amount: -2200, description: "Electricity" },
    ];
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-04-15" });
    expect(ob.amount_variance).toBe("variable");
    expect(ob.typical_amount).toBeCloseTo((1400 + 1800 + 2200) / 3, 2);
  });

  it("does not detect a pattern with inconsistent spacing", () => {
    const txns = [
      { txn_date: "2026-01-05", amount: -1000, description: "Ad Hoc Contractor" },
      { txn_date: "2026-01-20", amount: -1000, description: "Ad Hoc Contractor" },
      { txn_date: "2026-03-28", amount: -1000, description: "Ad Hoc Contractor" },
    ];
    expect(detectRecurringObligations(txns, { asOf: "2026-04-01" })).toEqual([]);
  });

  it("requires at least 3 occurrences", () => {
    const txns = [
      { txn_date: "2026-01-02", amount: -12000, description: "Rent" },
      { txn_date: "2026-02-02", amount: -12000, description: "Rent" },
    ];
    expect(detectRecurringObligations(txns, { asOf: "2026-02-10" })).toEqual([]);
  });

  it("ignores positive-amount (income) transactions entirely", () => {
    const txns = [
      { txn_date: "2026-01-02", amount: 12000, description: "Client Payment - Acme" },
      { txn_date: "2026-02-02", amount: 12000, description: "Client Payment - Acme" },
      { txn_date: "2026-03-02", amount: 12000, description: "Client Payment - Acme" },
    ];
    expect(detectRecurringObligations(txns, { asOf: "2026-03-10" })).toEqual([]);
  });

  it("marks an obligation inactive once it's gone quiet for more than 2 cadence periods", () => {
    const txns = [
      { txn_date: "2026-01-02", amount: -12000, description: "Rent" },
      { txn_date: "2026-02-02", amount: -12000, description: "Rent" },
      { txn_date: "2026-03-02", amount: -12000, description: "Rent" },
    ];
    // Monthly cadence (30-day nominal period) — 2 periods = 60 days. Last
    // seen 2026-03-02; asking as of 2026-05-15 is ~74 days later.
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-05-15" });
    expect(ob.active).toBe(false);
  });

  it("marks an annual obligation low confidence when detected from under 13 months of overall history", () => {
    // This can't actually happen for a genuinely-annual pattern (3 real
    // annual-spaced occurrences inherently span ~2 years) — verified via
    // obligationConfidence directly above. This test documents that the
    // guard is still wired through detectRecurringObligations's own
    // dataSpanDays computation for a real 3-occurrence annual pattern.
    const txns = [
      { txn_date: "2024-06-01", amount: -18000, description: "Annual Insurance Premium" },
      { txn_date: "2025-06-01", amount: -18000, description: "Annual Insurance Premium" },
      { txn_date: "2026-06-01", amount: -18000, description: "Annual Insurance Premium" },
    ];
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-06-10" });
    expect(ob.cadence).toBe("annual");
    expect(ob.confidence).toBe("low"); // 3 occurrences alone already caps it at low
  });
});

describe("projectForwardCalendar", () => {
  const monthly = { label: "Rent", cadence: "monthly", typical_amount: 12000, next_expected: "2026-01-31", active: true };

  it("projects an obligation's occurrences across the horizon, stepped by its cadence", () => {
    const events = projectForwardCalendar([monthly], "2026-01-01", 90);
    const second = addDays("2026-01-31", 30);
    const third = addDays(second, 30);
    expect(events.map(e => e.date)).toEqual(["2026-01-31", second, third]);
    expect(events.every(e => e.amount === 12000)).toBe(true);
  });

  it("excludes inactive obligations", () => {
    const events = projectForwardCalendar([{ ...monthly, active: false }], "2026-01-01", 90);
    expect(events).toEqual([]);
  });

  it("produces no events when next_expected falls beyond the horizon", () => {
    const farOut = { ...monthly, next_expected: "2026-06-01" };
    const events = projectForwardCalendar([farOut], "2026-01-01", 90);
    expect(events).toEqual([]);
  });
});

describe("summarizeCalendarByWeek", () => {
  it("sums event amounts into 7-day buckets", () => {
    const events = [
      { date: "2026-01-01", amount: 100 },
      { date: "2026-01-03", amount: 200 },
      { date: "2026-01-10", amount: 500 },
    ];
    const weeks = summarizeCalendarByWeek(events, "2026-01-01", 14);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({ weekStart: "2026-01-01", weekEnd: "2026-01-07", total: 300 });
    expect(weeks[1]).toMatchObject({ weekStart: "2026-01-08", weekEnd: "2026-01-14", total: 500 });
  });
});

describe("computeForwardRunway", () => {
  it("crosses zero on the obligation's actual due date, not a smoothed average", () => {
    // Background nets to zero by construction (avgExp fully accounted for
    // by the one recurring obligation), so the entire decline traces to
    // the obligation's two dated hits at day 30 and day 60.
    const obligations = [{ label: "Rent", cadence: "monthly", typical_amount: 1000, next_expected: "2026-01-31", active: true }];
    const result = computeForwardRunway({
      currentCash: 1500, avgRev: 0, avgExp: 1000, obligations, fromDate: "2026-01-01", horizonDays: 90,
    });
    expect(result.crossesZero).toBe(true);
    expect(result.crossDate).toBe(addDays("2026-01-01", 60));
    expect(result.daysUntilCross).toBe(60);
    expect(result.monthsUntilCross).toBe(2);
  });

  it("does not cross zero when cash comfortably outlasts the horizon", () => {
    const obligations = [{ label: "Rent", cadence: "monthly", typical_amount: 1000, next_expected: "2026-01-31", active: true }];
    const result = computeForwardRunway({
      currentCash: 1000000, avgRev: 0, avgExp: 1000, obligations, fromDate: "2026-01-01", horizonDays: 90,
    });
    expect(result.crossesZero).toBe(false);
  });

  it("catches a payment due exactly on fromDate, not just future days", () => {
    const obligations = [{ label: "Rent", cadence: "monthly", typical_amount: 5000, next_expected: "2026-01-01", active: true }];
    const result = computeForwardRunway({
      currentCash: 3000, avgRev: 0, avgExp: 5000, obligations, fromDate: "2026-01-01", horizonDays: 90,
    });
    expect(result.crossesZero).toBe(true);
    expect(result.crossDate).toBe("2026-01-01");
    expect(result.daysUntilCross).toBe(0);
  });

  it("excludes inactive obligations from both the background rate and the calendar", () => {
    const obligations = [{ label: "Old Subscription", cadence: "monthly", typical_amount: 500, next_expected: "2026-01-31", active: false }];
    const result = computeForwardRunway({
      currentCash: 2000, avgRev: 0, avgExp: 0, obligations, fromDate: "2026-01-01", horizonDays: 90,
    });
    expect(result.crossesZero).toBe(false); // the inactive obligation contributes nothing
  });
});

describe("checkAffordability", () => {
  it("confirms affordability holds for 12 months when the math supports it", () => {
    const result = checkAffordability({
      currentCash: 50000, avgRev: 10000, avgExp: 8000, obligations: [], monthlyCost: 1500, fromDate: "2026-01-01",
    });
    expect(result.affordable).toBe(true);
  });

  it("returns the specific month a hypothetical cost would break the runway", () => {
    // No existing obligations or background flow — isolates the synthetic
    // cost's own two hits (day 0 and day 30) against a $3,000 cushion.
    const result = checkAffordability({
      currentCash: 3000, avgRev: 0, avgExp: 0, obligations: [], monthlyCost: 1000, fromDate: "2026-01-01",
    });
    expect(result.affordable).toBe(false);
    expect(result.breaksInMonth).toBe(2);
    expect(result.breakDate).toBe(addDays("2026-01-01", 60));
  });

  it("treats the hypothetical cost as purely additive, not already reflected in avgExp", () => {
    // avgRev - avgExp - monthlyCost = 10000 - 8000 - 1500 = +500/month —
    // healthy — even though avgExp doesn't yet include this new cost.
    const result = checkAffordability({
      currentCash: 5000, avgRev: 10000, avgExp: 8000, obligations: [], monthlyCost: 1500, fromDate: "2026-01-01",
    });
    expect(result.affordable).toBe(true);
  });
});

describe("detectMissedObligations", () => {
  it("surfaces an obligation more than 7 days past its expected date", () => {
    const obligations = [
      { label: "Rent — Unit 14 Epping", cadence: "monthly", next_expected: "2026-01-01", active: true },
    ];
    const [missed] = detectMissedObligations(obligations, "2026-01-05" /* 4 days past — not yet flagged */);
    expect(missed).toBeUndefined();

    const [flagged] = detectMissedObligations(obligations, "2026-01-12" /* 11 days past */);
    expect(flagged.daysPast).toBe(11);
    expect(flagged.message).toBe("Rent — Unit 14 Epping was expected 11 days ago and has not appeared.");
  });

  it("does not flag an obligation that isn't yet overdue by more than 7 days", () => {
    const obligations = [{ label: "Rent", cadence: "monthly", next_expected: "2026-01-01", active: true }];
    expect(detectMissedObligations(obligations, "2026-01-06")).toEqual([]); // exactly 5 days past
  });

  it("never flags an inactive obligation", () => {
    const obligations = [{ label: "Cancelled Subscription", cadence: "monthly", next_expected: "2026-01-01", active: false }];
    expect(detectMissedObligations(obligations, "2026-02-01")).toEqual([]);
  });
});

describe("computeDirective", () => {
  const healthy = { margin: 25, burnMonths: 8, free: 20000, vel: 12, conv: 15, hireReady: false, ltvcac: 4, months: 6, concentration: null };

  it("issues negative_free_cash as critical, above every other signal", () => {
    const d = computeDirective({ ...healthy, free: -500, burnMonths: 1, ltvcac: 1 });
    expect(d.rule).toBe("negative_free_cash");
    expect(d.targetMetric).toBe("free");
    expect(d.severity).toBe("critical");
  });

  it("issues low_runway as critical when runway is under 3 months and free cash is still positive", () => {
    const d = computeDirective({ ...healthy, burnMonths: 2 });
    expect(d.rule).toBe("low_runway");
    expect(d.targetMetric).toBe("burnMonths");
    expect(d.severity).toBe("critical");
  });

  it("issues client_concentration ahead of unit-economics/conversion signals when present", () => {
    const concentration = { shown: true, severity: "critical", largestPct: 72, distinctPayers: 4 };
    const d = computeDirective({ ...healthy, ltvcac: 1, conv: 5, concentration });
    expect(d.rule).toBe("client_concentration");
    expect(d.targetMetric).toBe("concentration");
    expect(d.severity).toBe("critical");
  });

  it("never issues client_concentration from a low-confidence extraction", () => {
    const concentration = { shown: false, severity: "critical", largestPct: 72, distinctPayers: 4 };
    const d = computeDirective({ ...healthy, ltvcac: 1, concentration });
    expect(d.rule).not.toBe("client_concentration");
  });

  it("issues poor_unit_economics as warn", () => {
    const d = computeDirective({ ...healthy, ltvcac: 1.5 });
    expect(d.rule).toBe("poor_unit_economics");
    expect(d.targetMetric).toBe("ltvcac");
    expect(d.severity).toBe("warn");
  });

  it("issues weak_conversion as warn", () => {
    const d = computeDirective({ ...healthy, conv: 5 });
    expect(d.rule).toBe("weak_conversion");
    expect(d.targetMetric).toBe("conv");
  });

  it("issues scale_window as go when margin and conversion both clear threshold", () => {
    const d = computeDirective({ ...healthy, margin: 45, conv: 25 });
    expect(d.rule).toBe("scale_window");
    expect(d.targetMetric).toBe("vel");
    expect(d.severity).toBe("go");
  });

  it("issues hire_ready as go", () => {
    const d = computeDirective({ ...healthy, margin: 20, conv: 15, hireReady: true });
    expect(d.rule).toBe("hire_ready");
    expect(d.targetMetric).toBe("free");
    expect(d.severity).toBe("go");
  });

  it("issues stalled_growth as warn when velocity is low but non-negative", () => {
    const d = computeDirective({ ...healthy, margin: 20, conv: 15, vel: 2 });
    expect(d.rule).toBe("stalled_growth");
  });

  it("falls back to stable_foundation when nothing else fires", () => {
    const d = computeDirective({ ...healthy, margin: 20, conv: 15, vel: -3 });
    expect(d.rule).toBe("stable_foundation");
    expect(d.severity).toBe("stable");
  });

  it("caps a would-be critical severity to warn from a single month of data, and flags wasCapped", () => {
    const d = computeDirective({ ...healthy, free: -500, months: 1 });
    expect(d.severity).toBe("warn");
    expect(d.wasCapped).toBe(true);
  });

  it("does not cap severity once there are 2+ months of data", () => {
    const d = computeDirective({ ...healthy, free: -500, months: 2 });
    expect(d.severity).toBe("critical");
    expect(d.wasCapped).toBe(false);
  });
});

describe("getDirectiveMetricValue", () => {
  const metrics = { free: 12000, burnMonths: 4.5, ltvcac: 3.2, conv: 18, vel: 9 };
  const concentration = { shown: true, largestPct: 42.5 };

  it("reads a plain numeric metric by name", () => {
    expect(getDirectiveMetricValue("free", metrics, concentration)).toBe(12000);
    expect(getDirectiveMetricValue("burnMonths", metrics, concentration)).toBe(4.5);
  });

  it("reads concentration's largestPct specifically for the 'concentration' target", () => {
    expect(getDirectiveMetricValue("concentration", metrics, concentration)).toBe(42.5);
  });

  it("returns null when concentration isn't confidently shown", () => {
    expect(getDirectiveMetricValue("concentration", metrics, { shown: false })).toBeNull();
  });

  it("returns null for an unknown or non-numeric target metric", () => {
    expect(getDirectiveMetricValue("hireReady", { hireReady: true }, null)).toBeNull();
    expect(getDirectiveMetricValue("nonsense", metrics, concentration)).toBeNull();
  });
});

describe("describeDirectiveOutcome", () => {
  it("reports pending with days remaining when under 60 days have elapsed", () => {
    const issued = new Date();
    issued.setDate(issued.getDate() - 20);
    const result = describeDirectiveOutcome({ target_metric: "free", metric_at_issue: 1000, outcome_metric: null, issued_at: issued.toISOString() });
    expect(result.status).toBe("pending");
    expect(result.message).toContain("40 day");
  });

  it("states a higher-is-better metric's movement as improved when it rises", () => {
    const result = describeDirectiveOutcome({ target_metric: "free", metric_at_issue: 1000, outcome_metric: 5000, issued_at: "2026-01-01" });
    expect(result.status).toBe("measured");
    expect(result.improved).toBe(true);
    expect(result.message).toContain("$1,000");
    expect(result.message).toContain("$5,000");
  });

  it("states a lower-is-better metric's (concentration) movement as improved when it falls", () => {
    const result = describeDirectiveOutcome({ target_metric: "concentration", metric_at_issue: 70, outcome_metric: 45, issued_at: "2026-01-01" });
    expect(result.improved).toBe(true);
    expect(result.message).toBe("Revenue concentration in your largest client moved from 70.0% to 45.0%.");
  });

  it("states the same concentration movement as not improved when it rises", () => {
    const result = describeDirectiveOutcome({ target_metric: "concentration", metric_at_issue: 40, outcome_metric: 65, issued_at: "2026-01-01" });
    expect(result.improved).toBe(false);
  });

  it("states no change neutrally without an improved/worsened verdict", () => {
    const result = describeDirectiveOutcome({ target_metric: "burnMonths", metric_at_issue: 4, outcome_metric: 4, issued_at: "2026-01-01" });
    expect(result.improved).toBeNull();
    expect(result.message).toContain("has not moved");
  });

  it("falls back to pending for an unrecognized target metric even with an outcome value present", () => {
    const result = describeDirectiveOutcome({ target_metric: "unknown_thing", metric_at_issue: 1, outcome_metric: 2, issued_at: "2026-01-01" });
    expect(result.status).toBe("pending");
  });
});
