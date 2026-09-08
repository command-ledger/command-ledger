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

// ─── TRANSACTION EVENT PARSER ───────────────────────────────────
// Sibling to parseAnyCSV, but emits one signed record per source row
// instead of pre-aggregating into monthly buckets. This is what feeds the
// transaction event store — the DB is the source of truth, and monthly
// aggregation happens as a read-time derivation (aggregateTransactionsByMonth),
// never as something stored.
export const parseTransactions = (text) => {
  const firstLine = text.trim().split(/\r?\n/)[0] || "";
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";

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

  const allRows = text.trim().split(/\r?\n/).map(parseRow).filter(r => r.some(c => c.length > 0));
  if (allRows.length < 2) return null;

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(5, allRows.length); i++) {
    const rowStr = allRows[i].join(" ").toLowerCase();
    if (rowStr.includes("date") || rowStr.includes("amount") || rowStr.includes("description")
      || rowStr.includes("revenue") || rowStr.includes("debit") || rowStr.includes("credit")) {
      headerRowIdx = i;
      break;
    }
  }
  const headers = allRows[headerRowIdx].map(h => h.toLowerCase().replace(/[_\-\s]+/g, " ").trim());
  const dataRows = allRows.slice(headerRowIdx + 1);

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
  const revenueCol = findCol(["revenue","income","sales","turnover","gross sales","total income","receipts earned"]);
  const expenseCol = findCol(["expenses","expense","costs","total expenses","expenditure","overheads","total costs"]);

  const toNum = (val) => {
    if (val === undefined || val === null || val === "" || val === "-" || val === "—") return 0;
    const cleaned = String(val).replace(/[R$£€\s,]/g, "").replace(/\(([^)]+)\)/, "-$1");
    const n = Number(cleaned);
    return isNaN(n) ? 0 : n;
  };

  // Full date (YYYY-MM-DD), unlike parseAnyCSV's month-only key — a real
  // event store needs the actual day, both for display and because it's
  // part of the dedupe hash. Day-before-month for ambiguous DD/MM/YYYY
  // formats, matching the convention parseAnyCSV already uses.
  const toFullDate = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    const monthNames = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

    let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;

    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;

    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
    if (m) return `20${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;

    m = s.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{4})/i);
    if (m) { const mi = monthNames.indexOf(m[2].toLowerCase().slice(0,3)); if (mi !== -1) return `${m[3]}-${String(mi+1).padStart(2,"0")}-${m[1].padStart(2,"0")}`; }

    m = s.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2}),?\s+(\d{4})/i);
    if (m) { const mi = monthNames.indexOf(m[1].toLowerCase().slice(0,3)); if (mi !== -1) return `${m[3]}-${String(mi+1).padStart(2,"0")}-${m[2].padStart(2,"0")}`; }

    return null; // couldn't parse a real date — the caller skips this row rather than guessing one
  };

  const isNamedMode = revenueCol !== -1 && expenseCol !== -1;
  const isSplitMode = debitCol !== -1 && creditCol !== -1 && amountCol === -1;
  const isBankMode  = amountCol !== -1 && !isNamedMode;

  const transactions = [];
  dataRows.forEach(row => {
    if (row.every(c => c === "")) return;
    const desc = descCol !== -1 ? (row[descCol] || "Transaction") : "Transaction";
    const txnDate = toFullDate(dateCol !== -1 ? row[dateCol] : null);
    if (!txnDate) return; // no reliable date — can't place this in the timeline honestly

    let amount = 0;
    if (isNamedMode) {
      amount = Math.abs(toNum(row[revenueCol])) - Math.abs(toNum(row[expenseCol]));
    } else if (isSplitMode) {
      amount = Math.abs(toNum(row[creditCol])) - Math.abs(toNum(row[debitCol]));
    } else if (isBankMode) {
      amount = toNum(row[amountCol]);
    }
    if (amount === 0) return;

    transactions.push({
      txn_date: txnDate,
      description: desc,
      amount: Math.round(amount * 100) / 100,
      category: amount < 0 ? detectExpenseCategory(desc) : null,
    });
  });

  if (transactions.length === 0) return null;
  return { transactions, mode: isNamedMode ? "named" : isSplitMode ? "split" : "bank" };
};

// ─── DEDUPLICATION ──────────────────────────────────────────────
// Overlapping uploads (Jan-Jun, then later Apr-Sep) must not double-count
// April-June. Two transactions are the same event if they share a date, a
// normalized description, and an amount — normalizing first so "Payment -
// Acme Corp." and "payment  acme corp" hash identically.
export function normalizeDescription(desc) {
  return String(desc || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeHashInput(txn) {
  return `${txn.txn_date}|${normalizeDescription(txn.description)}|${Number(txn.amount).toFixed(2)}`;
}

export async function computeDedupeHash(txn) {
  const input = dedupeHashInput(txn);
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── READ-TIME AGGREGATION ──────────────────────────────────────
// Converts a flat list of stored transactions into the same monthly-row
// shape computeMetrics() already expects — the aggregation is computed on
// every read, never stored. `cash` is intentionally always 0 here: a
// running balance isn't part of the transaction event schema, so current
// cash still comes from the founder's own input, same as before.
export function aggregateTransactionsByMonth(transactions) {
  const buckets = {};
  (transactions || []).forEach(t => {
    const key = String(t.txn_date).slice(0, 7);
    if (!buckets[key]) buckets[key] = { revenue:0, expenses:0, payroll:0, marketing:0, cogs:0, rent:0, software:0 };
    const b = buckets[key];
    const amt = Number(t.amount) || 0;
    if (amt > 0) {
      b.revenue += amt;
    } else if (amt < 0) {
      const abs = Math.abs(amt);
      b.expenses += abs;
      if (t.category && Object.prototype.hasOwnProperty.call(b, t.category)) b[t.category] += abs;
    }
  });

  return Object.keys(buckets).sort().map(key => {
    const b = buckets[key];
    return {
      period_month: `${key}-01`,
      month: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month:"short", year:"2-digit" }),
      revenue: Math.round(b.revenue), expenses: Math.round(b.expenses), cash: 0,
      payroll: Math.round(b.payroll), marketing: Math.round(b.marketing), cogs: Math.round(b.cogs),
      rent: Math.round(b.rent), software: Math.round(b.software),
      leads: 0, closures: 0, cac: 0, ltv: 0,
    };
  });
}

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

// ─── PER-METRIC CONFIDENCE ──────────────────────────────────────
// A runway figure from one month of data and one from eighteen months
// must not look equally authoritative. Every derived/forward-looking
// metric (never a purely descriptive one, like a period's total revenue)
// carries its own confidence, judged from three independent inputs:
//   - Volume: how many months of history back the number.
//   - Recency: how stale that history is — a number built on data that
//     stopped arriving over a month and a half ago is stale even if the
//     history behind it was once substantial.
//   - Completeness (the caller's job, not this function's): a metric
//     whose required inputs are simply absent isn't "low confidence" —
//     it isn't calculable, and must be suppressed rather than defaulting
//     to a zero that reads as a real answer.
const CONFIDENCE_RECENCY_DAYS = 45;

export function computeConfidence(months, lastTxnDate) {
  const n = Math.max(0, months || 0);
  let level = n < 3 ? "low" : n <= 5 ? "moderate" : "high";
  let reason = `based on ${n} month${n === 1 ? "" : "s"} of data`;

  if (lastTxnDate) {
    const ms = Date.now() - new Date(lastTxnDate).getTime();
    const days = Math.floor(ms / 86400000);
    if (Number.isFinite(days) && days > CONFIDENCE_RECENCY_DAYS) {
      const order = ["low", "moderate", "high"];
      const idx = order.indexOf(level);
      if (idx > 0) level = order[idx - 1];
      reason += `, but ${days} days since your last upload`;
    }
  }

  return { level, reason };
}

// Wraps computeConfidence with a completeness gate. `available` is
// whether this specific metric's required inputs are present at all —
// when they aren't, the metric is unavailable (`shown: false`), a
// different failure mode from a thin-but-real history.
function metricConfidence(available, missingReason, months, lastTxnDate) {
  if (!available) return { shown: false, level: null, reason: missingReason };
  const { level, reason } = computeConfidence(months, lastTxnDate);
  return { shown: true, level, reason };
}

// Directive/severity gating: a single month of data cannot support a
// "critical" call — with that little history, a bad number might be a
// fluke, not a fire. Cap one level down and let the caller explain why.
export function capSeverityForVolume(severity, months) {
  if ((months || 0) <= 1 && severity === "critical") return "warn";
  return severity;
}

// ─── FINANCIAL METRICS ENGINE ──────────────────────────────────
// Pure derivation of every ratio/indicator shown on the Dashboard, from
// either parsed CSV rows (monthly buckets) or manually entered numbers.
// `manual` is { mRev, mExp, mCash, mCac, mLtv, mLeads, mClose }.
// `mode` is "safe" or "growth" and controls the tax/safety reserve split.
// `context.lastTxnDate` (optional) is the most recent transaction date in
// the founder's persisted history, used only for the recency check above.
export function computeMetrics(rows, manual, mode, context = {}) {
  const { lastTxnDate = null } = context;
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

  // Completeness: a field being 0 here is indistinguishable from it never
  // having been entered (manual inputs all default to 0), so — consistent
  // with how this engine already treats missing CAC/lead data elsewhere —
  // "present" means "greater than zero," not "not undefined."
  const hasCashData = activeCash > 0;
  const hasUnitEconomicsData = activeCac > 0 && activeLtv > 0;

  const runwayConfidence = metricConfidence(
    cashFlowPositive || hasCashData,
    "no cash balance entered — add it in Connect Data to calculate runway",
    n, lastTxnDate
  );
  const breakEvenConfidence = metricConfidence(hasData, "no revenue/expense data yet", n, lastTxnDate);
  const proj90Confidence    = metricConfidence(hasData, "no revenue/expense data yet", n, lastTxnDate);
  const hireReadyConfidence = metricConfidence(hasData, "no revenue/expense data yet", n, lastTxnDate);
  const ltvcacConfidence    = metricConfidence(hasUnitEconomicsData, "enter both CAC and LTV to calculate", n, lastTxnDate);
  const growthConfidence    = metricConfidence(hasData, "no revenue data yet", n, lastTxnDate);

  return {
    tr, sr, latest, prev, totRev, totExp, totCogs, totMkt, totL, totC,
    hasConversionData, avgRev, netBurn, cashFlowPositive, dataConfidence,
    activeCash, activeCac, activeLtv, n, totPro, margin, vel, conv, ltvcac,
    cogsRatio, mktRatio, sov, sovLbl, taxV, safV, free, avgExp, burnMonths,
    hireReady, maxRev, concentration, concentrationReliable,
    breakEven, proj90, proj90GrowthRate, hasData,
    growth, risk, trends,
    hasCashData, hasUnitEconomicsData,
    runwayConfidence, breakEvenConfidence, proj90Confidence,
    hireReadyConfidence, ltvcacConfidence, growthConfidence,
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

// ─── FINANCIAL MEMORY ENGINE ────────────────────────────────────
// Everything below operates on *persisted* monthly snapshots (see
// supabase/schema/financial_snapshots.sql), not the in-session `rows` from
// a single upload. A snapshot has the same numeric shape as a parsed CSV
// row, plus a real `period_month` date — that date is what makes actual
// seasonality detection possible, which display-only month labels can't do.

// Finds the longest run of consecutive same-direction moves ending at the
// most recent value. length is the number of matching consecutive deltas —
// e.g. length 2 means 3 data points participated in the streak.
function streakDirection(values) {
  if (!values || values.length < 2) return { direction: "flat", length: 0 };
  const lastDelta = values[values.length - 1] - values[values.length - 2];
  const dir = lastDelta > 0 ? "up" : lastDelta < 0 ? "down" : "flat";
  if (dir === "flat") return { direction: "flat", length: 0 };
  let length = 1;
  for (let i = values.length - 2; i > 0; i--) {
    const d = values[i] - values[i - 1];
    const thisDir = d > 0 ? "up" : d < 0 ? "down" : "flat";
    if (thisDir !== dir) break;
    length++;
  }
  return { direction: dir, length };
}

// Long-run trajectory across the full stored history — margin, revenue, and
// net-burn streaks — generalizing detectTrends() (latest-vs-prior-average)
// into "how many consecutive months has this actually been moving."
export function computeHistoricalTrajectory(snapshots) {
  if (!snapshots || snapshots.length < 2) return null;

  const margins  = snapshots.map(s => s.revenue > 0 ? ((s.revenue - s.expenses) / s.revenue) * 100 : null).filter(v => v !== null);
  const revenues = snapshots.map(s => s.revenue);
  const burns    = snapshots.map(s => s.expenses - s.revenue); // higher = worse (more burn)

  const marginStreak  = streakDirection(margins);
  const revenueStreak = streakDirection(revenues);
  const burnStreak    = streakDirection(burns);

  // Concentration trend: compare the average of the most recent third of
  // history against the earliest third, rather than a full streak — with
  // only month-level revenue data (no per-customer records), a coarser
  // "is this getting worse or better over time" read is the honest limit
  // of what this metric can claim.
  const third = Math.max(1, Math.floor(snapshots.length / 3));
  const concOf = arr => {
    const tot = arr.reduce((s, x) => s + x.revenue, 0);
    const max = Math.max(...arr.map(x => x.revenue), 1);
    return tot > 0 ? (max / tot) * 100 : 0;
  };
  const earlyConc = concOf(snapshots.slice(0, third));
  const recentConc = concOf(snapshots.slice(-third));

  return {
    monthsOfHistory: snapshots.length,
    margin: { streak: marginStreak, current: margins[margins.length - 1], direction: marginStreak.direction === "up" ? "improving" : marginStreak.direction === "down" ? "declining" : "flat" },
    revenue: { streak: revenueStreak, current: revenues[revenues.length - 1], direction: revenueStreak.direction === "up" ? "growing" : revenueStreak.direction === "down" ? "shrinking" : "flat" },
    cashFlow: { streak: burnStreak, direction: burnStreak.direction === "up" ? "deteriorating" : burnStreak.direction === "down" ? "improving" : "flat" },
    concentration: { early: earlyConc, recent: recentConc, direction: recentConc - earlyConc >= 5 ? "worsening" : earlyConc - recentConc >= 5 ? "improving" : "flat" },
  };
}

// Requires 13+ months (one full year plus one) because claiming a seasonal
// pattern from a single occurrence of a calendar month isn't a pattern —
// it's a coincidence. Flags a month only when it has 2+ occurrences and
// averages at least 15% away from the overall mean.
export function detectSeasonality(snapshots) {
  if (!snapshots || snapshots.length < 13) return null;

  const byMonth = {};
  snapshots.forEach(s => {
    const cm = new Date(s.period_month).getUTCMonth();
    (byMonth[cm] = byMonth[cm] || []).push(s.revenue);
  });

  // The baseline is built only from calendar months with 2+ occurrences —
  // a month that only appeared once can't be told apart from a genuine
  // one-off, and letting it into the average would let a single outlier
  // month drag every *other*, perfectly ordinary month's comparison off
  // by however far that one-off happened to swing.
  const stableAverages = Object.values(byMonth)
    .filter(revs => revs.length >= 2)
    .map(revs => revs.reduce((a, b) => a + b, 0) / revs.length);
  if (stableAverages.length === 0) return [];
  const overallAvg = stableAverages.reduce((a, b) => a + b, 0) / stableAverages.length;

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  return Object.entries(byMonth)
    .filter(([, revs]) => revs.length >= 2)
    .map(([cm, revs]) => {
      const avg = revs.reduce((a, b) => a + b, 0) / revs.length;
      const deltaPct = overallAvg > 0 ? ((avg - overallAvg) / overallAvg) * 100 : 0;
      return { month: MONTH_NAMES[Number(cm)], avgDeltaPct: deltaPct, occurrences: revs.length };
    })
    .filter(m => Math.abs(m.avgDeltaPct) >= 15);
}

// Confidence scales with months of real history, not with how the current
// month happens to look — a single month should never carry the same
// weight as a year of verified trend data.
export function computeHistoricalConfidence(monthsOfHistory) {
  const n = monthsOfHistory || 0;
  if (n <= 1)  return { score: 40, label: "low",       reason: "based on a single month — no trend context available" };
  if (n <= 5)  return { score: 60, label: "medium",     reason: `based on ${n} months of history — an early trend signal` };
  if (n <= 11) return { score: 80, label: "high",       reason: `based on ${n} months of history — a real trend, not yet a full year` };
  return          { score: 92, label: "very high",  reason: `based on ${n} months of history — enough to account for seasonality` };
}

// Turns the computed trajectory into the kind of sentence a CFO would
// actually say — context, not just a number. Every clause here traces to a
// computed streak above; nothing is invented.
export function buildFounderNarrative(trajectory, currentMargin) {
  if (!trajectory) {
    return `Margin is ${pc(currentMargin)} this period. Connect more months of history for trend context — one data point isn't a trend.`;
  }
  const parts = [];

  if (trajectory.margin.streak.length >= 2) {
    const months = trajectory.margin.streak.length + 1;
    const verb = trajectory.margin.direction === "improving" ? "improved" : trajectory.margin.direction === "declining" ? "declined" : "held steady";
    parts.push(`Margin has ${verb} for ${months} consecutive months, now at ${pc(trajectory.margin.current)}.`);
  } else {
    parts.push(`Margin is ${pc(trajectory.margin.current)} this period.`);
  }

  if (trajectory.revenue.streak.length >= 2) {
    const months = trajectory.revenue.streak.length + 1;
    parts.push(`Revenue has been ${trajectory.revenue.direction} for ${months} consecutive months.`);
  }

  if (trajectory.cashFlow.direction === "deteriorating" && trajectory.cashFlow.streak.length >= 2) {
    parts.push(`Net burn has worsened for ${trajectory.cashFlow.streak.length + 1} straight months — this is a trend, not a one-off.`);
  }

  if (trajectory.concentration.direction === "worsening") {
    parts.push(`Revenue concentration has increased since earlier in your history.`);
  }

  return parts.join(" ");
}
