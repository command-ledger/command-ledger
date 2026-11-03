import { describe, it, expect } from "vitest";
import { fmt, pc, safe, detectExpenseCategory, parseAnyCSV, computeMetrics, trailingGrowthRate, computeGrowthScore, computeRiskScore, detectTrends, applyScenario, runScenario, computeHistoricalTrajectory, detectSeasonality, computeHistoricalConfidence, buildFounderNarrative, parseTransactions, normalizeDescription, dedupeHashInput, computeDedupeHash, aggregateTransactionsByMonth, computeConfidence, capSeverityForVolume, extractCounterparty, isAggregatorCounterparty, isGenericCounterparty, nameSimilarity, groupCounterparties, computeRevenueConcentration, classifyCadence, obligationConfidence, detectRecurringObligations, projectForwardCalendar, summarizeCalendarByWeek, computeForwardRunway, checkAffordability, detectMissedObligations, computeDirective, getDirectiveMetricValue, describeDirectiveOutcome, detectCurrentMonthSeasonality, computeSeasonallyAdjustedVelocity, checkoutBlockReason, classifyTwiceMonthly } from "./financials.js";

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
    expect(m.hiringCapacity).toBeCloseTo(3200, 5); // (10000-6000) monthly profit * (1 - 20% safe-mode safety share)
    expect(m.breakEven).toBeCloseTo(6000, 5);     // = avgExp (no fixed/variable split exists to do better)
    expect(m.hasData).toBe(true);
    expect(m.dataConfidence).toBe("low");         // a single manually-typed snapshot, no transaction history
  });

  it("computes real runway from net burn, not gross expenses, when a company is actually burning cash", () => {
    // Spending more than earning: $40k/mo expenses against $30k/mo revenue.
    const burning = { mRev: 30000, mExp: 40000, mCash: 100000, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, burning, "safe");
    const netBurn = 40000 - 30000; // 10000
    const safetyBuffer = netBurn * 0.20; // one month's burn * sr, safe mode
    expect(m.cashFlowPositive).toBe(false);
    expect(m.burnMonths).toBeCloseTo((100000 - safetyBuffer) / netBurn, 5); // 9.8 months
  });

  it("sizes hiring capacity to the business, not to a fixed salary", () => {
    // $5k/month revenue at 30% margin: a part-time contractor, not nothing.
    const small = computeMetrics(null, { ...manual, mRev: 5000, mExp: 3500 }, "safe");
    expect(small.hiringCapacity).toBeCloseTo(1200, 5);   // 1500 * 0.8
    // ~$5M/year ($416,667/month) at 20% margin: several senior hires.
    const large = computeMetrics(null, { ...manual, mRev: 416667, mExp: 333333 }, "safe");
    expect(large.hiringCapacity).toBeCloseTo(66667.2, 1); // 83334 * 0.8
    // Growth mode holds back less.
    expect(computeMetrics(null, { ...manual, mRev: 5000, mExp: 3500 }, "growth").hiringCapacity).toBeCloseTo(1350, 5); // 1500 * 0.9
  });

  it("has no hiring capacity from profit when costs exceed revenue", () => {
    const burning = { mRev: 30000, mExp: 40000, mCash: 100000, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    expect(computeMetrics(null, burning, "safe").hiringCapacity).toBe(0);
  });

  it("gives the same hiring capacity whatever the history length", () => {
    const row = { revenue: 20000, expenses: 15000, cash: 50000, cogs: 0, marketing: 0, leads: 0, closures: 0, cac: 0, ltv: 0 };
    const three = computeMetrics([row, row, row], manual, "safe").hiringCapacity;
    const twentyFour = computeMetrics(Array(24).fill(row), manual, "safe").hiringCapacity;
    expect(three).toBeCloseTo(4000, 5); // 5000 * 0.8
    expect(twentyFour).toBeCloseTo(three, 5);
  });

  it("reserves nothing out of a loss, so profit after reserves is the whole loss", () => {
    const burning = { mRev: 30000, mExp: 40000, mCash: 100000, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, burning, "safe");
    expect(m.taxV).toBe(0);
    expect(m.safV).toBe(0);
    expect(m.free).toBeCloseTo(-10000, 5); // not -5000, which reserving 50% of a negative profit produced
  });

  it("scores no runway risk for a burning company that has not entered a cash balance", () => {
    const noCash = { mRev: 30000, mExp: 40000, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
    const m = computeMetrics(null, noCash, "safe");
    expect(m.runwayConfidence.shown).toBe(false);
    expect(m.risk.breakdown.runwayRisk).toBe(0); // unknown runway is missing data, not zero runway
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

  it("reports the same runway for the same cash and burn whatever the history length", () => {
    // $10k/month net burn every month, $60k in the bank at the end.
    const burnRow = { revenue: 20000, expenses: 30000, cash: 60000, cogs: 0, marketing: 0, leads: 0, closures: 0, cac: 0, ltv: 0 };
    const threeMonths = computeMetrics([burnRow, burnRow, burnRow], manual, "safe");
    const fortyEight  = computeMetrics(Array(48).fill(burnRow), manual, "safe");
    expect(threeMonths.burnMonths).toBeCloseTo(5.8, 5); // (60000 - 10000*0.2) / 10000
    expect(fortyEight.burnMonths).toBeCloseTo(5.8, 5);  // was negative: 20% of a $480k cumulative loss outweighed the cash
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
    expect(g.consistency).toBe(1); // both transitions moved the way the rate did: down
    expect(g.rate).toBeCloseTo(-10.5556, 3);
    // 50 + (rateScore - 50) x (0.6 + 0.4 x 1), rateScore = 50 - 10.5556 x 3 = 18.333
    expect(g.score).toBeCloseTo(18.333, 2);
    expect(g.label).toBe("Declining");
  });

  it("reads perfectly flat revenue as Flat, not Declining", () => {
    // No change is not a fall. The old formula scored this 35: "Declining".
    const g = computeGrowthScore([{ revenue: 10000 }, { revenue: 10000 }, { revenue: 10000 }, { revenue: 10000 }], 0);
    expect(g.score).toBeCloseTo(50, 6);
    expect(g.label).toBe("Flat");
  });

  it("scores steady growth above one spike at the same average rate", () => {
    // Both average 8% a month, so rateScore = 50 + 8 x 3 = 74.
    const steady = computeGrowthScore([{ revenue: 10000 }, { revenue: 10800 }, { revenue: 11664 }, { revenue: 12597.12 }], 8);
    const spike  = computeGrowthScore([{ revenue: 10000 }, { revenue: 9000 }, { revenue: 12060 }, { revenue: 12060 }], 0); // -10%, +34%, 0%
    expect(steady.score).toBeCloseTo(74, 6);   // 50 + 24 x (0.6 + 0.4 x 1)
    expect(spike.score).toBeCloseTo(67.6, 6);  // 50 + 24 x (0.6 + 0.4 x 1/3)
    expect(steady.label).toBe("Growing");
    expect(spike.label).toBe("Growing");
  });

  it("reads a steady decline as worse than a noisy one at the same rate", () => {
    // Both average -8% a month, so rateScore = 50 - 8 x 3 = 26.
    const steady = computeGrowthScore([{ revenue: 10000 }, { revenue: 9200 }, { revenue: 8464 }, { revenue: 7786.88 }], -8);
    const noisy  = computeGrowthScore([{ revenue: 10000 }, { revenue: 11000 }, { revenue: 7260 }, { revenue: 7260 }], 0); // +10%, -34%, 0%
    expect(steady.score).toBeCloseTo(26, 6);   // 50 - 24 x (0.6 + 0.4 x 1)
    expect(noisy.score).toBeCloseTo(32.4, 6);  // 50 - 24 x (0.6 + 0.4 x 1/3)
    expect(steady.label).toBe("Declining");
    expect(noisy.label).toBe("Declining");
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

  it("raises risk from a declining margin trend even when every level-based signal still looks fine", () => {
    // Healthy current levels (cash-flow positive, margin above threshold),
    // but margin has been declining for months — the exact case Risk Score
    // used to stay silent about until a threshold was finally crossed.
    const trends = [{ type: "margin", direction: "declining", message: "..." }];
    const r = computeRiskScore({ cashFlowPositive: true, burnMonths: 0, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: 27, trends, growthScore: 35 });
    expect(r.breakdown.trendRisk).toBe(70);
    expect(r.score).toBeCloseTo(14, 1); // 70 * 0.2
    expect(r.label).toBe("Low"); // moved off zero, but a single trend alone doesn't yet cross Watch
  });

  it("compounds a declining margin trend with a worsening burn trend", () => {
    const trends = [
      { type: "margin", direction: "declining", message: "..." },
      { type: "burn", direction: "worsening", message: "..." },
    ];
    const r = computeRiskScore({ cashFlowPositive: true, burnMonths: 0, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: 27, trends, growthScore: 35 });
    expect(r.breakdown.trendRisk).toBe(100); // 70 + 30, capped
    expect(r.score).toBeCloseTo(20, 1); // 100 * 0.2
    expect(r.label).toBe("Watch"); // now crosses out of Low
  });

  it("excludes a trend already explained as seasonal from trend risk", () => {
    const trends = [{ type: "margin", direction: "declining", message: "...", seasonallyAnnotated: true }];
    const r = computeRiskScore({ cashFlowPositive: true, burnMonths: 0, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: 40, trends, growthScore: 50 });
    expect(r.breakdown.trendRisk).toBe(0);
  });

  it("never discounts risk for a flat or improving trend", () => {
    const trends = [{ type: "margin", direction: "improving", message: "..." }];
    const r = computeRiskScore({ cashFlowPositive: false, burnMonths: 2, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: 10, trends, growthScore: 80 });
    expect(r.breakdown.trendRisk).toBe(0);
  });

  it("gives some credit to a sharply negative growth score when there isn't enough history for a detectTrends signal", () => {
    const r = computeRiskScore({ cashFlowPositive: true, burnMonths: 0, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: 40, trends: [], growthScore: 10 });
    expect(r.breakdown.trendRisk).toBe(20);
  });

  it("preserves the exact worst-case Critical threshold from runway and margin alone, with no trend data", () => {
    // This must keep working exactly as before — runway (0.4) + margin
    // (0.3) alone still reach the 70-point Critical threshold regardless
    // of whether trend data is available.
    const r = computeRiskScore({ cashFlowPositive: false, burnMonths: -0.159, concentration: 0, concentrationReliable: false, ltvcac: 0, margin: -4900 });
    expect(r.score).toBeCloseTo(70, 1);
    expect(r.label).toBe("Critical");
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
    expect(m).toEqual({ mRev: 50000, mExp: 40000, mCash: 100000, mCac: 200, mLtv: 800, mLeads: 0, mClose: 0, mFinOut: 0 });
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

  it("never claims a concentration trend — month-level revenue alone can't support one", () => {
    // The old month-based concentration signal was retired elsewhere in
    // this engine for measuring calendar-month arithmetic, not real
    // client-concentration risk; computeHistoricalTrajectory doesn't
    // fabricate it here either.
    const t = computeHistoricalTrajectory(snapshots);
    expect(t.concentration).toBeUndefined();
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

  it("keeps named Revenue/Expenses columns as two records, so neither is lost", () => {
    // Netting them into one amount saved R10 000 revenue and R6 000 costs as
    // R4 000 revenue at a 100% margin.
    const csv = "Date,Revenue,Expenses\n2026-01-01,10000,6000\n";
    const result = parseTransactions(csv);
    expect(result.mode).toBe("named");
    expect(result.transactions.map(t => t.amount)).toEqual([10000, -6000]);
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

  it("flags South African and other processors and marketplaces", () => {
    ["yoco settlement", "payfast payout", "ikhokha", "ozow", "paystack settlement", "takealot", "square payout", "uber eats", "amazon marketplace"]
      .forEach(n => expect(isAggregatorCounterparty(n), n).toBe(true));
  });

  it("needs a payout word for names that are also ordinary businesses", () => {
    ["bolt studio project", "times square ltd", "square foot properties", "toast catering", "amazon web services"]
      .forEach(n => expect(isAggregatorCounterparty(n), n).toBe(false));
  });
});

describe("isGenericCounterparty", () => {
  it("treats names that only say how money arrived as no name at all", () => {
    ["cash deposit", "eft 4471", "magtape credit", "acb credit", "12345", "fnb app payment", "atm deposit", ""]
      .forEach(n => expect(isGenericCounterparty(n), n).toBe(true));
  });

  it("keeps anything that names someone", () => {
    ["acme corp", "payment j smith", "coastal retail group", "standard plumbing"]
      .forEach(n => expect(isGenericCounterparty(n), n).toBe(false));
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
      { amount: 3000, description: "Direct Sales - Shopify Payout" },
      { amount: 3500, description: "Client Payment - Acme Corp" },
      { amount: 3500, description: "Client Payment - Beta Industries" },
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.shown).toBe(true);
    expect(r.payers.map(p => p.name)).not.toContain("shopify payout");
    expect(r.aggregatorRevenue).toBe(3000);
    expect(r.aggregatorPct).toBeCloseTo(30, 5);
    // Concentration is judged against total revenue, not just the
    // identified-client slice, so a processor's share doesn't inflate
    // the apparent client concentration among the two real clients.
    expect(r.largestPct).toBeCloseTo(35, 5); // 3500/10000
    // Two named clients, but the processor's customers are more: no
    // "fewer than three clients" warning.
    expect(r.distinctPayers).toBe(2);
    expect(r.severity).toBeNull();
  });

  it("does not measure concentration when processors carry most of the revenue", () => {
    const txns = [
      { amount: 7000, description: "Direct Sales - Shopify Payout" },
      { amount: 1500, description: "Client Payment - Acme Corp" },
      { amount: 1500, description: "Client Payment - Beta Industries" },
    ];
    const r = computeRevenueConcentration(txns);
    expect(r.shown).toBe(false);
    expect(r.aggregatorRevenue).toBe(7000);
    expect(r.aggregatorPct).toBeCloseTo(70, 5);
    expect(r.largestPct).toBeNull();
    expect(r.severity).toBeNull();
    expect(r.reason).toContain("70% of revenue arrives through payment processors");
  });

  it("does not read a run of cash deposits as one client", () => {
    const r = computeRevenueConcentration([
      { amount: 2000, description: "Cash deposit" },
      { amount: 2000, description: "Cash deposit" },
      { amount: 2000, description: "Cash deposit" },
      { amount: 4000, description: "Client Payment - Acme Corp" },
    ]);
    expect(r.extractionRate).toBeCloseTo(0.25, 5); // only Acme names anyone
    expect(r.shown).toBe(false);
    expect(r.severity).toBeNull();
  });

  it("says so when no client is named at all", () => {
    const r = computeRevenueConcentration([
      { amount: 100, description: "Yoco settlement" },
      { amount: 100, description: "Yoco settlement" },
      { amount: 100, description: "Yoco settlement" },
      { amount: 1000, description: "Cash deposit" },
    ]);
    expect(r.extractionRate).toBeCloseTo(0.75, 5);
    expect(r.aggregatorPct).toBeCloseTo((300 / 1300) * 100, 5); // under half
    expect(r.shown).toBe(false);
    expect(r.reason).toBe("No client names could be read from your income descriptions.");
  });

  it("treats a payer called constructor as a name, not a built-in property", () => {
    const r = computeRevenueConcentration([
      { amount: 5000, description: "Client Payment - Constructor" },
      { amount: 5000, description: "Client Payment - Beta Industries" },
      { amount: 5000, description: "Client Payment - Gamma LLC" },
    ]);
    expect(r.totalRevenue).toBe(15000);
    expect(r.payers.find(p => p.name === "constructor").revenue).toBe(5000);
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

describe("detectRecurringObligations with awkward descriptions", () => {
  it("treats a bill described constructor as a description, not a built-in property", () => {
    const txns = ["01", "02", "03"].map(mm => ({ txn_date: `2026-${mm}-10`, description: "Constructor", amount: -500, category: null }));
    const obs = detectRecurringObligations(txns, { asOf: "2026-03-31" });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ label: "Constructor", cadence: "monthly", typical_amount: 500 });
  });
});

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

describe("twice-a-month obligations (payroll)", () => {
  // 15th and last day of the month. 2026-08-15 and 2026-10-31 are Saturdays,
  // so those runs were paid the Friday before. Each run has its own reference
  // number, as real bank exports do.
  const semimonthly = ["2026-07-15", "2026-07-31", "2026-08-14", "2026-08-31", "2026-09-15", "2026-09-30", "2026-10-15", "2026-10-30"]
    .map((d, i) => ({ txn_date: d, amount: -12500, description: `GUSTO PAY ${480000 + i} PPD ID 9138864001` }));

  it("detects 15th-and-last-day payroll as semimonthly despite changing reference numbers and weekend shifts", () => {
    const [ob] = detectRecurringObligations(semimonthly, { asOf: "2026-11-02" });
    expect(ob.cadence).toBe("semimonthly");
    expect(ob.occurrences).toBe(8);
    expect(ob.typical_amount).toBe(12500);
    expect(ob.last_seen).toBe("2026-10-30");
    expect(ob.next_expected).toBe("2026-11-15"); // the other payday: 2026-10-15 a month on
    expect(ob.normalized_key).toBe("gusto pay ppd id");
    expect(ob.active).toBe(true);
  });

  it("detects 1st-and-15th payroll as semimonthly when a 1st is paid early on the 31st", () => {
    // 2026-08-01 and 2026-08-15 are Saturdays: paid 07-31 and 08-14.
    const txns = ["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-07-31", "2026-08-14", "2026-09-01", "2026-09-15"]
      .map(d => ({ txn_date: d, amount: -8000, description: "Payroll" }));
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-09-20" });
    expect(ob.cadence).toBe("semimonthly");
    expect(ob.next_expected).toBe("2026-10-01");
  });

  it("detects every-other-Friday payroll as biweekly", () => {
    const txns = Array.from({ length: 8 }, (_, i) => ({ txn_date: addDays("2026-07-03", i * 14), amount: -9000, description: `ADP PAYROLL ${7700 + i}` }));
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-10-12" });
    expect(ob.cadence).toBe("biweekly");
    expect(ob.last_seen).toBe("2026-10-09");
    expect(ob.next_expected).toBe("2026-10-23"); // 14 days on
  });

  it("calls three exact 14-day gaps biweekly, the fixed-weekday signature", () => {
    expect(classifyTwiceMonthly(["2026-01-02", "2026-01-16", "2026-01-30"], [14, 14])).toBe("biweekly");
  });

  it("rejects a 12-17 day average built from wildly uneven gaps", () => {
    expect(classifyTwiceMonthly(["2026-01-01", "2026-01-04", "2026-01-31", "2026-02-01"], [3, 27, 1])).toBeNull();
  });

  it("never groups lines made only of generic banking words", () => {
    const txns = ["2026-01-05", "2026-02-05", "2026-03-05"].map((d, i) => ({ txn_date: d, amount: -700, description: `CHECK ${1041 + i}` }));
    expect(detectRecurringObligations(txns, { asOf: "2026-03-10" })).toEqual([]);
  });

  it("keeps the exact key for descriptions that already repeat, so stored obligations are not duplicated", () => {
    const txns = ["2026-01-02", "2026-02-02", "2026-03-02"].map(d => ({ txn_date: d, amount: -12000, description: "Rent - Unit 14 Epping" }));
    expect(detectRecurringObligations(txns, { asOf: "2026-03-10" })[0].normalized_key).toBe("rent  unit 14 epping".replace(/\s+/g, " "));
  });

  it("projects a semimonthly obligation onto both paydays, end of month included", () => {
    const ob = { label: "Payroll", cadence: "semimonthly", typical_amount: 12500, next_expected: "2026-11-15", last_seen: "2026-10-30", active: true };
    // From 2026-11-01, 90 days ends 2027-01-30. 10-30 is not a month end, so
    // that payday steps to the 30th: 11-30, 12-30, 2027-01-30.
    const dates = projectForwardCalendar([ob], "2026-11-01", 90).map(e => e.date);
    expect(dates).toEqual(["2026-11-15", "2026-11-30", "2026-12-15", "2026-12-30", "2027-01-15", "2027-01-30"]);
  });

  it("keeps a last-day-of-month payday on the last day", () => {
    const ob = { label: "Payroll", cadence: "semimonthly", typical_amount: 1, next_expected: "2027-01-15", last_seen: "2026-12-31", active: true };
    const dates = projectForwardCalendar([ob], "2027-01-01", 60).map(e => e.date);
    expect(dates).toEqual(["2027-01-15", "2027-01-31", "2027-02-15", "2027-02-28"]);
  });

  it("counts twice-a-month bills at their true monthly weight in obligation-aware runway", () => {
    const base = { currentCash: 100000, avgRev: 0, avgExp: 50000, fromDate: "2026-01-01", horizonDays: 30 };
    const semi = computeForwardRunway({ ...base, obligations: [{ label: "Payroll", cadence: "semimonthly", typical_amount: 10000, next_expected: "2026-01-15", last_seen: "2025-12-31", active: true }] });
    expect(semi.recurringMonthlyTotal).toBeCloseTo(20000, 5);   // 10,000 x 24 / 12
    const bi = computeForwardRunway({ ...base, obligations: [{ label: "Payroll", cadence: "biweekly", typical_amount: 10000, next_expected: "2026-01-09", active: true }] });
    expect(bi.recurringMonthlyTotal).toBeCloseTo(21666.67, 1); // 10,000 x 26 / 12
  });
});

describe("month-stepped obligations land on their real payday", () => {
  it("keeps rent on the 1st when one month was paid early on the 31st", () => {
    // 2026-08-01 is a Saturday, so August's rent went out on Friday 07-31.
    const txns = ["2026-06-01", "2026-07-01", "2026-07-31", "2026-09-01"].map(d => ({ txn_date: d, amount: -4200, description: "Rent" }));
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-09-05" });
    expect(ob.cadence).toBe("monthly");
    expect(ob.day_of_month).toBe(1);
    expect(ob.next_expected).toBe("2026-10-01"); // 30 days on would have said 10-01 only by luck; see next test
  });

  it("treats an early payment as the following month's, not a new payday", () => {
    const txns = ["2026-06-01", "2026-07-01", "2026-07-31"].map(d => ({ txn_date: d, amount: -4200, description: "Rent" }));
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-08-05" });
    expect(ob.next_expected).toBe("2026-09-01"); // 07-31 paid August's rent; 30 days on gave 08-30
  });

  it("keeps a last-day-of-month bill on the last day", () => {
    const txns = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"].map(d => ({ txn_date: d, amount: -900, description: "Software licence" }));
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-05-02" });
    expect(ob.day_of_month).toBe(31); // 31 means "last day"
    expect(ob.next_expected).toBe("2026-05-31");
    expect(projectForwardCalendar([ob], "2026-05-01", 92).map(e => e.date)).toEqual(["2026-05-31", "2026-06-30", "2026-07-31"]);
  });

  it("steps a quarterly bill to the same day three months on", () => {
    const txns = ["2026-01-15", "2026-04-15", "2026-07-15"].map(d => ({ txn_date: d, amount: -9000, description: "VAT Payment" }));
    const [ob] = detectRecurringObligations(txns, { asOf: "2026-07-20" });
    expect(ob.next_expected).toBe("2026-10-15"); // 91 days on gave 10-14
  });

  it("keeps a 30th-of-the-month payday on the 30th after February", () => {
    const ob = { label: "Loan", cadence: "monthly", typical_amount: 500, next_expected: "2027-01-30", day_of_month: 30, active: true };
    expect(projectForwardCalendar([ob], "2027-01-01", 90).map(e => e.date)).toEqual(["2027-01-30", "2027-02-28", "2027-03-30"]);
  });

  it("does not drift across a year", () => {
    const ob = { label: "Rent", cadence: "monthly", typical_amount: 4200, next_expected: "2027-01-01", day_of_month: 1, active: true };
    const dates = projectForwardCalendar([ob], "2027-01-01", 364).map(e => e.date);
    expect(dates).toHaveLength(12);
    expect(dates.every(d => d.endsWith("-01"))).toBe(true); // 30-day steps ended the year on 12-27
  });
});

describe("projectForwardCalendar", () => {
  const monthly = { label: "Rent", cadence: "monthly", typical_amount: 12000, next_expected: "2026-01-31", active: true };

  it("projects an obligation's occurrences across the horizon, stepped by its cadence", () => {
    // Due on the last day of the month: Jan 31, then Feb 28 and Mar 31, not
    // 30-day steps (Mar 2, Apr 1) that slide off the month end.
    const events = projectForwardCalendar([monthly], "2026-01-01", 90);
    expect(events.map(e => e.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
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
    // the obligation's two dated hits: Jan 31 (day 30) and, for a bill due
    // on the last day of the month, Feb 28 (day 58).
    const obligations = [{ label: "Rent", cadence: "monthly", typical_amount: 1000, next_expected: "2026-01-31", active: true }];
    const result = computeForwardRunway({
      currentCash: 1500, avgRev: 0, avgExp: 1000, obligations, fromDate: "2026-01-01", horizonDays: 90,
    });
    expect(result.crossesZero).toBe(true);
    expect(result.crossDate).toBe("2026-02-28");
    expect(result.daysUntilCross).toBe(58);
    expect(result.monthsUntilCross).toBe(1.9); // 58 / 30, one decimal
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
  it("answers from profit, not a $0 simulation, when no cash balance is entered", () => {
    const covered = checkAffordability({ currentCash: 0, avgRev: 50000, avgExp: 34000, obligations: [], monthlyCost: 9000, fromDate: "2026-01-01" });
    expect(covered.affordable).toBe(true);           // 16,000 monthly profit covers 9,000
    expect(covered.needsCash).toBe(true);
    const over = checkAffordability({ currentCash: 0, avgRev: 50000, avgExp: 34000, obligations: [], monthlyCost: 20000, fromDate: "2026-01-01" });
    expect(over.affordable).toBe(false);
    expect(over.breaksInMonth).toBeUndefined();      // no invented break date
  });

  it("still simulates a real negative balance (an overdraft)", () => {
    const r = checkAffordability({ currentCash: -500, avgRev: 10000, avgExp: 8000, obligations: [], monthlyCost: 100, fromDate: "2026-01-01" });
    expect(r.needsCash).toBeUndefined();
    expect(r.affordable).toBe(false);
  });

  it("confirms affordability holds for 12 months when the math supports it", () => {
    const result = checkAffordability({
      currentCash: 50000, avgRev: 10000, avgExp: 8000, obligations: [], monthlyCost: 1500, fromDate: "2026-01-01",
    });
    expect(result.affordable).toBe(true);
  });

  it("returns the specific month a hypothetical cost would break the runway", () => {
    // No existing obligations or background flow — isolates the synthetic
    // cost's own monthly hits on the 1st (Jan 1, Feb 1, Mar 1) against a
    // $3,000 cushion; the third empties it.
    const result = checkAffordability({
      currentCash: 3000, avgRev: 0, avgExp: 0, obligations: [], monthlyCost: 1000, fromDate: "2026-01-01",
    });
    expect(result.affordable).toBe(false);
    expect(result.breaksInMonth).toBe(2);
    expect(result.breakDate).toBe("2026-03-01");
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
  const healthy = { margin: 25, burnMonths: 8, free: 20000, vel: 12, conv: 15, ltvcac: 4, months: 6, concentration: null };

  it("issues negative_free_cash as critical, above every other signal", () => {
    const d = computeDirective({ ...healthy, free: -500, burnMonths: 1, ltvcac: 1 });
    expect(d.rule).toBe("negative_free_cash");
    expect(d.targetMetric).toBe("free");
    expect(d.severity).toBe("critical");
  });

  it("issues low_runway as critical when runway is under 3 months and profit after reserves is still positive", () => {
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

  it("never tells a founder to hire, however much profit there is", () => {
    const d = computeDirective({ ...healthy, margin: 20, conv: 15, free: 10_000_000 });
    expect(d.rule).not.toBe("hire_ready");
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

// 24 months: every month $50,000 except December, which drops to $35,000
// both years — a real, repeating seasonal pattern, not a decline. Expenses
// track proportionally so margin stays exactly flat throughout.
function buildSeasonalHistory() {
  const rows = [];
  for (let y = 0; y < 2; y++) {
    for (let mo = 0; mo < 12; mo++) {
      const revenue = mo === 11 ? 35000 : 50000;
      rows.push({
        period_month: `${2024 + y}-${String(mo + 1).padStart(2, "0")}-01`,
        month: `m${y}-${mo}`, revenue, expenses: Math.round(revenue * 0.6), cash: 80000,
        cogs: 0, marketing: 0, payroll: 0, rent: 0, software: 0, leads: 0, closures: 0, cac: 0, ltv: 0,
      });
    }
  }
  return rows;
}

describe("detectCurrentMonthSeasonality", () => {
  it("identifies the latest month as seasonal when it matches a detected pattern", () => {
    const rows = buildSeasonalHistory(); // ends on December, year 2
    const result = detectCurrentMonthSeasonality(rows);
    expect(result).toMatchObject({ month: "December", occurrences: 2 });
  });

  it("returns null when the latest month is not one of the flagged months", () => {
    const rows = buildSeasonalHistory().slice(0, -1); // ends on November instead
    expect(detectCurrentMonthSeasonality(rows)).toBeNull();
  });

  it("returns null with fewer than 13 months of history", () => {
    expect(detectCurrentMonthSeasonality(buildSeasonalHistory().slice(0, 12))).toBeNull();
  });

  it("returns null when rows don't carry a real period_month", () => {
    const rows = buildSeasonalHistory().map(r => ({ ...r, period_month: undefined }));
    expect(detectCurrentMonthSeasonality(rows)).toBeNull();
  });
});

describe("computeSeasonallyAdjustedVelocity", () => {
  it("computes true year-over-year growth for the latest month", () => {
    const rows = buildSeasonalHistory(); // Dec year2 (35000) vs Dec year1 (35000)
    expect(computeSeasonallyAdjustedVelocity(rows)).toBeCloseTo(0, 5);
  });

  it("reflects genuine year-over-year improvement, not the month-over-month dip", () => {
    const rows = buildSeasonalHistory();
    rows[rows.length - 1].revenue = 42000; // this December is up 20% on last December
    expect(computeSeasonallyAdjustedVelocity(rows)).toBeCloseTo(20, 5);
  });

  it("returns null when the row 12 positions back isn't actually 12 calendar months earlier", () => {
    const rows = buildSeasonalHistory();
    // Remove a month strictly between the two reference points (index 11 =
    // Dec 2024, index 23 = Dec 2025, the latest) — removing anything
    // outside that window would shift both endpoints together and leave
    // their 12-month distance intact, so it has to be one in between.
    rows.splice(15, 1);
    expect(computeSeasonallyAdjustedVelocity(rows)).toBeNull();
  });

  it("returns null with fewer than 13 months of history", () => {
    expect(computeSeasonallyAdjustedVelocity(buildSeasonalHistory().slice(0, 12))).toBeNull();
  });
});

describe("computeGrowthScore — seasonal override", () => {
  it("uses the seasonal rate instead of the raw trailing month-over-month rate when provided", () => {
    const rows = buildSeasonalHistory(); // raw MoM would be a steep November->December drop
    const withoutOverride = computeGrowthScore(rows, -30);
    const withOverride = computeGrowthScore(rows, -30, 0); // 0% YoY, the correct seasonal reading
    expect(withoutOverride.label).toBe("Declining");
    expect(withOverride.label).toBe("Flat");
    expect(withOverride.seasonallyAdjusted).toBe(true);
    expect(withoutOverride.seasonallyAdjusted).toBe(false);
  });

  it("does not compute trailing MoM consistency when a seasonal rate is applied", () => {
    const rows = buildSeasonalHistory();
    const g = computeGrowthScore(rows, -30, 0);
    expect(g.consistency).toBe(0.5); // neutral, not derived from the seasonal-dip transition
  });

  it("ignores a non-finite override and falls back to the normal calculation", () => {
    const rows = [{ revenue: 10000 }, { revenue: 10500 }, { revenue: 11000 }];
    const normal = computeGrowthScore(rows, 10);
    const withNullOverride = computeGrowthScore(rows, 10, null);
    expect(withNullOverride).toEqual(normal);
  });
});

describe("detectTrends — seasonal annotation", () => {
  it("annotates a margin or burn trend fired for a known seasonal month, without suppressing it", () => {
    const rows = buildSeasonalHistory();
    const pattern = detectCurrentMonthSeasonality(rows);
    const trends = detectTrends(rows, pattern);
    const burnTrend = trends.find(t => t.type === "burn");
    expect(burnTrend).toBeDefined();
    expect(burnTrend.seasonallyAnnotated).toBe(true);
    expect(burnTrend.message).toContain("recurring seasonal pattern for December");
  });

  it("does not annotate an expense-creep trend, since it isn't a consequence of revenue seasonality", () => {
    const rows = buildSeasonalHistory().map((r, i) => ({ ...r, payroll: i === 23 ? r.expenses * 0.9 : r.expenses * 0.3 }));
    const pattern = detectCurrentMonthSeasonality(rows);
    const trends = detectTrends(rows, pattern);
    const creep = trends.find(t => t.type === "expense_creep");
    expect(creep).toBeDefined();
    expect(creep.seasonallyAnnotated).toBeUndefined();
  });

  it("behaves exactly as before when no seasonal pattern is passed", () => {
    const rows = buildSeasonalHistory();
    const trends = detectTrends(rows);
    expect(trends.every(t => !t.seasonallyAnnotated)).toBe(true);
  });
});

describe("computeMetrics — seasonal wiring end-to-end", () => {
  it("does not read a real seasonal December dip as a decline", () => {
    const rows = buildSeasonalHistory();
    const manual0 = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
    const m = computeMetrics(rows, manual0, "safe");
    expect(m.seasonalPattern).toMatchObject({ month: "December" });
    expect(m.growth.seasonallyAdjusted).toBe(true);
    expect(m.growth.label).not.toBe("Declining");
    // The underlying fact (lower dollar burn cushion this month) is still
    // surfaced, just with context, not suppressed.
    const burnTrend = m.trends.find(t => t.type === "burn");
    expect(burnTrend?.seasonallyAnnotated).toBe(true);
  });

  it("still reads a genuine decline as Declining when no seasonal pattern applies", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      period_month: `2026-${String(i + 1).padStart(2, "0")}-01`, month: `m${i}`,
      revenue: 50000 - i * 3000, expenses: 30000, cash: 40000,
      cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0,
    }));
    const manual0 = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
    const m = computeMetrics(rows, manual0, "safe");
    expect(m.seasonalPattern).toBeNull(); // under 13 months — too early to call anything seasonal
    expect(m.growth.seasonallyAdjusted).toBe(false);
    expect(m.growth.label).toBe("Declining");
  });

  it("exposes trajectory, historicalConfidence, and a founder narrative once persisted history exists", () => {
    const rows = buildSeasonalHistory();
    const manual0 = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
    const m = computeMetrics(rows, manual0, "safe");
    expect(m.trajectory).not.toBeNull();
    expect(m.historicalConfidence).toMatchObject({ label: "very high" }); // 24 months
    expect(m.founderNarrative).toContain("40.0%"); // margin held flat throughout
  });

  it("leaves trajectory/historicalConfidence/founderNarrative null for ephemeral CSV rows with no period_month", () => {
    const rows = [{ revenue: 50000, expenses: 30000, month: "Jan 26" }];
    const manual0 = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
    const m = computeMetrics(rows, manual0, "safe");
    expect(m.trajectory).toBeNull();
    expect(m.historicalConfidence).toBeNull();
    expect(m.founderNarrative).toBeNull();
  });
});

describe("computeMetrics — Risk Score is now trend-aware end-to-end", () => {
  it("elevates a 6-month clear-deterioration trend out of Low risk, even while every level-based signal still looks fine", () => {
    // Same shape as the case that failed validation: revenue flat, expenses
    // climbing steadily. Cash-flow positive throughout (no runway risk) and
    // overall margin still above 15% (no margin-level risk) — Risk Score
    // used to stay at 0 ("Low") for this entire scenario.
    const rows = [
      { revenue: 50000, expenses: 30000, cash: 60000, cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 50000, expenses: 32000, cash: 58000, cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 50000, expenses: 34500, cash: 54000, cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 50000, expenses: 37500, cash: 48000, cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 50000, expenses: 41000, cash: 40000, cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0 },
      { revenue: 50000, expenses: 45000, cash: 30000, cogs:0, marketing:0, payroll:0, rent:0, software:0, leads:0, closures:0, cac:0, ltv:0 },
    ];
    const manual0 = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
    const m = computeMetrics(rows, manual0, "safe");
    expect(m.cashFlowPositive).toBe(true);       // no runway risk
    expect(m.margin).toBeGreaterThan(15);         // no margin-level risk either
    expect(m.trends.some(t => t.type === "margin" && t.direction === "declining")).toBe(true);
    expect(m.trends.some(t => t.type === "burn" && t.direction === "worsening")).toBe(true);
    expect(m.risk.breakdown.trendRisk).toBe(100);
    expect(m.risk.label).not.toBe("Low");
    expect(m.risk.label).toBe("Watch");
  });
});

// ── Excel upload contract ────────────────────────────────────────
// App.jsx reads an .xlsx workbook, takes the first sheet and converts it to
// CSV with XLSX.utils.sheet_to_csv, then hands that text to the parsers. The
// fixture below is verbatim sheet_to_csv output from xlsx 0.20.3, so this
// pins the contract between SheetJS's CSV shape and our parsers without
// importing the library into the test run.
describe("Excel upload contract (sheet_to_csv output)", () => {
  const SHEET_TO_CSV = [
    "Date,Description,Amount",
    "2026-01-05,ACME CORP INVOICE,5000",
    "2026-01-08,AWS HOSTING,-240",
    "2026-02-05,ACME CORP INVOICE,5000",
    "2026-02-08,AWS HOSTING,-240",
  ].join("\n");

  it("aggregates sheet_to_csv output into monthly rows", () => {
    const result = parseAnyCSV(SHEET_TO_CSV);
    expect(result).not.toBeNull();
    expect(result.rows.length).toBe(2);
    expect(result.rows[0].revenue).toBe(5000);
    expect(result.rows[0].expenses).toBe(240);
    expect(result.rows[1].revenue).toBe(5000);
    expect(result.rows[1].expenses).toBe(240);
  });

  it("emits one signed transaction per source row", () => {
    const { transactions, mode } = parseTransactions(SHEET_TO_CSV);
    expect(mode).toBe("bank");
    expect(transactions.length).toBe(4);
    expect(transactions.filter(t => t.amount > 0).length).toBe(2);
    expect(transactions.filter(t => t.amount < 0).length).toBe(2);
    expect(transactions.find(t => t.amount > 0).amount).toBe(5000);
    expect(transactions.find(t => t.amount < 0).amount).toBe(-240);
    // negative rows keep their sign and still categorise
    expect(transactions.find(t => t.amount < 0).category).toBe("software");
  });
});

// ── Checkout price integrity ─────────────────────────────────────
// The one bug class here that costs real money: the page promising one charge
// while PayPal bills another. LIVE_SOFTWARE and LIVE_ADVISORY are the exact
// plan summaries plan-pricing returns from live PayPal on 2026-11-03, after the
// software plan's tax was set to 0%. TAXED_SOFTWARE is that plan as it was
// before, with 15% added on top of US$99, kept to test the tax rule; and
// RETIRED_ADVISORY is the US$3,000 plan with a US$1,950 first month that
// Advisory used before, kept to test the intro rule.
describe("checkoutBlockReason", () => {
  // As in PLANS in App.jsx.
  const software = { usd: 99, interval: "MONTH" };
  const taxed = { usd: 99, interval: "MONTH", tax: { percent: 15 } };
  const advisory = { usd: 1500, interval: "MONTH" };
  const withIntro = { usd: 3000, interval: "MONTH", intro: { usd: 1950, months: 1 } };
  const withoutIntro = { usd: 3000, interval: "MONTH" };
  const LIVE_SOFTWARE = { planKey:"software", planId:"P-8CD25808KD889454JNKS7S7I", name:"Command Ledger", status:"ACTIVE", amount:99, currency:"USD", intervalUnit:"MONTH", intervalCount:1, hasTrial:false, trials:[], setupFee:0, taxPercent:0, taxInclusive:false };
  const TAXED_SOFTWARE = { ...LIVE_SOFTWARE, taxPercent:15 };
  const LIVE_ADVISORY = { planKey:"advisory", planId:"P-2X763934UU660913BNLUSB7Q", name:"Command Advisory", status:"ACTIVE", amount:1500, currency:"USD", intervalUnit:"MONTH", intervalCount:1, hasTrial:false, trials:[], setupFee:0, taxPercent:0, taxInclusive:true };
  const RETIRED_ADVISORY = { planKey:"advisory", planId:"P-7M170334YK027974RNITP7NY", name:"Command Advisory", status:"ACTIVE", amount:3000, currency:"USD", intervalUnit:"MONTH", intervalCount:1, hasTrial:true, trials:[{ amount:1950, currency:"USD", intervalUnit:"MONTH", intervalCount:1, totalCycles:1 }], setupFee:0, taxPercent:0, taxInclusive:true };
  const clean = over => ({ ...LIVE_SOFTWARE, ...over });
  const taxedClean = over => ({ ...TAXED_SOFTWARE, ...over });

  it("opens the live software plan: US$99, no tax, exactly as shown", () => {
    expect(checkoutBlockReason(software, LIVE_SOFTWARE)).toBeNull();
  });

  it("treats a 0% tax, inclusive or not, as no tax", () => {
    expect(checkoutBlockReason(software, clean({ taxInclusive: true }))).toBeNull();
  });

  it("opens the live US$1,500 advisory plan: no trial, no setup fee, no tax", () => {
    expect(checkoutBlockReason(advisory, LIVE_ADVISORY)).toBeNull();
  });

  it("keeps the retired US$3,000 price closed against the new plan", () => {
    expect(checkoutBlockReason(withoutIntro, LIVE_ADVISORY)).toBe("price_mismatch");
  });

  // ── Tax ──
  it("opens a plan whose page discloses the tax PayPal adds on top", () => {
    expect(checkoutBlockReason(taxed, TAXED_SOFTWARE)).toBeNull();
  });

  it("blocks a page that hides tax PayPal adds on top", () => {
    expect(checkoutBlockReason(software, TAXED_SOFTWARE)).toBe("tax_mismatch");
  });

  it("blocks a disclosed tax at a different rate, or one PayPal no longer adds", () => {
    expect(checkoutBlockReason(taxed, taxedClean({ taxPercent: 10 }))).toBe("tax_mismatch");
    expect(checkoutBlockReason(taxed, LIVE_SOFTWARE)).toBe("tax_mismatch");
    expect(checkoutBlockReason(taxed, taxedClean({ taxInclusive: true }))).toBe("tax_mismatch");
  });

  it("treats an inclusive tax as part of the price shown, needing no disclosure", () => {
    expect(checkoutBlockReason(advisory, { ...LIVE_ADVISORY, taxPercent: 15, taxInclusive: true })).toBeNull();
  });

  it("blocks when PayPal's tax could not be read, or was not reported at all", () => {
    expect(checkoutBlockReason(software, clean({ taxPercent: null }))).toBe("price_unverified");
    const { taxPercent: _omit, ...noTaxField } = LIVE_SOFTWARE;
    expect(checkoutBlockReason(software, noTaxField)).toBe("price_unverified");
  });

  // ── Intro month ──
  it("opens a plan whose page discloses PayPal's intro month exactly", () => {
    expect(checkoutBlockReason(withIntro, RETIRED_ADVISORY)).toBeNull();
  });

  it("keeps a plan closed when the page does not disclose PayPal's trial month", () => {
    expect(checkoutBlockReason(withoutIntro, RETIRED_ADVISORY)).toBe("first_charge_differs");
  });

  it("blocks a disclosed intro that PayPal no longer bills, since the page would promise a price nobody is charged", () => {
    expect(checkoutBlockReason(withIntro, { ...RETIRED_ADVISORY, hasTrial:false, trials:[] })).toBe("first_charge_differs");
  });

  it("blocks any intro PayPal bills differently from the one the page states", () => {
    const trial = over => ({ ...RETIRED_ADVISORY, trials:[{ ...RETIRED_ADVISORY.trials[0], ...over }] });
    expect(checkoutBlockReason(withIntro, trial({ amount: 1500 }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(withIntro, trial({ amount: 0 }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(withIntro, trial({ totalCycles: 2 }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(withIntro, trial({ currency: "ZAR" }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(withIntro, trial({ intervalUnit: "YEAR" }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(withIntro, trial({ intervalCount: 3 }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(withIntro, { ...RETIRED_ADVISORY, trials:[RETIRED_ADVISORY.trials[0], RETIRED_ADVISORY.trials[0]] })).toBe("first_charge_differs");
  });

  it("still blocks a setup fee on a plan with a disclosed intro", () => {
    expect(checkoutBlockReason(withIntro, { ...RETIRED_ADVISORY, setupFee: 100 })).toBe("first_charge_differs");
  });

  // ── Everything else ──
  it("blocks when PayPal bills a different recurring price than displayed", () => {
    expect(checkoutBlockReason(software, clean({ amount: 1250 }))).toBe("price_mismatch");
    expect(checkoutBlockReason(software, clean({ amount: 98.99 }))).toBe("price_mismatch");
  });

  it("reports a wrong recurring price ahead of a trial or tax, since it is the larger error", () => {
    expect(checkoutBlockReason(withIntro, { ...RETIRED_ADVISORY, amount: 2475 })).toBe("price_mismatch");
    expect(checkoutBlockReason(taxed, taxedClean({ amount: 120, taxPercent: 10 }))).toBe("price_mismatch");
  });

  it("blocks a setup fee, and a setup fee that could not be read", () => {
    expect(checkoutBlockReason(software, clean({ setupFee: 50 }))).toBe("first_charge_differs");
    expect(checkoutBlockReason(software, clean({ setupFee: null }))).toBe("first_charge_differs");
  });

  it("blocks a trial reported only through the trials array, including a free one", () => {
    expect(checkoutBlockReason(software, clean({ hasTrial:false, trials:[{ amount:0 }] }))).toBe("first_charge_differs");
  });

  it("blocks a plan billed in another currency or on another interval", () => {
    expect(checkoutBlockReason(software, clean({ currency: "ZAR" }))).toBe("currency_mismatch");
    expect(checkoutBlockReason(software, clean({ intervalUnit: "YEAR" }))).toBe("interval_mismatch");
    expect(checkoutBlockReason(software, clean({ intervalCount: 3 }))).toBe("interval_mismatch");
  });

  it("blocks a plan that is not active in PayPal", () => {
    expect(checkoutBlockReason(software, clean({ status: "INACTIVE" }))).toBe("plan_inactive");
  });

  it("blocks when PayPal could not be read, or returned no usable price", () => {
    expect(checkoutBlockReason(software, null)).toBe("not_configured");
    expect(checkoutBlockReason(software, { error: "paypal_lookup_failed" })).toBe("not_configured");
    expect(checkoutBlockReason(software, clean({ amount: null }))).toBe("price_unverified");
  });

  it("blocks an unknown or malformed plan", () => {
    expect(checkoutBlockReason(null, LIVE_SOFTWARE)).toBe("unknown_plan");
    expect(checkoutBlockReason({}, LIVE_SOFTWARE)).toBe("unknown_plan");
  });
});
