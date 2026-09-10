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

// ─── COUNTERPARTY EXTRACTION ────────────────────────────────────
// Pulls a payer name out of a raw bank description, e.g.
// "Client Payment - Coastal Retail Group" -> "coastal retail group". Only
// meaningful for income (positive-amount) transactions — an expense
// description's "counterparty" (a vendor) isn't in scope here.
const COUNTERPARTY_PREFIXES = /^(client payment|wholesale order|payment from|transfer from|direct sales|invoice|deposit|sales|receipt)\b/i;
const COUNTERPARTY_LEADING_SEPARATORS = /^[\s\-–:/]+/;
// "pty ltd" must be tried before "ltd" alone, or stripping "ltd" first
// would leave a dangling "pty" behind — see the leftmost-match reasoning
// in the function below for why listing it in the alternation is enough.
const COUNTERPARTY_TRAILING_SUFFIXES = /\s+(pty ltd|ltd|inc|llc|cc)\.?$/i;

export function extractCounterparty(description) {
  if (!description) return null;
  let s = String(description).trim();
  s = s.replace(COUNTERPARTY_PREFIXES, "");
  s = s.replace(COUNTERPARTY_LEADING_SEPARATORS, "");
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(COUNTERPARTY_TRAILING_SUFFIXES, "").trim();
  return s.length > 0 ? s : null;
}

// Payment processors aren't clients — "Shopify Payout" might represent
// hundreds of underlying customers bundled into one deposit. Treating it
// as a single concentrated counterparty would be a false alarm in one
// direction; treating its dollars as belonging to no one would silently
// understate total revenue. It's flagged and excluded from concentration
// math instead, with the amount still visible as its own line.
export function isAggregatorCounterparty(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return /\b(shopify|stripe|paypal)\b/.test(n) && /\b(payout|transfer)\b/.test(n);
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

// 1 = identical, 0 = completely different, scaled by the longer string's
// length so "grp" vs "group" (a short edit) scores differently than the
// same edit distance would on a much longer name.
export function nameSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

const COUNTERPARTY_SIMILARITY_THRESHOLD = 0.85;

// Greedily merges near-identical counterparty names (e.g. "Coastal Retail
// Grp" and "Coastal Retail Group") into single entities. Processes names
// highest-revenue-first so the biggest, most-likely-canonical spelling in
// a cluster becomes its label, and merging is deterministic regardless of
// input order.
export function groupCounterparties(entries) {
  const sorted = [...(entries || [])].sort((a, b) => b.revenue - a.revenue);
  const clusters = [];
  for (const entry of sorted) {
    const match = clusters.find(c => nameSimilarity(entry.name, c.name) >= COUNTERPARTY_SIMILARITY_THRESHOLD);
    if (match) {
      match.revenue += entry.revenue;
      match.members.push(entry.name);
    } else {
      clusters.push({ name: entry.name, revenue: entry.revenue, members: [entry.name] });
    }
  }
  return clusters.sort((a, b) => b.revenue - a.revenue);
}

// ─── REVENUE CONCENTRATION ──────────────────────────────────────
// Genuine client concentration — revenue by real paying counterparty, not
// by calendar month. A single highest MONTH is mechanically ~100% of a
// 1-month total regardless of any real risk; this instead answers "what
// share of revenue depends on one client," which is the actual question
// a founder needs answered before one client leaving becomes a crisis.
export function computeRevenueConcentration(transactions) {
  const income = (transactions || []).filter(t => Number(t.amount) > 0);
  const totalRevenue = income.reduce((s, t) => s + Number(t.amount), 0);

  if (income.length === 0 || totalRevenue <= 0) {
    return {
      shown: false, confidenceLevel: "low",
      reason: "no income transactions in this period",
      extractionRate: 0, totalRevenue: 0,
      payers: [], aggregatorRevenue: 0, aggregatorPct: 0,
      largestPct: null, top3Pct: null, hhi: null, distinctPayers: 0, severity: null,
    };
  }

  let extractedCount = 0;
  const raw = {};
  income.forEach(t => {
    const name = extractCounterparty(t.description);
    if (name) {
      extractedCount++;
      raw[name] = (raw[name] || 0) + Number(t.amount);
    }
  });

  const extractionRate = extractedCount / income.length;
  // <60% is the spec's explicit line for "don't trust this" — above that,
  // moderate vs. high mirrors the same volume-based banding used for
  // every other metric's confidence in this engine (see computeConfidence).
  const confidenceLevel = extractionRate < 0.6 ? "low" : extractionRate < 0.85 ? "moderate" : "high";
  const reason = `Payer names could not be reliably extracted from ${Math.round((1 - extractionRate) * 100)}% of income transactions.`;
  const shown = confidenceLevel !== "low";

  const entries = Object.entries(raw).map(([name, revenue]) => ({ name, revenue }));
  const aggregatorEntries = entries.filter(e => isAggregatorCounterparty(e.name));
  const clientEntries = entries.filter(e => !isAggregatorCounterparty(e.name));
  const aggregatorRevenue = aggregatorEntries.reduce((s, e) => s + e.revenue, 0);

  const grouped = shown ? groupCounterparties(clientEntries) : [];
  const payers = grouped.map(c => ({ name: c.name, revenue: c.revenue, pct: (c.revenue / totalRevenue) * 100 }));

  const largestPct = shown ? (payers[0]?.pct || 0) : null;
  const top3Pct = shown ? payers.slice(0, 3).reduce((s, p) => s + p.pct, 0) : null;
  // Herfindahl index: sum of squared revenue shares (as fractions, so the
  // scale is 0-1). Aggregator dollars deliberately don't appear as a share
  // here — they're unattributable to one real client by definition — so
  // client shares can sum to less than 1 when a lot of revenue is opaque.
  const hhi = shown ? payers.reduce((s, p) => s + Math.pow(p.pct / 100, 2), 0) : null;
  const distinctPayers = grouped.length;

  let severity = null;
  if (shown) {
    if (distinctPayers < 3) severity = "warn";
    if (largestPct > 40) severity = "warn";
    if (largestPct > 60) severity = "critical";
  }

  return {
    shown, confidenceLevel, reason,
    extractionRate, totalRevenue,
    payers, aggregatorRevenue, aggregatorPct: (aggregatorRevenue / totalRevenue) * 100,
    largestPct, top3Pct, hhi, distinctPayers, severity,
  };
}

// ─── RECURRING OBLIGATIONS & FORWARD CALENDAR ───────────────────
// Bank history is backward-looking; a founder's real questions ("can I
// afford this hire in March?") are forward-looking. This detects
// obligations that repeat on a predictable schedule (rent, payroll, SARS,
// an annual insurance premium) from raw transaction history, then projects
// them forward into a cash calendar precise enough to answer those
// questions — instead of the blunt average-burn approximation, which has
// no idea rent is due on the 2nd or that a large annual premium is due
// next month.
//
// All date arithmetic here uses the UTC getters/setters (getUTCDate,
// setUTCDate, etc.), never the local-time ones — a "YYYY-MM-DD" string
// parses as UTC midnight in JS, and mixing that with local-time .setDate()
// silently shifts the result by a day in timezones behind UTC.
const CADENCE_DAYS = { weekly: 7, monthly: 30, quarterly: 91, annual: 365 };

export function classifyCadence(avgIntervalDays) {
  if (avgIntervalDays >= 6   && avgIntervalDays <= 8)   return "weekly";
  if (avgIntervalDays >= 28  && avgIntervalDays <= 33)  return "monthly";
  if (avgIntervalDays >= 85  && avgIntervalDays <= 95)  return "quarterly";
  if (avgIntervalDays >= 350 && avgIntervalDays <= 380) return "annual";
  return null;
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function stddev(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map(v => Math.pow(v - m, 2))));
}

function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Confidence for a detected obligation: occurrence count is the primary
// signal, but an annual obligation additionally needs enough total
// transaction history behind it to rule out coincidence outright — this
// guard is explicit and unconditional, not left to the arithmetic of
// "3 annual-spaced hits already implies ~2 years of data."
export function obligationConfidence(occurrences, cadence, amountVariance, dataSpanDays) {
  if (cadence === "annual" && dataSpanDays < 13 * 30) return "low";
  if (occurrences >= 6 && amountVariance === "fixed") return "high";
  if (occurrences >= 4) return "moderate";
  return "low";
}

// Groups negative-amount (expense) transactions by normalized description,
// tests each group of 3+ occurrences for a consistent interval and amount
// pattern, and returns one obligation record per group that qualifies.
// `transactions` is the raw dated list (txn_date, amount, description,
// category) — the same shape loadHistory() already fetches. `options.asOf`
// (default now) is the reference date used to decide whether a pattern
// has gone quiet for too long to still call it active.
export function detectRecurringObligations(transactions, options = {}) {
  const asOf = (options.asOf || new Date().toISOString().slice(0, 10));
  const expenses = (transactions || []).filter(t => Number(t.amount) < 0 && t.txn_date && t.description);
  if (expenses.length === 0) return [];

  const allDates = expenses.map(t => new Date(t.txn_date).getTime());
  const dataSpanDays = allDates.length > 1 ? Math.round((Math.max(...allDates) - Math.min(...allDates)) / 86400000) : 0;

  const groups = {};
  expenses.forEach(t => {
    const key = normalizeDescription(t.description);
    if (!key) return;
    (groups[key] = groups[key] || []).push(t);
  });

  const obligations = [];
  Object.entries(groups).forEach(([key, txns]) => {
    if (txns.length < 3) return;
    const sorted = [...txns].sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)));
    const dates = sorted.map(t => t.txn_date);
    const amounts = sorted.map(t => Math.abs(Number(t.amount)));

    const intervals = [];
    for (let i = 1; i < dates.length; i++) intervals.push(daysBetween(dates[i - 1], dates[i]));
    const avgInterval = mean(intervals);
    const intervalStd = stddev(intervals);
    if (avgInterval <= 0 || intervalStd / avgInterval >= 0.20) return; // spacing isn't consistent enough to call this recurring

    const cadence = classifyCadence(avgInterval);
    if (!cadence) return; // doesn't fit any known cadence band

    const avgAmount = mean(amounts);
    const amountStd = stddev(amounts);
    const cv = avgAmount > 0 ? amountStd / avgAmount : 0;
    const amountVariance = cv < 0.25 ? "fixed" : "variable";
    const typicalAmount = amountVariance === "fixed" ? avgAmount : mean(amounts.slice(-3));

    const lastSeen = dates[dates.length - 1];
    const nextExpected = addDaysUTC(lastSeen, Math.round(avgInterval));

    // A pattern gone quiet for more than 2 full cadence periods is treated
    // as ended, not still-recurring — recomputed fresh every run rather
    // than trusting a stored flag that could drift out of date.
    const daysSinceLastSeen = daysBetween(lastSeen, asOf);
    const active = daysSinceLastSeen <= 2 * CADENCE_DAYS[cadence];

    obligations.push({
      label: sorted[sorted.length - 1].description,
      category: sorted[sorted.length - 1].category || null,
      cadence,
      typical_amount: Math.round(typicalAmount * 100) / 100,
      amount_variance: amountVariance,
      day_of_month: new Date(lastSeen).getUTCDate(),
      last_seen: lastSeen,
      next_expected: nextExpected,
      occurrences: sorted.length,
      confidence: obligationConfidence(sorted.length, cadence, amountVariance, dataSpanDays),
      active,
      normalized_key: key,
    });
  });

  return obligations.sort((a, b) => b.typical_amount - a.typical_amount);
}

// Projects each active obligation forward from `fromDate` across
// `horizonDays`, generating one event per expected occurrence — the
// first at its stored next_expected date, subsequent ones stepped by the
// cadence's nominal day-count (precise enough for a planning calendar,
// not a ledger).
export function projectForwardCalendar(obligations, fromDate, horizonDays = 90) {
  const endDate = addDaysUTC(fromDate, horizonDays);
  const events = [];
  (obligations || []).filter(o => o.active !== false).forEach(o => {
    const step = CADENCE_DAYS[o.cadence] || 30;
    let date = o.next_expected;
    let guard = 0;
    while (date <= endDate && guard < 400) {
      if (date >= fromDate) {
        events.push({ label: o.label, date, amount: Number(o.typical_amount) || 0, cadence: o.cadence, confidence: o.confidence, category: o.category });
      }
      date = addDaysUTC(date, step);
      guard++;
    }
  });
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// Sums projected obligation amounts into calendar weeks starting at
// `fromDate`, for the "Committed Costs" week-by-week view.
export function summarizeCalendarByWeek(events, fromDate, horizonDays = 90) {
  const weeks = [];
  for (let w = 0; w * 7 < horizonDays; w++) {
    const weekStart = addDaysUTC(fromDate, w * 7);
    const weekEnd = addDaysUTC(fromDate, w * 7 + 6);
    const total = (events || [])
      .filter(e => e.date >= weekStart && e.date <= weekEnd)
      .reduce((s, e) => s + e.amount, 0);
    weeks.push({ weekStart, weekEnd, total });
  }
  return weeks;
}

// Converts one obligation's typical amount into its monthly-equivalent
// rate (a weekly $500 obligation costs roughly $2,143/month) — used to
// separate "background" day-to-day burn from the lumpy, dated obligation
// amounts, so a forward simulation never double-counts a known obligation
// once as a smoothed average and again as a discrete calendar event.
function monthlyEquivalent(amount, cadence) {
  const days = CADENCE_DAYS[cadence] || 30;
  return (Number(amount) || 0) * (30 / days);
}

// Obligation-aware runway: simulates cash day by day from `currentCash`,
// applying a smoothed "background" daily flow (average revenue and
// non-recurring expenses, with all known recurring obligations already
// excluded) plus the actual dated obligation amounts as they land — rather
// than a single flat average-burn rate. A lumpy annual premium landing
// soon shows up as an earlier zero-crossing than average burn would ever
// reveal; average burn spreads that same premium evenly across the year
// and never sees the crunch coming.
export function computeForwardRunway({ currentCash, avgRev, avgExp, obligations, fromDate, horizonDays = 365 }) {
  const active = (obligations || []).filter(o => o.active !== false);
  // Only obligations already reflected in avgExp (i.e. real, previously-
  // detected ones) are excluded from the background rate — a hypothetical
  // obligation being tested by checkAffordability() below is, by
  // definition, not yet part of historical avgExp, so it must stay purely
  // additive rather than also being subtracted back out of the background.
  const recurringMonthlyTotal = active
    .filter(o => o.excludeFromBackground !== false)
    .reduce((s, o) => s + monthlyEquivalent(o.typical_amount, o.cadence), 0);
  // Background = everything except the known recurring obligations, which
  // get applied separately as dated events below — subtracting both would
  // double-count them.
  const backgroundMonthlyNet = (Number(avgRev) || 0) - ((Number(avgExp) || 0) - recurringMonthlyTotal);
  const dailyFlow = backgroundMonthlyNet / 30;

  const events = projectForwardCalendar(active, fromDate, horizonDays);
  const byDate = {};
  events.forEach(e => { byDate[e.date] = (byDate[e.date] || 0) + e.amount; });

  let balance = Number(currentCash) || 0;
  // A payment due exactly on fromDate (day 0) is checked before the daily
  // loop starts — otherwise an obligation whose next_expected is "today"
  // would be silently skipped, since the loop below only walks days 1..N.
  if (byDate[fromDate]) balance -= byDate[fromDate];
  if (balance <= 0) {
    return { crossesZero: true, crossDate: fromDate, daysUntilCross: 0, monthsUntilCross: 0, recurringMonthlyTotal, dailyFlow };
  }
  for (let d = 1; d <= horizonDays; d++) {
    const date = addDaysUTC(fromDate, d);
    balance += dailyFlow;
    if (byDate[date]) balance -= byDate[date];
    if (balance <= 0) {
      return {
        crossesZero: true, crossDate: date, daysUntilCross: d,
        monthsUntilCross: Math.round((d / 30) * 10) / 10,
        recurringMonthlyTotal, dailyFlow,
      };
    }
  }
  return { crossesZero: false, crossDate: null, daysUntilCross: null, monthsUntilCross: null, recurringMonthlyTotal, dailyFlow };
}

// "Can I afford a recurring cost of $X/month?" — answered against the
// forward calendar (real obligations on their real dates), not against a
// flat current-cash check. Layers a synthetic monthly obligation onto the
// existing ones and re-runs the same simulation over a 12-month horizon.
export function checkAffordability({ currentCash, avgRev, avgExp, obligations, monthlyCost, fromDate }) {
  const horizonDays = 365;
  const synthetic = {
    label: "Hypothetical new cost", cadence: "monthly",
    typical_amount: Number(monthlyCost) || 0, next_expected: fromDate, active: true,
    excludeFromBackground: false,
  };
  const withNew = computeForwardRunway({ currentCash, avgRev, avgExp, obligations: [...(obligations || []), synthetic], fromDate, horizonDays });

  if (!withNew.crossesZero) {
    return { affordable: true, message: "This holds for the next 12 months against your known obligations." };
  }
  const breaksInMonth = Math.max(1, Math.ceil(withNew.daysUntilCross / 30));
  return {
    affordable: false, breaksInMonth, breakDate: withNew.crossDate,
    message: `This breaks your runway in month ${breaksInMonth} (around ${withNew.crossDate}).`,
  };
}

// Surfaces an obligation whose expected date has passed by more than a
// week with nothing matching it in the transaction history — often the
// first visible signal of a cash problem, since it shows up before the
// bank balance itself looks alarming.
export function detectMissedObligations(obligations, asOf) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  return (obligations || [])
    .filter(o => o.active !== false)
    .map(o => ({ ...o, daysPast: daysBetween(o.next_expected, today) }))
    .filter(o => o.daysPast > 7)
    .map(o => ({ ...o, message: `${o.label} was expected ${o.daysPast} day${o.daysPast === 1 ? "" : "s"} ago and has not appeared.` }));
}

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
      counterparty: amount > 0 ? extractCounterparty(desc) : null,
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
// `seasonalRate` (optional): when the latest month matches a detected
// seasonal pattern (detectCurrentMonthSeasonality, 13+ months of history),
// the caller passes a year-over-year rate here instead of letting this
// function fall back to its own month-over-month trailing average — a
// December that's reliably 30% below November every year is not a
// decline, and comparing it to the same December a year ago is the
// correct comparison, not comparing it to November.
export function computeGrowthScore(rows, singlePeriodVel, seasonalRate = null) {
  const usingSeasonalRate = seasonalRate !== null && Number.isFinite(seasonalRate);
  const rate = usingSeasonalRate
    ? Math.max(-50, Math.min(50, seasonalRate))
    : Math.max(-50, Math.min(50, trailingGrowthRate(rows, singlePeriodVel)));
  const rateScore = Math.min(100, Math.max(0, 50 + rate * 3));

  // Neutral by default. Also left neutral (not computed from raw MoM
  // deltas) when a seasonal rate is in play — the trailing month-over-month
  // consistency check doesn't apply cleanly to a month whose normal
  // comparison point is a year ago, not last month.
  let consistency = 0.5;
  if (!usingSeasonalRate && rows && rows.length >= 3) {
    const deltas = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].revenue > 0) deltas.push(rows[i].revenue - rows[i - 1].revenue);
    }
    const lastFew = deltas.slice(-3);
    if (lastFew.length > 0) consistency = lastFew.filter(d => d > 0).length / lastFew.length;
  }

  const score = Math.min(100, Math.max(0, rateScore * 0.7 + consistency * 100 * 0.3));
  const label = score >= 80 ? "Accelerating" : score >= 60 ? "Growing" : score >= 40 ? "Flat" : "Declining";
  return { score, label, rate, consistency, seasonallyAdjusted: usingSeasonalRate };
}

// Trend risk: the other four signals below are all point-in-time levels —
// a business can look fine by every one of them while actively getting
// worse every month, and stay silent about it until an absolute threshold
// is finally crossed. This reads the same detectTrends()/computeGrowthScore()
// output already shown to the founder as "Trends Detected," so it never
// invents a second opinion about direction. A trend already explained as
// seasonal (seasonallyAnnotated) is excluded — an expected seasonal swing
// isn't deterioration. Only ever adds risk for a declining direction;
// flat or improving trends never earn a discount on the other signals.
function computeTrendRisk(trends, growthScore) {
  let risk = 0;
  const marginTrend = trends?.find(t => t.type === "margin" && !t.seasonallyAnnotated);
  const burnTrend = trends?.find(t => t.type === "burn" && !t.seasonallyAnnotated);
  if (marginTrend?.direction === "declining") risk += 70;
  if (burnTrend?.direction === "worsening") risk += 30;
  // Covers the case detectTrends can't (under 3 months of history) — a
  // sharply negative single-period growth reading still counts for
  // something, just less than a confirmed multi-month trend does.
  if (risk === 0 && typeof growthScore === "number" && growthScore < 30) risk += 20;
  return Math.min(100, risk);
}

// Risk Score (0-100, higher = riskier): a composite of five already-
// verified signals, each contributing only when there's real data behind
// it — no signal is penalized for being absent (consistent with how
// Sovereignty Score and concentration reliability already treat missing
// data in this engine). Weighted toward runway (0.4) since it's the most
// survival-critical signal, then margin (0.3) — together these two alone
// already reach the "Critical" band at their worst, regardless of trend
// data — then trend direction (0.2), then concentration and unit
// economics (0.05 each).
export function computeRiskScore({ cashFlowPositive, burnMonths, concentration, concentrationReliable, ltvcac, margin, trends, growthScore }) {
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

  const trendRisk = computeTrendRisk(trends, growthScore);

  const score = Math.min(100, Math.max(0,
    runwayRisk * 0.4 + concentrationRisk * 0.05 + unitEconRisk * 0.05 + marginRisk * 0.3 + trendRisk * 0.2
  ));
  const label = score >= 70 ? "Critical" : score >= 45 ? "Elevated" : score >= 20 ? "Watch" : "Low";
  return { score, label, breakdown: { runwayRisk, concentrationRisk, unitEconRisk, marginRisk, trendRisk } };
}

// Trend detection: compares the latest uploaded month against the average
// of the prior months. Requires at least 3 months of real rows — the same
// floor used for concentrationReliable — because a "trend" from one or two
// data points isn't a trend, it's a single data point.
// `seasonalPattern` (optional, from detectCurrentMonthSeasonality): when
// the latest month is a known recurring seasonal month, a margin or burn
// trend fired for it is annotated rather than suppressed — the shift is
// real, but it isn't necessarily a new problem, and the founder should
// see both facts. Expense-category creep isn't annotated: it isn't a
// consequence of revenue seasonality the way margin and burn are.
export function detectTrends(rows, seasonalPattern = null) {
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

  if (seasonalPattern) {
    const note = ` This may reflect a recurring seasonal pattern for ${seasonalPattern.month} rather than a new problem — it has moved this way for ${seasonalPattern.occurrences} years running.`;
    return trends.map(t => (t.type === "margin" || t.type === "burn") ? { ...t, message: t.message + note, seasonallyAnnotated: true } : t);
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
// `context.revenueConcentration` (optional) is the result of
// computeRevenueConcentration() run on raw transactions — it's computed
// outside this function because it needs transaction descriptions, which
// monthly-aggregated `rows` never carry.
export function computeMetrics(rows, manual, mode, context = {}) {
  const { lastTxnDate = null, revenueConcentration = null } = context;
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
  // Only persisted, period_month-bearing history (aggregateTransactionsByMonth's
  // output) can be checked for real calendar seasonality — a CSV parsed for
  // this session only carries a display-string month label, not a date.
  const hasPeriodMonth = !!(rows && rows.length > 0 && rows[0].period_month);
  const seasonalPattern = hasPeriodMonth ? detectCurrentMonthSeasonality(rows) : null;
  const seasonalAdjustedVel = seasonalPattern ? computeSeasonallyAdjustedVelocity(rows) : null;
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
  // Real revenue concentration (by paying counterparty, not by calendar
  // month — a single highest MONTH is mechanically ~100% of a 1-month
  // total regardless of any real client-concentration risk, which is why
  // that version of this metric was retired) is computed separately from
  // raw transaction descriptions by computeRevenueConcentration() and
  // passed in via context. Absent or low-confidence extraction never
  // penalizes Risk Score, same as every other missing-data case here.
  const concentration = revenueConcentration?.shown ? revenueConcentration.largestPct : 0;
  const concentrationReliable = !!revenueConcentration?.shown;
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

  const growth = computeGrowthScore(rows, vel, seasonalAdjustedVel);
  const trends = detectTrends(rows, seasonalPattern);
  const risk = computeRiskScore({ cashFlowPositive, burnMonths, concentration, concentrationReliable, ltvcac, margin, trends, growthScore: growth.score });

  // Long-run trajectory, seasonality, and a plain-language narrative —
  // same 13+/2+ month floors as the functions themselves. Every field
  // here is null (not fabricated) until there's real history behind it.
  const trajectory = hasPeriodMonth && rows.length >= 2 ? computeHistoricalTrajectory(rows) : null;
  const historicalConfidence = hasPeriodMonth ? computeHistoricalConfidence(n) : null;
  const founderNarrative = hasPeriodMonth ? buildFounderNarrative(trajectory, margin) : null;

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
    hireReady, concentration, concentrationReliable, revenueConcentration,
    breakEven, proj90, proj90GrowthRate, hasData,
    growth, risk, trends, seasonalPattern, trajectory, historicalConfidence, founderNarrative,
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
// Everything below operates on *persisted* monthly snapshots — in
// practice, aggregateTransactionsByMonth()'s output (`history` in
// Dashboard), which carries a real `period_month` date. A CSV parsed for
// the current session only (parseAnyCSV's rows) has just a display-string
// month label and can't feed this; that date is what makes real
// seasonality detection possible, which a label like "Jan 24" can't do.
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

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

  // No concentration trend here by design: computing it from month-level
  // revenue alone (highest MONTH as % of a period's total) is exactly the
  // metric that was retired elsewhere in this engine for measuring
  // calendar-month arithmetic rather than real client-concentration risk.
  // A genuine concentration trend needs a real history of
  // computeRevenueConcentration() results over time, which requires
  // per-transaction payer data this function is never given — it isn't
  // fabricated here from data that can't support it.
  return {
    monthsOfHistory: snapshots.length,
    margin: { streak: marginStreak, current: margins[margins.length - 1], direction: marginStreak.direction === "up" ? "improving" : marginStreak.direction === "down" ? "declining" : "flat" },
    revenue: { streak: revenueStreak, current: revenues[revenues.length - 1], direction: revenueStreak.direction === "up" ? "growing" : revenueStreak.direction === "down" ? "shrinking" : "flat" },
    cashFlow: { streak: burnStreak, direction: burnStreak.direction === "up" ? "deteriorating" : burnStreak.direction === "down" ? "improving" : "flat" },
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

  return Object.entries(byMonth)
    .filter(([, revs]) => revs.length >= 2)
    .map(([cm, revs]) => {
      const avg = revs.reduce((a, b) => a + b, 0) / revs.length;
      const deltaPct = overallAvg > 0 ? ((avg - overallAvg) / overallAvg) * 100 : 0;
      return { month: MONTH_NAMES[Number(cm)], avgDeltaPct: deltaPct, occurrences: revs.length };
    })
    .filter(m => Math.abs(m.avgDeltaPct) >= 15);
}

// Checks whether the LATEST row in a persisted, period_month-bearing
// series falls on a calendar month with a real, detected seasonal
// pattern — the single question computeMetrics needs answered to decide
// whether to trust a raw month-over-month reading or ask for a
// seasonally-adjusted one instead. Returns null when there isn't enough
// history (same 13-month floor as detectSeasonality) or the latest month
// isn't one of the flagged ones.
export function detectCurrentMonthSeasonality(rows) {
  if (!rows || rows.length < 13) return null;
  const latest = rows[rows.length - 1];
  if (!latest?.period_month) return null;
  const seasonal = detectSeasonality(rows);
  if (!seasonal || seasonal.length === 0) return null;
  const latestMonthName = MONTH_NAMES[new Date(latest.period_month).getUTCMonth()];
  return seasonal.find(s => s.month === latestMonthName) || null;
}

// Year-over-year growth rate for the latest month, used in place of a
// month-over-month comparison when the latest month is a known seasonal
// one. Requires the row exactly 12 positions back to genuinely be the
// same calendar month a year earlier — a gap in the monthly series (a
// month with zero transactions simply doesn't produce a row) would make
// "12 rows back" the wrong comparison, so this verifies the actual
// calendar distance rather than assuming an unbroken series.
export function computeSeasonallyAdjustedVelocity(rows) {
  if (!rows || rows.length < 13) return null;
  const latest = rows[rows.length - 1];
  const prior = rows[rows.length - 13];
  if (!latest?.period_month || !prior?.period_month) return null;
  const latestDate = new Date(latest.period_month);
  const priorDate = new Date(prior.period_month);
  const monthDiff = (latestDate.getUTCFullYear() - priorDate.getUTCFullYear()) * 12
    + (latestDate.getUTCMonth() - priorDate.getUTCMonth());
  if (monthDiff !== 12) return null;
  if (!(prior.revenue > 0)) return null;
  return ((latest.revenue - prior.revenue) / prior.revenue) * 100;
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

  return parts.join(" ");
}

// ─── DECISION DIRECTIVE & OUTCOME TRACKING ───────────────────────
// A directive nobody follows up on is a tool, not an advisor. This is the
// single decision-selection function — used both to render "This Week's
// Directive" and to decide what gets persisted to the `directives` table —
// so the two can never drift out of sync with each other. Each branch
// carries a stable `rule` id and a `targetMetric` naming which field of
// the metrics object this call is trying to move, so an outcome can be
// measured against the same value later without guessing.
export function computeDirective({ margin, burnMonths, free, vel, conv, hireReady, ltvcac, months, concentration }) {
  const raw = (() => {
    if (safe(free) < 0) return {
      text: "Cut all non-essential spend before end of this week.",
      reason: `Your True Free Cash is ${fmt(free)}. After tax obligations and safety buffer, you owe more than you earn. Every day of inaction erodes your position further.`,
      severity: "critical", rule: "negative_free_cash", targetMetric: "free",
    };
    if (safe(burnMonths) > 0 && safe(burnMonths) < 3) return {
      text: "Protect your runway. You have less than 3 months.",
      reason: `At current burn rate you have ${safe(burnMonths).toFixed(1)} months before the business runs dry. Suspend all non-revenue-generating spend immediately.`,
      severity: "critical", rule: "low_runway", targetMetric: "burnMonths",
    };
    // Only from real, confidently-extracted payer names — never from a
    // low-confidence parse. `concentration.shown` already means
    // "confidence moderate or high," by construction of computeRevenueConcentration.
    if (concentration?.shown && concentration.severity) {
      const isCritical = concentration.severity === "critical";
      const tooFewPayers = concentration.distinctPayers < 3;
      return {
        text: isCritical
          ? "Diversify your revenue before growing it."
          : tooFewPayers
            ? "Land a third paying client before scaling spend."
            : "Reduce reliance on your largest client before it becomes a crisis.",
        reason: tooFewPayers
          ? `You have ${concentration.distinctPayers} distinct paying client${concentration.distinctPayers === 1 ? "" : "s"} this period. Losing any one of them is a material hit to revenue, regardless of how the dollars split.`
          : `${concentration.largestPct.toFixed(0)}% of revenue comes from your single largest client. One client exit or contract loss exposes the business at this concentration — this is not visible until it is catastrophic.`,
        severity: isCritical ? "critical" : "warn", rule: "client_concentration", targetMetric: "concentration",
      };
    }
    if (safe(ltvcac) > 0 && safe(ltvcac) < 3) return {
      text: "Fix unit economics before increasing acquisition spend.",
      reason: `LTV:CAC at ${safe(ltvcac).toFixed(1)}x means every new customer acquired costs more than it sustainably returns. Spending more on acquisition accelerates the loss.`,
      severity: "warn", rule: "poor_unit_economics", targetMetric: "ltvcac",
    };
    if (safe(conv) > 0 && safe(conv) < 10) return {
      text: "Fix the sales funnel before generating more leads.",
      reason: `Converting ${pc(conv)} of leads signals a broken process or a mismatched offer. More leads through a broken funnel wastes budget and time.`,
      severity: "warn", rule: "weak_conversion", targetMetric: "conv",
    };
    if (safe(margin) > 40 && safe(conv) > 20) return {
      text: "Scale lead acquisition now. Your funnel is ready.",
      reason: `Margin at ${pc(margin)} and conversion at ${pc(conv)} are both above threshold. This is a deployment window. Increase lead volume 30% --- the economics support it.`,
      severity: "go", rule: "scale_window", targetMetric: "vel",
    };
    if (hireReady) return {
      text: "You can afford the next hire. Move within 30 days.",
      reason: `True Free Cash supports additional headcount for 6+ months. The opportunity cost of not hiring now exceeds the cost of hiring.`,
      severity: "go", rule: "hire_ready", targetMetric: "free",
    };
    if (safe(vel) < 5 && safe(vel) >= 0) return {
      text: "Revenue growth has stalled. Find the constraint this week.",
      reason: `Velocity at ${pc(vel)}/month signals a blockage --- pipeline, conversion, or retention. Diagnose before spending more on growth.`,
      severity: "warn", rule: "stalled_growth", targetMetric: "vel",
    };
    return {
      text: "Maintain trajectory. Increase lead volume by 20%.",
      reason: `Fundamentals are stable. The highest-ROI move at this position is controlled growth through the same funnel that is already converting.`,
      severity: "stable", rule: "stable_foundation", targetMetric: "vel",
    };
  })();

  const severity = capSeverityForVolume(raw.severity, months);
  const wasCapped = severity !== raw.severity;
  return { ...raw, severity, wasCapped };
}

// Reads a directive's numeric target-metric value out of a metrics/
// concentration pair, by the same names computeDirective() assigns to
// targetMetric — the single place both "record it at issue" and
// "measure it again 60 days later" agree on what a metric named
// "concentration" or "free" actually means.
export function getDirectiveMetricValue(targetMetric, metrics, concentration) {
  if (targetMetric === "concentration") return concentration?.shown ? concentration.largestPct : null;
  const v = metrics?.[targetMetric];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const DIRECTIVE_METRIC_LABELS = {
  free: { label: "True Free Cash", fmt: fmt, higherIsBetter: true },
  burnMonths: { label: "Burn Runway", fmt: (v) => `${v.toFixed(1)} months`, higherIsBetter: true },
  concentration: { label: "Revenue concentration in your largest client", fmt: (v) => `${v.toFixed(1)}%`, higherIsBetter: false },
  ltvcac: { label: "LTV:CAC ratio", fmt: (v) => `${v.toFixed(1)}x`, higherIsBetter: true },
  conv: { label: "Conversion rate", fmt: (v) => `${v.toFixed(1)}%`, higherIsBetter: true },
  vel: { label: "Revenue velocity", fmt: (v) => `${v.toFixed(1)}%/mo`, higherIsBetter: true },
};

// Neutral, fact-only outcome narration — states the metric's movement,
// never a verdict on the founder. "Never shame the founder for ignoring a
// directive. State the fact and the consequence" applies just as much to
// a directive they DID act on: the number either moved or it didn't, and
// that's what gets said, independent of the action they logged.
export function describeDirectiveOutcome(directive) {
  const meta = DIRECTIVE_METRIC_LABELS[directive?.target_metric] || null;
  if (directive?.outcome_metric === null || directive?.outcome_metric === undefined || !meta) {
    const daysSince = directive?.issued_at
      ? Math.floor((Date.now() - new Date(directive.issued_at).getTime()) / 86400000)
      : 0;
    const daysRemaining = Math.max(0, 60 - daysSince);
    return {
      status: "pending",
      message: daysRemaining > 0
        ? `Pending — measured 60 days after issue (${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining).`
        : "Pending — outcome not yet measured.",
    };
  }

  const before = Number(directive.metric_at_issue);
  const after = Number(directive.outcome_metric);
  const improved = meta.higherIsBetter ? after > before : after < before;
  const unchanged = Math.abs(after - before) < 1e-9;
  return {
    status: "measured",
    improved: unchanged ? null : improved,
    message: unchanged
      ? `${meta.label} has not moved — still ${meta.fmt(after)}.`
      : `${meta.label} moved from ${meta.fmt(before)} to ${meta.fmt(after)}.`,
  };
}
