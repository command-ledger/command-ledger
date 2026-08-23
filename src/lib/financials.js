// Pure financial calculation and CSV-parsing functions used by the Dashboard.
// Extracted from src/App.jsx so this math can be unit tested independently
// of React rendering — this is the code founders' real decisions run on.

export const fmt  = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(n)||0);
export const pc   = n => `${(Number(n)||0).toFixed(1)}%`;
export const safe = n => { const v=Number(n); return isNaN(v)||!isFinite(v)?0:v; };

const EXPENSE_CATEGORIES = {
  payroll:   ["salary","salaries","payroll","wages","staff","employee","remuner","hr payment","paye"],
  rent:      ["rent","lease","property","office","premises","landlord"],
  marketing: ["facebook","google ads","instagram","advertising","marketing","ads","tiktok","media buy","promotion","campaign"],
  utilities: ["electricity","water","internet","vodacom","mtn","telkom","cell","airtime","wifi"],
  software:  ["subscription","saas","software","app","license","adobe","microsoft","slack","zoom","aws","hosting"],
  banking:   ["bank fee","service fee","transaction fee","monthly fee","admin fee","charge"],
  cogs:      ["supplier","stock","inventory","cost of goods","materials","printing","shipping","courier","delivery"],
  tax:       ["sars","vat","tax","paye","uif","sdl"],
};

export const detectExpenseCategory = (description) => {
  if (!description) return "other";
  const d = description.toLowerCase();
  for (const [cat, keywords] of Object.entries(EXPENSE_CATEGORIES)) {
    if (keywords.some(k => d.includes(k))) return cat;
  }
  return "other";
};

export const detectIncomeFromDescription = (description) => {
  if (!description) return false;
  const d = description.toLowerCase();
  const incomeSignals = ["invoice","payment received","deposit","transfer in","client","customer","sale","revenue","income","receipt","credit"];
  return incomeSignals.some(k => d.includes(k));
};

// ─── SMART PARSER — reads any real bank or accounting export ──
// Handles:
//   - Bank CSVs: Date, Description, Amount (positive=in, negative=out)
//   - Debit/Credit split columns (FNB, Nedbank, Standard Bank formats)
//   - QuickBooks, Xero, Wave exports
//   - Named column exports (Revenue/Expenses/etc)
//   - Tab-separated files
//   - Semicolon-separated files

export const parseAnyCSV = (text) => {
  // ── Detect delimiter ─────────────────────────────────────────
  const firstLine = text.trim().split(/\r?\n/)[0] || "";
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";

  // ── Parse rows ───────────────────────────────────────────────
  const parseRow = (line) => {
    const cols = []; let cur = ""; let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === delimiter && !inQ) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cols.push(cur.trim());
    return cols.map(c => c.replace(/^"|"$/g, "").trim());
  };

  const allRows = text.trim().split(/\r?\n/)
    .map(parseRow)
    .filter(r => r.some(c => c.length > 0));

  if (allRows.length < 2) return null;

  // ── Find header row (may not always be row 0 in bank exports) ─
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, allRows.length); i++) {
    const row = allRows[i];
    const rowStr = row.join(" ").toLowerCase();
    if (rowStr.includes("date") || rowStr.includes("amount") || rowStr.includes("description")
      || rowStr.includes("revenue") || rowStr.includes("debit") || rowStr.includes("credit")) {
      headerRowIdx = i;
      break;
    }
  }

  const headers = allRows[headerRowIdx].map(h => h.toLowerCase().replace(/[_\-\s]+/g, " ").trim());
  const dataRows = allRows.slice(headerRowIdx + 1);

  // ── Find columns by name ──────────────────────────────────────
  const findCol = (patterns) => {
    for (const p of patterns) {
      const idx = headers.findIndex(h => h.includes(p) || p.includes(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const dateCol    = findCol(["date","period","month","transaction date","posting date","value date","trans date"]);
  const descCol    = findCol(["description","narrative","details","reference","memo","particulars","transaction","name","payee"]);
  const amountCol  = findCol(["amount","value","net amount","total"]);
  const debitCol   = findCol(["debit","debit amount","payment","out","withdrawals","charges"]);
  const creditCol  = findCol(["credit","credit amount","deposit","in","receipts","money in"]);
  const balanceCol = findCol(["balance","running balance","closing balance","available"]);
  const revenueCol = findCol(["revenue","income","sales","turnover","gross sales","total income","receipts earned"]);
  const expenseCol = findCol(["expenses","expense","costs","total expenses","expenditure","overheads","total costs"]);

  // ── Parse a number cleanly from any format ────────────────────
  const toNum = (val) => {
    if (val === undefined || val === null || val === "" || val === "-" || val === "—") return 0;
    const cleaned = String(val)
      .replace(/[R$£€\s,]/g, "")      // Remove currency symbols and commas
      .replace(/\(([^)]+)\)/, "-$1"); // (1234) = -1234
    const n = Number(cleaned);
    return isNaN(n) ? 0 : n;
  };

  // ── Parse a date and return YYYY-MM ──────────────────────────
  const toMonthKey = (val) => {
    if (!val) return null;
    const s = String(val).trim();

    // Already a month name or period
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) {
      return s.substring(0, 3).toLowerCase();
    }

    // Try various date formats
    const patterns = [
      /(\d{4})[\/\-](\d{1,2})/,        // 2024-01, 2024/01
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/, // 01/05/2024
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/, // 01/05/24
      /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i, // 5 Jan 2024
    ];

    const monthNames = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

    for (const pat of patterns) {
      const m = s.match(pat);
      if (m) {
        // 2024-01 format
        if (m[0].match(/^\d{4}/)) {
          const yr = m[1]; const mo = m[2].padStart(2,"0");
          return `${yr}-${mo}`;
        }
        // DD/MM/YYYY or similar
        if (m[3] && m[3].length === 4) {
          const yr = m[3]; const mo = m[2].padStart(2,"0");
          return `${yr}-${mo}`;
        }
        if (m[3] && m[3].length === 2) {
          const yr = `20${m[3]}`; const mo = m[2].padStart(2,"0");
          return `${yr}-${mo}`;
        }
        // 5 Jan 2024
        if (isNaN(m[2])) {
          const moIdx = monthNames.indexOf(m[2].toLowerCase());
          if (moIdx !== -1) return `${m[3]}-${String(moIdx+1).padStart(2,"0")}`;
        }
      }
    }

    // Fallback: just use the raw value trimmed
    return s.substring(0, 7);
  };

  // ── Determine parsing mode ───────────────────────────────────
  // Mode A: Named columns (Revenue / Expenses) — structured export
  // Mode B: Amount column (positive = in, negative = out) — bank statement
  // Mode C: Debit + Credit split columns — some bank formats

  const isNamedMode  = revenueCol !== -1 && expenseCol !== -1;
  const isSplitMode  = debitCol !== -1 && creditCol !== -1 && amountCol === -1;
  const isBankMode   = amountCol !== -1 && !isNamedMode;

  // ── Process each row ─────────────────────────────────────────
  const monthBuckets = {}; // { "2024-01": { revenue, expenses, cash, categories } }

  dataRows.forEach((row) => {
    if (row.every(c => c === "")) return; // skip blank rows

    let revenue = 0;
    let expenses = 0;
    let cash = 0;
    const desc = descCol !== -1 ? row[descCol] || "" : "";
    const monthKey = toMonthKey(dateCol !== -1 ? row[dateCol] : null) || "Unknown";
    const category = detectExpenseCategory(desc);

    if (isNamedMode) {
      // Structured export — named columns
      revenue  = Math.abs(toNum(row[revenueCol]));
      expenses = Math.abs(toNum(row[expenseCol]));
      if (balanceCol !== -1) cash = toNum(row[balanceCol]);

    } else if (isSplitMode) {
      // Debit/Credit columns
      const debit  = Math.abs(toNum(row[debitCol]));
      const credit = Math.abs(toNum(row[creditCol]));
      expenses = debit;
      revenue  = credit;
      if (balanceCol !== -1) cash = toNum(row[balanceCol]);

    } else if (isBankMode) {
      // Single amount column — positive = in, negative = out
      const amt = toNum(row[amountCol]);
      if (amt > 0) {
        // Money in — classify as revenue unless description says otherwise
        revenue = amt;
      } else if (amt < 0) {
        // Money out — classify as expense
        expenses = Math.abs(amt);
      }
      if (balanceCol !== -1) cash = toNum(row[balanceCol]);
    }

    // Skip rows with no financial data
    if (revenue === 0 && expenses === 0) return;

    // Bucket by month
    if (!monthBuckets[monthKey]) {
      monthBuckets[monthKey] = {
        revenue: 0, expenses: 0, cash: 0,
        categories: {},
        transactions: 0,
      };
    }
    monthBuckets[monthKey].revenue    += revenue;
    monthBuckets[monthKey].expenses   += expenses;
    monthBuckets[monthKey].cash        = cash || monthBuckets[monthKey].cash;
    monthBuckets[monthKey].transactions++;

    // Track expense categories
    if (expenses > 0 && category !== "other") {
      monthBuckets[monthKey].categories[category] =
        (monthBuckets[monthKey].categories[category] || 0) + expenses;
    }
  });

  // ── Convert buckets to rows ───────────────────────────────────
  const sortedKeys = Object.keys(monthBuckets).sort();
  if (sortedKeys.length === 0) return null;

  const rows = sortedKeys.map((key) => {
    const b = monthBuckets[key];
    // Format month key for display
    const display = key.match(/^\d{4}-(\d{2})$/)
      ? new Date(key + "-01").toLocaleDateString("en-US", { month:"short", year:"2-digit" })
      : key;
    return {
      month:      display,
      revenue:    Math.round(b.revenue),
      expenses:   Math.round(b.expenses),
      cash:       Math.round(b.cash),
      payroll:    Math.round(b.categories.payroll   || 0),
      marketing:  Math.round(b.categories.marketing || 0),
      cogs:       Math.round(b.categories.cogs      || 0),
      rent:       Math.round(b.categories.rent      || 0),
      software:   Math.round(b.categories.software  || 0),
      leads:      0,
      closures:   0,
      cac:        0,
      ltv:        0,
    };
  }).filter(r => r.revenue > 0 || r.expenses > 0);

  if (rows.length === 0) return null;

  const detectedFields = [];
  if (isNamedMode)  detectedFields.push("Revenue", "Expenses");
  if (isBankMode)   detectedFields.push("Transactions", "Income", "Outflows");
  if (isSplitMode)  detectedFields.push("Debits", "Credits");
  if (dateCol !== -1)  detectedFields.push("Dates");
  if (descCol !== -1)  detectedFields.push("Categories");
  if (balanceCol !== -1) detectedFields.push("Balance");

  return { rows, detectedFields, mode: isNamedMode?"named":isSplitMode?"split":"bank" };
};

// Average month-over-month growth rate across up to the last 3 transitions
// between uploaded months, rather than a single period — one anomalous
// month (a one-off deal, a delayed invoice) shouldn't solely determine a
// 90-day forecast. Falls back to the single-period rate when there isn't
// enough history to average (manual entry, or only one uploaded month).
export function trailingGrowthRate(rows, singlePeriodVel) {
  if (!rows || rows.length < 2) return singlePeriodVel;
  const transitions = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].revenue > 0) {
      transitions.push(((rows[i].revenue - rows[i - 1].revenue) / rows[i - 1].revenue) * 100);
    }
  }
  if (transitions.length === 0) return singlePeriodVel;
  const lastFew = transitions.slice(-3);
  return lastFew.reduce((s, v) => s + v, 0) / lastFew.length;
}

// Growth Score (0-100): rewards a sustained, consistent growth rate over a
// noisy single-month spike. 70% of the score is the trailing growth rate
// (same smoothing used for the 90-day projection), rescaled so 0% growth
// sits at the midpoint of the "Flat" band rather than reading as "good";
// 30% is how many of the recent month-over-month changes were positive, so
// three steadily-growing months outscore one great month sandwiched
// between two down months at the same average rate.
export function computeGrowthScore(rows, singlePeriodVel) {
  const rate = Math.max(-50, Math.min(50, trailingGrowthRate(rows, singlePeriodVel)));
  const rateScore = Math.min(100, Math.max(0, 50 + rate * 3));

  let consistency = 0.5; // not enough history to judge — neutral, not penalized
  if (rows && rows.length >= 3) {
    const deltas = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].revenue > 0) deltas.push(rows[i].revenue - rows[i - 1].revenue);
    }
    const lastFew = deltas.slice(-3);
    if (lastFew.length > 0) consistency = lastFew.filter(d => d > 0).length / lastFew.length;
  }

  const score = Math.min(100, Math.max(0, rateScore * 0.7 + consistency * 100 * 0.3));
  const label = score >= 80 ? "Accelerating" : score >= 60 ? "Growing" : score >= 40 ? "Flat" : "Declining";
  return { score, label, rate, consistency };
}

// Risk Score (0-100, higher = riskier): a composite of four already-verified
// signals, each contributing only when there's real data behind it — no
// signal is penalized for being absent (consistent with how Sovereignty
// Score and concentration reliability already treat missing data in this
// engine). Weighted toward runway (0.4) since it's the most survival-
// critical signal, then margin (0.3), then concentration and unit
// economics (0.15 each).
export function computeRiskScore({ cashFlowPositive, burnMonths, concentration, concentrationReliable, ltvcac, margin }) {
  const runwayRisk = cashFlowPositive ? 0
    : burnMonths >= 8 ? 0
    : burnMonths <= 0 ? 100
    : Math.min(100, Math.max(0, ((8 - burnMonths) / 8) * 100));

  const concentrationRisk = concentrationReliable
    ? Math.min(100, Math.max(0, (concentration - 40) / 0.6))
    : 0;

  const unitEconRisk = ltvcac > 0
    ? Math.min(100, Math.max(0, ((3 - ltvcac) / 3) * 100))
    : 0;

  const marginRisk = margin < 0 ? 100
    : Math.min(100, Math.max(0, ((15 - margin) / 15) * 100));

  const score = Math.min(100, Math.max(0,
    runwayRisk * 0.4 + concentrationRisk * 0.15 + unitEconRisk * 0.15 + marginRisk * 0.3
  ));
  const label = score >= 70 ? "Critical" : score >= 45 ? "Elevated" : score >= 20 ? "Watch" : "Low";
  return { score, label, breakdown: { runwayRisk, concentrationRisk, unitEconRisk, marginRisk } };
}

// Trend detection: compares the latest uploaded month against the average
// of the prior months. Requires at least 3 months of real rows — the same
// floor used for concentrationReliable — because a "trend" from one or two
// data points isn't a trend, it's a single data point.
export function detectTrends(rows) {
  if (!rows || rows.length < 3) return [];
  const trends = [];

  const margins = rows.map(r => r.revenue > 0 ? ((r.revenue - r.expenses) / r.revenue) * 100 : null).filter(m => m !== null);
  if (margins.length >= 3) {
    const latest = margins[margins.length - 1];
    const prior = margins.slice(0, -1);
    const avgPrior = prior.reduce((s, v) => s + v, 0) / prior.length;
    const delta = latest - avgPrior;
    if (Math.abs(delta) >= 3) {
      trends.push({
        type: "margin",
        direction: delta > 0 ? "improving" : "declining",
        message: `Margin ${delta > 0 ? "improved" : "fell"} to ${latest.toFixed(1)}% this month, vs a ${avgPrior.toFixed(1)}% average over the prior ${prior.length} month(s).`,
      });
    }
  }

  ["payroll", "marketing", "cogs", "rent", "software"].forEach(cat => {
    const shares = rows.map(r => r.expenses > 0 ? ((r[cat] || 0) / r.expenses) * 100 : null).filter(s => s !== null);
    if (shares.length >= 3) {
      const latest = shares[shares.length - 1];
      const prior = shares.slice(0, -1);
      const avgPrior = prior.reduce((s, v) => s + v, 0) / prior.length;
      const delta = latest - avgPrior;
      if (delta >= 10) {
        trends.push({
          type: "expense_creep",
          category: cat,
          direction: "worsening",
          message: `${cat.charAt(0).toUpperCase()}${cat.slice(1)} grew to ${latest.toFixed(0)}% of expenses this month, up from a ${avgPrior.toFixed(0)}% average.`,
        });
      }
    }
  });

  const burns = rows.map(r => r.expenses - r.revenue);
  if (burns.length >= 3) {
    const latest = burns[burns.length - 1];
    const prior = burns.slice(0, -1);
    const avgPrior = prior.reduce((s, v) => s + v, 0) / prior.length;
    const delta = latest - avgPrior;
    if (Math.abs(delta) >= Math.max(500, Math.abs(avgPrior) * 0.15)) {
      trends.push({
        type: "burn",
        direction: delta < 0 ? "improving" : "worsening",
        message: `Net burn ${delta < 0 ? "improved" : "worsened"} to ${fmt(latest)}/mo this month, vs a ${fmt(avgPrior)}/mo average.`,
      });
    }
  }

  return trends;
}

// ─── FINANCIAL METRICS ENGINE ──────────────────────────────────
// Pure derivation of every ratio/indicator shown on the Dashboard, from
// either parsed CSV rows (monthly buckets) or manually entered numbers.
// `manual` is { mRev, mExp, mCash, mCac, mLtv, mLeads, mClose }.
// `mode` is "safe" or "growth" and controls the tax/safety reserve split.
export function computeMetrics(rows, manual, mode) {
  const { mRev, mExp, mCash, mCac, mLtv, mLeads, mClose } = manual;

  const tr = mode === "safe" ? 0.30 : 0.25;
  const sr = mode === "safe" ? 0.20 : 0.10;

  const latest   = rows ? rows[rows.length - 1] : { revenue:mRev, expenses:mExp };
  const prev     = rows && rows.length > 1 ? rows[rows.length - 2] : latest;
  const totRev   = rows ? rows.reduce((s,d) => s + d.revenue, 0)  : mRev;
  const totExp   = rows ? rows.reduce((s,d) => s + d.expenses, 0) : mExp;
  const totCogs  = rows ? rows.reduce((s,d) => s + (d.cogs||0), 0) : 0;
  const totMkt   = rows ? rows.reduce((s,d) => s + (d.marketing||0), 0) : 0;
  const totL     = rows ? rows.reduce((s,d) => s + (d.leads||0), 0) : mLeads;
  const totC     = rows ? rows.reduce((s,d) => s + (d.closures||0), 0) : mClose;
  const activeCash = rows ? (latest.cash || mCash) : mCash;
  const activeCac  = rows ? (latest.cac  || mCac)  : mCac;
  const activeLtv  = rows ? (latest.ltv  || mLtv)  : mLtv;

  const n = rows?.length || 1;
  const hasData  = rows !== null || mRev > 0;
  const totPro   = totRev - totExp;
  const margin   = totRev > 0 ? (totPro / totRev) * 100 : 0;
  const vel      = prev.revenue > 0 ? ((latest.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const conv     = totL > 0 ? (totC / totL) * 100 : 0;
  const hasConversionData = totL > 0;
  const ltvcac   = activeCac > 0 ? activeLtv / activeCac : 0;
  const cogsRatio = totRev > 0 ? (totCogs / totRev) * 100 : 0;
  const mktRatio  = totRev > 0 ? (totMkt  / totRev) * 100 : 0;
  // When there's no lead/conversion data (true for every CSV/bank-statement
  // upload, since parseAnyCSV always sets leads/closures to 0), conversion's
  // 40% weight can never be filled — scoring margin*0.6 against that would
  // cap every such user at 60/100 regardless of actual performance. Give
  // margin the full weight instead so the score still uses the 0-100 range.
  const sov       = hasConversionData
    ? Math.min(100, Math.max(0, (margin * 0.6) + (Math.min(conv, 100) * 0.4)))
    : Math.min(100, Math.max(0, margin));
  const sovLbl    = sov >= 75 ? "Sovereign" : sov >= 50 ? "Stabilizing" : sov >= 30 ? "Defensive" : "Critical";
  const taxV      = totPro * tr;
  const safV      = totPro * sr;
  const free      = totPro - taxV - safV;
  const avgExp     = totExp / Math.max(n, 1);
  const avgRev     = totRev / Math.max(n, 1);
  // Runway must reflect net burn (expenses less revenue), not gross
  // expenses — dividing cash by gross expenses tells a profitable,
  // cash-flow-positive company it's about to run out of money. When
  // revenue already covers expenses there's no burn to measure against.
  const netBurn        = avgExp - avgRev;
  const cashFlowPositive = hasData && netBurn <= 0;
  const burnMonths = netBurn > 0 ? (activeCash + safV) / netBurn : 0;
  const hireReady  = free > 25000 * 6;
  const maxRev     = rows ? Math.max(...rows.map(d => d.revenue), 1) : latest.revenue;
  const concentration = totRev > 0 ? (maxRev / totRev) * 100 : 0;
  // With only 1-2 months of history, the highest month is mechanically a
  // large share of the total (100% with a single month) regardless of any
  // real business risk — that's arithmetic, not a signal. Don't treat the
  // "high concentration" reading as reliable until there's enough months
  // to actually show a distribution.
  const concentrationReliable = n >= 3;
  // Without a fixed/variable cost split, average monthly expenses is the
  // honest break-even bar: revenue needs to at least cover total costs.
  // The previous avgExp/(margin/100) formula is not a valid break-even
  // model — it can place break-even revenue above a company's current
  // revenue even while that company is already profitable.
  const breakEven  = avgExp;
  // Use a trailing average growth rate for the 90-day compounding forecast
  // instead of raw single-period `vel`, and clamp it — an unclamped single
  // outlier month compounded three times can produce a forecast off by
  // orders of magnitude. ±50%/month is a heuristic guard, not a precise
  // model: no realistic sustained growth rate for an established revenue
  // base exceeds that for three consecutive months.
  const proj90GrowthRate = Math.max(-50, Math.min(50, trailingGrowthRate(rows, vel)));
  const proj90     = latest.revenue * Math.pow(1 + proj90GrowthRate / 100, 3);
  // "low"    — a single manually-typed snapshot, no transaction history.
  // "medium" — real uploaded data, but under 3 months of it.
  // "high"   — real uploaded data with 3+ months of history.
  const dataConfidence = !rows ? "low" : n >= 3 ? "high" : "medium";

  const growth = computeGrowthScore(rows, vel);
  const risk = computeRiskScore({ cashFlowPositive, burnMonths, concentration, concentrationReliable, ltvcac, margin });
  const trends = detectTrends(rows);

  return {
    tr, sr, latest, prev, totRev, totExp, totCogs, totMkt, totL, totC,
    hasConversionData, avgRev, netBurn, cashFlowPositive, dataConfidence,
    activeCash, activeCac, activeLtv, n, totPro, margin, vel, conv, ltvcac,
    cogsRatio, mktRatio, sov, sovLbl, taxV, safV, free, avgExp, burnMonths,
    hireReady, maxRev, concentration, concentrationReliable,
    breakEven, proj90, proj90GrowthRate, hasData,
    growth, risk, trends,
  };
}

// ─── SCENARIO PLANNING ──────────────────────────────────────────
// Builds a hypothetical "what-if" snapshot from the business's current
// latest-month figures plus a founder-supplied adjustment, then hands it to
// the same computeMetrics() used for real data — no separate scenario math
// to get wrong or drift out of sync with the real calculation engine.
// `baseline` is { revenue, expenses, cash, cac, ltv, leads, closures } —
// the current latest month's actuals. `adjustments` is
// { revenuePct, expensePct, expenseDelta, cashDelta }, each optional and
// defaulting to no change.
export function applyScenario(baseline, adjustments = {}) {
  const { revenuePct = 0, expensePct = 0, expenseDelta = 0, cashDelta = 0 } = adjustments;
  const revenue  = Math.max(0, baseline.revenue * (1 + revenuePct / 100));
  const expenses = Math.max(0, baseline.expenses * (1 + expensePct / 100) + expenseDelta);
  const cash     = Math.max(0, (baseline.cash || 0) + cashDelta);

  return {
    mRev: revenue, mExp: expenses, mCash: cash,
    mCac: baseline.cac || 0, mLtv: baseline.ltv || 0,
    mLeads: baseline.leads || 0, mClose: baseline.closures || 0,
  };
}

// Runs a scenario through computeMetrics and returns it alongside the
// baseline (unadjusted) result, so the caller can show a before/after
// comparison without computing the baseline twice.
export function runScenario(baseline, adjustments, mode) {
  const baselineManual = applyScenario(baseline, {});
  const scenarioManual = applyScenario(baseline, adjustments);
  return {
    before: computeMetrics(null, baselineManual, mode),
    after: computeMetrics(null, scenarioManual, mode),
  };
}
