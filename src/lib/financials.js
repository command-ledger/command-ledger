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
  const totPro   = totRev - totExp;
  const margin   = totRev > 0 ? (totPro / totRev) * 100 : 0;
  const vel      = prev.revenue > 0 ? ((latest.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const conv     = totL > 0 ? (totC / totL) * 100 : 0;
  const ltvcac   = activeCac > 0 ? activeLtv / activeCac : 0;
  const cogsRatio = totRev > 0 ? (totCogs / totRev) * 100 : 0;
  const mktRatio  = totRev > 0 ? (totMkt  / totRev) * 100 : 0;
  const sov       = Math.min(100, Math.max(0, (margin * 0.6) + (Math.min(conv, 100) * 0.4)));
  const sovLbl    = sov >= 75 ? "Sovereign" : sov >= 50 ? "Stabilizing" : sov >= 30 ? "Defensive" : "Critical";
  const taxV      = totPro * tr;
  const safV      = totPro * sr;
  const free      = totPro - taxV - safV;
  const avgExp     = totExp / Math.max(n, 1);
  const burnMonths = avgExp > 0 ? (activeCash + safV) / avgExp : 0;
  const hireReady  = free > 25000 * 6;
  const maxRev     = rows ? Math.max(...rows.map(d => d.revenue), 1) : latest.revenue;
  const concentration = totRev > 0 ? (maxRev / totRev) * 100 : 0;
  const breakEven  = avgExp > 0 && margin > 0 ? avgExp / (margin / 100) : 0;
  const proj90     = latest.revenue * Math.pow(1 + vel / 100, 3);
  const hasData    = rows !== null || mRev > 0;

  return {
    tr, sr, latest, prev, totRev, totExp, totCogs, totMkt, totL, totC,
    activeCash, activeCac, activeLtv, n, totPro, margin, vel, conv, ltvcac,
    cogsRatio, mktRatio, sov, sovLbl, taxV, safV, free, avgExp, burnMonths,
    hireReady, maxRev, concentration, breakEven, proj90, hasData,
  };
}
