// Pure financial calculation and CSV-parsing functions used by the Dashboard.
// Extracted from src/App.jsx so this math can be unit tested independently
// of React rendering — this is the code founders' real decisions run on.

// ─── MONEY ──────────────────────────────────────────────────────
// A business keeps its books in one base currency (ISO 4217), chosen by the
// founder, and every figure is shown in it. Amounts are never converted:
// a transaction in another currency is stored as it arrived and left out of
// the metrics, with a notice, because adding rand to dollars produces a
// number that is wrong in both.
//
// To support a currency: add it here, and widen the database's
// `*_currency_check` constraints first (see the business-currency migration).
// `materialMove` is the smallest month-on-month change in net burn worth
// reporting as a trend, in that currency's own units. It is a materiality
// judgment set by hand per currency, not an exchange rate.
export const SUPPORTED_CURRENCIES = [
  { code: "USD", name: "US dollar",          locale: "en-US", materialMove: 500 },
  { code: "ZAR", name: "South African rand", locale: "en-ZA", materialMove: 10000 },
];
const CURRENCY_BY_CODE = Object.fromEntries(SUPPORTED_CURRENCIES.map(c => [c.code, c]));
export const isSupportedCurrency = code => Object.prototype.hasOwnProperty.call(CURRENCY_BY_CODE, code);

const moneyFormatters = new Map();
function moneyFormatter(currency, compact) {
  const key = `${currency}|${compact ? "c" : ""}`;
  if (!moneyFormatters.has(key)) {
    const base = compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 0 };
    let f;
    if (!currency) {
      // No currency chosen yet: a bare number, never a guessed symbol.
      f = new Intl.NumberFormat("en-US", base);
    } else {
      try {
        f = new Intl.NumberFormat(CURRENCY_BY_CODE[currency]?.locale || "en-US", { style: "currency", currency, ...base });
      } catch {
        // Not an ISO code Intl knows. Show the code beside the number rather
        // than a symbol that could belong to another currency.
        const plain = new Intl.NumberFormat("en-US", base);
        f = { format: v => `${currency} ${plain.format(v)}` };
      }
    }
    moneyFormatters.set(key, f);
  }
  return moneyFormatters.get(key);
}

// `currency` is the ISO code of the amount. It defaults to USD only so that
// older callers and tests keep their meaning; every call in App.jsx passes
// it explicitly (workspace.test.js enforces that). `null` means the founder
// has not chosen a currency yet, and prints the number without a symbol.
export const fmt = (n, currency = "USD") => moneyFormatter(currency, false).format(Number(n) || 0);
export const pc   = n => `${(Number(n)||0).toFixed(1)}%`;
// Large amounts in compact form ("$1.2M", "R 1,2M") where a tile has no room
// for every digit. Below 100,000 units the full figure is short enough and
// more useful, so a small business still sees exact numbers.
export const fmtCompact = (n, currency = "USD") => {
  const v = Number(n) || 0;
  return Math.abs(v) >= 100000 ? moneyFormatter(currency, true).format(v) : fmt(v, currency);
};
// The symbol a currency is written with in its own locale ("$", "R"), for
// labels such as "Monthly revenue (R)". Falls back to the ISO code.
export function currencySymbol(currency) {
  if (!currency) return "";
  try {
    const parts = new Intl.NumberFormat(CURRENCY_BY_CODE[currency]?.locale || "en-US", { style: "currency", currency }).formatToParts(1);
    return parts.find(p => p.type === "currency")?.value || currency;
  } catch { return currency; }
}
export const currencyName = code => CURRENCY_BY_CODE[code]?.name || code || "No currency chosen";

// ─── CASH BALANCE ───────────────────────────────────────────────
// Runway needs the cash in the bank, and it comes from two saved places: a
// balance the founder enters (on the profile, with the date it was true)
// and the closing balance of an uploaded file with a Balance column (on the
// upload). The newest is used; on the same date the founder's own figure
// wins, then the most recent upload. Only a balance in the business
// currency counts, because nothing is ever converted. An overdraft is a
// real balance below zero, not a missing one. A file's balance is one
// account's; the founder's entered figure is how a business with several
// accounts gives the total.
const finiteOrNull = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export function effectiveCashBalance({ profile, batches, baseCurrency }) {
  if (!baseCurrency) return null;
  const found = [];
  const entered = finiteOrNull(profile?.cash_balance);
  if (entered !== null && profile.cash_balance_on && profile.cash_balance_currency === baseCurrency) {
    found.push({ amount: entered, on: String(profile.cash_balance_on).slice(0, 10), source: "entered", filename: null, rank: 1, at: "" });
  }
  (batches || []).forEach(b => {
    const closing = finiteOrNull(b?.closing_balance);
    if (closing !== null && b.closing_balance_on && b.currency === baseCurrency) {
      found.push({ amount: closing, on: String(b.closing_balance_on).slice(0, 10), source: "upload", filename: b.filename || null, rank: 0, at: String(b.uploaded_at || "") });
    }
  });
  if (found.length === 0) return null;
  found.sort((a, b) => b.on.localeCompare(a.on) || b.rank - a.rank || b.at.localeCompare(a.at));
  const { amount, on, source, filename } = found[0];
  return { amount, on, source, filename, currency: baseCurrency };
}

// Splits stored transactions into those in the base currency, which every
// metric is computed from, and those in any other currency, which are kept
// and listed but never added in. A row with no currency is not assumed to
// be in the base currency.
export function partitionByCurrency(transactions, baseCurrency) {
  const included = [];
  const excludedCounts = {};
  (transactions || []).forEach(t => {
    if (baseCurrency && t.currency === baseCurrency) included.push(t);
    else {
      const code = t.currency || "unlabelled";
      excludedCounts[code] = (excludedCounts[code] || 0) + 1;
    }
  });
  const excluded = Object.entries(excludedCounts)
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => b.count - a.count);
  return { included, excluded, excludedTotal: (transactions || []).length - included.length };
}
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

// ─── TRANSACTION KINDS ──────────────────────────────────────────
// Not every line on a bank statement is income or a cost. Money moved
// between the business's own accounts, a loan received or repaid, money the
// owner puts in or takes out, and refunds all move cash without being
// revenue or a cost. Counting them as such overstates both: a loan read as
// revenue turns a loss-making month into the best month on record.
//
// Every transaction has one kind:
//   operating  money from customers and the costs of running the business.
//              The default.
//   transfer   money moved between the business's own accounts. Counted in
//              no figure, because it is still the business's money.
//   financing  loans received or repaid, and money the owner puts in or
//              takes out. Never revenue or a cost, so margin and profit
//              leave it out. Money going out still leaves the bank, so it
//              counts toward burn and runway; money coming in does not
//              reduce burn, because it is a one-off addition to cash.
//   refund     money returned. A refund paid to a customer reduces revenue;
//              one received from a supplier reduces costs.
//
// The kind is worked out every time figures are computed and is never
// stored on the transaction, which is immutable. A rule the founder set
// wins (one transaction, or every transaction described alike); otherwise
// the description decides. The description rules match only unambiguous
// wording, because a wrong guess removes real revenue from every figure:
// a bare "transfer" is not enough ("Transfer from Coastal Retail" is a
// customer paying), and anything not matched stays operating.
export const TRANSACTION_KINDS = ["operating", "transfer", "financing", "refund"];
export const isTransactionKind = kind => TRANSACTION_KINDS.includes(kind);
// Outflows that are commitments: costs, and loan repayments or owner
// withdrawals. A transfer to savings or a refund to a customer is not a bill.
const BILL_KINDS = new Set(["operating", "financing"]);

// Descriptions are matched after normalizeDescription(): lower case, no
// punctuation, single spaces, so "A/c" arrives as "ac" and "Owner's" as
// "owners". Bank names that contain the words below ("First Savings Bank",
// "Sterling Savings and Loan") are taken out first, so a customer paying
// from one is not read as a transfer or a loan.
const BANK_NAME_WORDS = /\bsavings (and loan|loan|bank|association|institution)s?\b/g;
// Loans, and money the owner puts in or takes out. "loan" is singular on
// purpose: "Lakeside Loans" paying an invoice is a customer. Drawings count
// only as the first word or after an owner word, so "Technical Drawings
// Ltd" stays a supplier.
const FINANCING_WORDS = /\b(loan|eidl|bond (repayment|instalment|installment)|merchant cash advance|(paypal|shopify|stripe|square) (working )?capital|capital (injection|contribution)|(owner|owners|shareholder|shareholders|director|directors|partner|partners) (contribution|capital)|(owner|owners|director|directors|member|members|partner|partners|personal) (drawings?|draws?)|dividend|dividends|lulalend|ondeck|kabbage|fundbox)\b|^drawings?\b/;
// Interest and fees are the cost of borrowing, not the borrowing itself,
// so "Loan interest" and "Loan admin fee" stay costs.
const COST_OF_MONEY_WORDS = /\b(interest|fee|fees|charge|charges)\b/;
// Money moved between the business's own accounts. A transfer word alone
// is not enough: it needs a word naming one of the business's own accounts.
const TRANSFER_PHRASES = /\b(own (account|accounts|acc|acct|ac)|internal (transfer|transfers|trf|tfr|xfer|trsf|funds)|inter (account|accounts|acc|acct)|interaccount|between (own |my )?accounts|(auto|automatic|cash|zba) sweep|sweep (transfer|trf|tfr|xfer|to|from))\b/;
const TRANSFER_WORDS = /\b(transfer|transfers|transferred|trf|tfr|xfer|trsf|transf)\b/;
// "sav" and "chk" count only before an account number ("Online Transfer to
// SAV ...1234"), so a company called SAV Logistics is not an account.
const OWN_ACCOUNT_WORDS = /\b(savings|saving|checking|call account|notice account|money market|fixed deposit|investment account|main account|pocket|pockets)\b|\b(sav|chk)(?= \d|$)/;
const REFUND_WORDS = /\b(refund|refunds|refunded|reversal|reversals|reversed|chargeback|chargebacks|charge back|returned (debit|payment|item|cheque|check)|unpaid debit)\b/;

// The kind a description implies on its own. Loans are checked first, so
// "Internal transfer to loan account" is a loan repayment, not a transfer.
export function classifyTransaction(description) {
  const d = normalizeDescription(description).replace(BANK_NAME_WORDS, "bank");
  if (!d) return "operating";
  if (FINANCING_WORDS.test(d) && !COST_OF_MONEY_WORDS.test(d)) return "financing";
  if (TRANSFER_PHRASES.test(d) || (TRANSFER_WORDS.test(d) && OWN_ACCOUNT_WORDS.test(d))) return "transfer";
  if (REFUND_WORDS.test(d)) return "refund";
  return "operating";
}

// A rule for "every transaction like this one" matches the description with
// its digits removed, so "Loan repayment 0123" and "LOAN REPAYMENT #0456"
// share one rule. A description of digits only has no key, so only a rule
// for that single transaction can apply to it.
export function classificationKey(description) {
  return normalizeDescription(description).replace(/\d+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).trim();
}

// The founder's rules as stored in transaction_rules: scope "single" (one
// transaction, matched by its dedupe_hash) or "similar" (every transaction
// whose classificationKey matches). Maps, not objects, so a description
// such as "constructor" can never read a built-in property.
export function buildRuleIndex(rules) {
  const index = { single: new Map(), similar: new Map() };
  (rules || []).forEach(r => {
    if (!r || !isTransactionKind(r.kind) || !r.match_key) return;
    if (r.scope === "single") index.single.set(r.match_key, r.kind);
    else if (r.scope === "similar") index.similar.set(r.match_key, r.kind);
  });
  return index;
}

function asRuleIndex(rules) {
  if (!rules) return null;
  if (Array.isArray(rules)) return buildRuleIndex(rules);
  return rules.single instanceof Map && rules.similar instanceof Map ? rules : null;
}

// A transaction's kind and where it came from: "single" or "similar" (a
// rule the founder set; one transaction beats every-transaction-like-it) or
// "auto" (its description).
export function resolveKind(txn, rules) {
  const index = asRuleIndex(rules);
  if (index) {
    const single = txn?.dedupe_hash ? index.single.get(txn.dedupe_hash) : undefined;
    if (single) return { kind: single, source: "single" };
    const key = classificationKey(txn?.description);
    const similar = key ? index.similar.get(key) : undefined;
    if (similar) return { kind: similar, source: "similar" };
  }
  return { kind: classifyTransaction(txn?.description), source: "auto" };
}

export const transactionKind = (txn, rules) => resolveKind(txn, rules).kind;

// How many transactions of each kind, and the money in and out of each, for
// the upload message and the Transactions page.
export function summarizeKinds(transactions, rules) {
  const index = asRuleIndex(rules);
  const out = {};
  TRANSACTION_KINDS.forEach(k => { out[k] = { count: 0, moneyIn: 0, moneyOut: 0 }; });
  (transactions || []).forEach(t => {
    const amt = Number(t.amount) || 0;
    if (!amt) return;
    const s = out[transactionKind(t, index)];
    s.count++;
    if (amt > 0) s.moneyIn += amt; else s.moneyOut -= amt;
  });
  TRANSACTION_KINDS.forEach(k => {
    out[k].moneyIn = Math.round(out[k].moneyIn * 100) / 100;
    out[k].moneyOut = Math.round(out[k].moneyOut * 100) / 100;
  });
  return out;
}

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
// Names that are only ever a processor or marketplace count on their own.
// Names that are also ordinary words or other businesses (Square, Toast,
// Clover, Bolt, Amazon, Uber, Intuit) count only beside a payout word, so
// "Bolt Studio" and "Times Square Ltd" stay clients.
const PROCESSOR_NAMES = /\b(shopify|stripe|paypal|venmo|braintree|adyen|payoneer|etsy|ebay|woocommerce|squarespace|gumroad|intuit payments|quickbooks payments|payfast|yoco|ikhokha|snapscan|zapper|ozow|paystack|peach payments|payu|netcash|takealot|uber eats|mr d food|doordash|grubhub)\b/;
const PROCESSOR_WORDS = /\b(square|toast|clover|bolt|amazon|amzn|uber|intuit)\b/;
const PAYOUT_WORDS = /\b(payout|payouts|transfer|transfers|settlement|settlements|settle|settled|deposit|deposits|disbursement|remittance|marketplace|seller)\b/;
export function isAggregatorCounterparty(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return PROCESSOR_NAMES.test(n) || (PROCESSOR_WORDS.test(n) && PAYOUT_WORDS.test(n));
}

// A payer "name" that only says how money arrived ("cash deposit", "eft
// 4471", "magtape credit", "fnb app payment") names nobody. Counting it as
// a client made twenty cash deposits look like one client paying 100% of
// revenue, or a run of reference numbers look like many small clients.
// Such lines count as names that could not be read.
const GENERIC_PAYER_WORDS = new Set([
  "ach", "acb", "app", "atm", "auto", "bank", "banking", "bill", "branch", "card", "cash", "ccd", "chk", "check", "cheque",
  "cr", "credit", "dd", "debit", "deposit", "digital", "dr", "eft", "electronic", "fee", "fees", "from", "funds", "ib",
  "id", "immediate", "in", "incoming", "instant", "internet", "inv", "inward", "magtape", "mobile", "money", "no", "nr",
  "of", "online", "pay", "payment", "payshap", "pmt", "pos", "ppd", "purchase", "received", "receipt", "ref", "reference",
  "rtc", "the", "to", "transfer", "trf", "trsf", "transf", "web", "xfer", "tfr", "and", "zelle",
  "fnb", "absa", "nedbank", "nedbk", "capitec", "investec", "tymebank", "sbsa", "std", "chase", "citi", "boa",
]);
export function isGenericCounterparty(name) {
  const words = String(name || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  return words.every(w => w.length < 2 || GENERIC_PAYER_WORDS.has(w));
}
// Above this share of revenue arriving through processors, the clients
// behind it are most of the business and cannot be seen in bank data.
const PROCESSOR_SHARE_LIMIT = 50;

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
export function computeRevenueConcentration(transactions, rules) {
  // Money from customers only: a loan, the owner's own money, a transfer
  // from savings or a refund received is not a client.
  const index = asRuleIndex(rules);
  const income = (transactions || []).filter(t => Number(t.amount) > 0 && transactionKind(t, index) === "operating");
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
  // No prototype, so a payer called "constructor" is just a name.
  const raw = Object.create(null);
  income.forEach(t => {
    const name = extractCounterparty(t.description);
    if (name && !isGenericCounterparty(name)) {
      extractedCount++;
      raw[name] = (raw[name] || 0) + Number(t.amount);
    }
  });

  const extractionRate = extractedCount / income.length;
  // <60% is the spec's explicit line for "don't trust this" — above that,
  // moderate vs. high mirrors the same volume-based banding used for
  // every other metric's confidence in this engine (see computeConfidence).
  const confidenceLevel = extractionRate < 0.6 ? "low" : extractionRate < 0.85 ? "moderate" : "high";

  const entries = Object.entries(raw).map(([name, revenue]) => ({ name, revenue }));
  const aggregatorEntries = entries.filter(e => isAggregatorCounterparty(e.name));
  const clientEntries = entries.filter(e => !isAggregatorCounterparty(e.name));
  const aggregatorRevenue = aggregatorEntries.reduce((s, e) => s + e.revenue, 0);
  const aggregatorPct = (aggregatorRevenue / totalRevenue) * 100;

  // Not shown, with the reason, when payer names can't be trusted, when
  // processors carry most of the revenue (the clients are hidden behind
  // them), or when no client is named at all.
  let shown = confidenceLevel !== "low";
  let reason = shown
    ? `Payer names read from ${Math.round(extractionRate * 100)}% of income transactions.`
    : `Payer names could not be reliably extracted from ${Math.round((1 - extractionRate) * 100)}% of income transactions.`;
  if (shown && aggregatorPct >= PROCESSOR_SHARE_LIMIT) {
    shown = false;
    reason = `${Math.round(aggregatorPct)}% of revenue arrives through payment processors or marketplaces, which pay out many customers in one deposit, so client concentration cannot be measured from bank data.`;
  } else if (shown && clientEntries.length === 0) {
    shown = false;
    reason = "No client names could be read from your income descriptions.";
  }

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
    // Fewer than three named clients means fewer than three clients only
    // when no money arrives through a processor, which hides its customers.
    if (distinctPayers < 3 && aggregatorRevenue === 0) severity = "warn";
    if (largestPct > 40) severity = "warn";
    if (largestPct > 60) severity = "critical";
  }

  return {
    shown, confidenceLevel, reason,
    extractionRate, totalRevenue,
    payers, aggregatorRevenue, aggregatorPct,
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
const CADENCE_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30, quarterly: 91, annual: 365 };
// Occurrences per year: the exact basis for a monthly equivalent. Dividing
// 30 by the day-count instead undercounts every non-monthly cadence (a
// twice-a-month bill would come out at 1.97 times a month, not 2).
const CADENCE_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, annual: 1 };

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

const daysInMonthUTC = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// The same day of the month `months` later, clamped to the target month's
// length; a date on the last day of its month stays on the last day
// (Feb 28 -> Mar 31), because "paid on the last day" is the usual intent.
function addMonthsUTC(dateStr, months) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const isLastDay = day === daysInMonthUTC(y, m);
  const target = new Date(Date.UTC(y, m + months, 1));
  const ty = target.getUTCFullYear(), tm = target.getUTCMonth();
  const tdays = daysInMonthUTC(ty, tm);
  return new Date(Date.UTC(ty, tm, isLastDay ? tdays : Math.min(day, tdays))).toISOString().slice(0, 10);
}

// Monthly, quarterly and annual bills fall due on a day of the month, not
// every N days: rent on the 1st is due on the 1st whether the month has 28
// or 31 days. Stepping 30 days from the last payment drifted a day earlier
// every month (1st, then 31st, 30th, 30th...) and inherited any weekend
// shift of that one payment, so these cadences step whole months on the
// bill's typical payday instead.
const MONTH_STEP = { monthly: 1, quarterly: 3, annual: 12 };
const LAST_DAY = 31; // as a payday: the last day of the month, whatever its length

const paydayToken = dateStr => {
  const d = new Date(dateStr);
  const day = d.getUTCDate();
  return day === daysInMonthUTC(d.getUTCFullYear(), d.getUTCMonth()) ? LAST_DAY : day;
};

// The day a bill is really due: the most common day across its payments,
// so one payment moved for a weekend or holiday does not move the schedule.
// A tie goes to the most recent payment's day.
function typicalPayday(dates) {
  const counts = new Map();
  dates.forEach(d => { const t = paydayToken(d); counts.set(t, (counts.get(t) || 0) + 1); });
  let best = null, bestCount = 0;
  [...dates].reverse().forEach(d => {
    const t = paydayToken(d);
    if (counts.get(t) > bestCount) { best = t; bestCount = counts.get(t); }
  });
  return best;
}

// The payday in a month given as a running index (year * 12 + month),
// clamped to the month's length; LAST_DAY always lands on the last day.
function paydayInMonth(monthIndex, payday) {
  const y = Math.floor(monthIndex / 12), m = monthIndex - y * 12;
  return new Date(Date.UTC(y, m, Math.min(payday, daysInMonthUTC(y, m)))).toISOString().slice(0, 10);
}

// The scheduled payday a payment belongs to: the payday nearest it, in its
// own month or a neighbour, so a 1st paid early on the 31st counts as the
// following month's 1st. Returns that payday's month index.
function scheduledMonthIndex(dateStr, payday) {
  const d = new Date(dateStr);
  const own = d.getUTCFullYear() * 12 + d.getUTCMonth();
  let best = own, bestDist = Infinity;
  for (const idx of [own - 1, own, own + 1]) {
    const dist = Math.abs(daysBetween(paydayInMonth(idx, payday), dateStr));
    if (dist < bestDist) { best = idx; bestDist = dist; }
  }
  return best;
}

// Payroll is usually paid twice a month, either every two weeks (biweekly:
// always 14 days apart, so the day of the month drifts) or on two fixed
// days of each month (semimonthly: the 1st and 15th, or the 15th and the
// last day, with gaps alternating between about 13 and 18 days). Both
// average a 14-15 day gap, which fits none of classifyCadence's bands, so
// both used to go undetected.
//
// They are told apart by whether the day of the month holds still. Each
// date's position in its month is put on a circle with the angle doubled,
// which lands two paydays half a month apart on the same point; the
// result is near 1 when they hold still and falls as biweekly dates drift
// around the month. On a circle, a 1st-of-month payday moved back to the
// 30th for a weekend stays next to its neighbours, which a plain
// day-number comparison would get wrong.
function semimonthlyConsistency(dates) {
  let x = 0, y = 0;
  dates.forEach(dateStr => {
    const d = new Date(dateStr);
    const position = (d.getUTCDate() - 1) / daysInMonthUTC(d.getUTCFullYear(), d.getUTCMonth());
    x += Math.cos(4 * Math.PI * position);
    y += Math.sin(4 * Math.PI * position);
  });
  return Math.hypot(x, y) / dates.length;
}

// Called only for patterns averaging a 12-17 day gap. With 3-4 dates the
// day-of-month signal is too weak to separate the two (four biweekly dates
// only drift about 85 degrees), so exact 14-day gaps, the mark of a fixed
// weekday, decide it for biweekly first.
export function classifyTwiceMonthly(dates, intervals) {
  if (intervals.some(d => d < 8 || d > 22)) return null;
  const nearFortnight = intervals.every(d => d >= 12 && d <= 16);
  if (dates.length < 5 && intervals.every(d => d === 14)) return "biweekly";
  if (semimonthlyConsistency(dates) >= 0.85) return "semimonthly";
  return nearFortnight ? "biweekly" : null;
}

// Grouping key for a second pass over descriptions that did not repeat
// exactly. Payroll and many other bank lines carry a reference number that
// changes every run ("GUSTO PAY 482913 PPD ID 9138864001"), so the exact
// description never recurs. normalizeDescription() is not changed to drop
// digits because it also feeds the duplicate-upload hash; changing it would
// duplicate every stored transaction on the next re-upload. A key made only
// of generic banking words would lump unrelated payments together, so it
// gets no key at all.
const GENERIC_BANK_WORDS = new Set(["ach", "debit", "credit", "pos", "purchase", "payment", "pmt", "check", "chk", "cheque",
  "withdrawal", "transfer", "xfer", "tfr", "card", "online", "web", "dd", "eft", "ref", "id", "ppd", "ccd", "deposit",
  "fee", "fees", "to", "from", "the", "and", "of", "bill", "pay", "recurring", "autopay", "auto"]);
function looseDescriptionKey(desc) {
  const key = normalizeDescription(desc).replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
  const words = key.split(" ").filter(Boolean);
  if (key.length < 3 || words.every(w => GENERIC_BANK_WORDS.has(w) || w.length < 2)) return null;
  return key;
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

// Groups outgoing costs and loan repayments (BILL_KINDS; `options.rules` is
// the founder's rule index) by normalized description,
// tests each group of 3+ occurrences for a consistent interval and amount
// pattern, and returns one obligation record per group that qualifies.
// `transactions` is the raw dated list (txn_date, amount, description,
// category) — the same shape loadHistory() already fetches. `options.asOf`
// (default now) is the reference date used to decide whether a pattern
// has gone quiet for too long to still call it active.
export function detectRecurringObligations(transactions, options = {}) {
  const asOf = (options.asOf || new Date().toISOString().slice(0, 10));
  const rules = asRuleIndex(options.rules);
  const expenses = (transactions || []).filter(t => Number(t.amount) < 0 && t.txn_date && t.description
    && BILL_KINDS.has(transactionKind(t, rules)));
  if (expenses.length === 0) return [];

  const allDates = expenses.map(t => new Date(t.txn_date).getTime());
  const dataSpanDays = allDates.length > 1 ? Math.round((Math.max(...allDates) - Math.min(...allDates)) / 86400000) : 0;

  // No prototype, so a bill described "constructor" is just a key.
  const exactGroups = Object.create(null);
  expenses.forEach(t => {
    const key = normalizeDescription(t.description);
    if (!key) return;
    (exactGroups[key] = exactGroups[key] || []).push(t);
  });

  // Descriptions that repeat exactly keep their exact key, so obligations
  // stored before the second pass existed keep the same normalized_key and
  // are not duplicated. Only the rest are regrouped with digits removed.
  const groups = Object.create(null);
  const looseGroups = Object.create(null);
  Object.entries(exactGroups).forEach(([key, txns]) => {
    if (txns.length >= 3) { groups[key] = txns; return; }
    txns.forEach(t => {
      const loose = looseDescriptionKey(t.description);
      if (loose) (looseGroups[loose] = looseGroups[loose] || []).push(t);
    });
  });
  Object.entries(looseGroups).forEach(([key, txns]) => {
    if (!groups[key]) groups[key] = txns;
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
    if (avgInterval <= 0) return;

    let cadence;
    if (avgInterval >= 12 && avgInterval <= 17) {
      // Twice a month: semimonthly gaps alternate (13, 18, 13 ...) by design,
      // so the day-of-month test replaces the spacing-consistency gate.
      cadence = classifyTwiceMonthly(dates, intervals);
    } else {
      if (intervalStd / avgInterval >= 0.20) return; // spacing isn't consistent enough to call this recurring
      cadence = classifyCadence(avgInterval);
    }
    if (!cadence) return; // doesn't fit any known cadence

    const avgAmount = mean(amounts);
    const amountStd = stddev(amounts);
    const cv = avgAmount > 0 ? amountStd / avgAmount : 0;
    const amountVariance = cv < 0.25 ? "fixed" : "variable";
    const typicalAmount = amountVariance === "fixed" ? avgAmount : mean(amounts.slice(-3));

    const lastSeen = dates[dates.length - 1];
    // A semimonthly payment's next date is the other payday: the one before
    // the last, a month on. Monthly, quarterly and annual bills land on their
    // typical payday one step after the payday the last payment covered.
    // Weekly and biweekly bills step days from the last payment.
    const payday = MONTH_STEP[cadence] ? typicalPayday(dates) : null;
    const nextExpected = cadence === "semimonthly"
      ? addMonthsUTC(dates[dates.length - 2], 1)
      : payday
        ? paydayInMonth(scheduledMonthIndex(lastSeen, payday) + MONTH_STEP[cadence], payday)
        : addDaysUTC(lastSeen, cadence === "biweekly" ? 14 : Math.round(avgInterval));

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
      // The typical payday (31 = last day of the month) for month-stepped
      // cadences; the last payment's day otherwise.
      day_of_month: payday || new Date(lastSeen).getUTCDate(),
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
    const push = date => events.push({ label: o.label, date, amount: Number(o.typical_amount) || 0, cadence: o.cadence, confidence: o.confidence, category: o.category });
    if (o.cadence === "semimonthly") {
      // Two fixed paydays a month: next_expected is one, and the last payday
      // seen is the other. Each is stepped whole months from its own source
      // date (k months from that date, never month by month from the last
      // projection), so a 30th stays the 30th instead of turning into a
      // month end the first time it lands on one, or a 28th after February.
      const paydays = [[o.next_expected, 0], o.last_seen ? [o.last_seen, 1] : [addDaysUTC(o.next_expected, 15), 0]];
      paydays.forEach(([source, firstK]) => {
        for (let k = firstK, date = addMonthsUTC(source, k); date <= endDate && k < 400; date = addMonthsUTC(source, ++k)) {
          if (date >= fromDate) push(date);
        }
      });
      return;
    }
    if (MONTH_STEP[o.cadence]) {
      // Whole months on the bill's payday. day_of_month carries the payday;
      // without it, next_expected's own day stands in.
      const payday = o.day_of_month >= 1 && o.day_of_month <= 31 ? o.day_of_month : paydayToken(o.next_expected);
      const d = new Date(o.next_expected);
      const startIndex = d.getUTCFullYear() * 12 + d.getUTCMonth();
      for (let k = 0, date = o.next_expected; date <= endDate && k < 400; k++, date = paydayInMonth(startIndex + k * MONTH_STEP[o.cadence], payday)) {
        if (date >= fromDate) push(date);
      }
      return;
    }
    const step = CADENCE_DAYS[o.cadence] || 30;
    let date = o.next_expected;
    let guard = 0;
    while (date <= endDate && guard < 400) {
      if (date >= fromDate) push(date);
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
  return (Number(amount) || 0) * (CADENCE_PER_YEAR[cadence] || 12) / 12;
}

// Obligation-aware runway: simulates cash day by day from `currentCash`,
// applying a smoothed "background" daily flow (average revenue and
// non-recurring expenses, with all known recurring obligations already
// excluded) plus the actual dated obligation amounts as they land — rather
// than a single flat average-burn rate. A lumpy annual premium landing
// soon shows up as an earlier zero-crossing than average burn would ever
// reveal; average burn spreads that same premium evenly across the year
// and never sees the crunch coming.
export function computeForwardRunway({ currentCash, avgRev, avgExp, avgFinOut = 0, obligations, fromDate, horizonDays = 365 }) {
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
  // double-count them. Loan repayments and owner withdrawals (avgFinOut)
  // leave the bank like any cost, and a recurring one is among the
  // obligations, so both sides of this subtraction include them.
  const backgroundMonthlyNet = (Number(avgRev) || 0) - ((Number(avgExp) || 0) + (Number(avgFinOut) || 0) - recurringMonthlyTotal);
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
export function checkAffordability({ currentCash, cashKnown = Boolean(Number(currentCash)), avgRev, avgExp, avgFinOut = 0, obligations, monthlyCost, fromDate, currency = "USD" }) {
  // No cash balance on file leaves nothing to simulate from: the run would
  // start at $0 and call every cost unaffordable on day one, even for a
  // profitable business. Answer from monthly profit instead and say what is
  // missing. `cashKnown` says a balance is on file; without it, 0 is how
  // "not entered" arrives. A known balance of zero or an overdraft is data,
  // and runs the full simulation.
  const finOut = Number(avgFinOut) || 0;
  if (!cashKnown) {
    const monthlyProfit = (Number(avgRev) || 0) - (Number(avgExp) || 0) - finOut;
    const covered = monthlyProfit >= (Number(monthlyCost) || 0);
    const basis = finOut > 0 ? "average monthly profit after loan repayments and owner withdrawals" : "average monthly profit";
    return {
      affordable: covered, needsCash: true,
      message: covered
        ? `Your ${basis} (${fmt(monthlyProfit, currency)}) covers this. Add a cash balance to also test it against your bills on their real dates.`
        : `This is more than your ${basis} (${fmt(Math.max(0, monthlyProfit), currency)}) covers, and with no cash balance entered there is nothing to fund the gap. Add a cash balance to see how long it would last.`,
    };
  }
  // Already at or below zero, a new cost has no cash to come from, whatever
  // profit does: a simulation would only say it "breaks" on day one.
  if (Number(currentCash) <= 0) {
    const monthlyProfit = (Number(avgRev) || 0) - (Number(avgExp) || 0) - finOut;
    const basis = finOut > 0 ? "average monthly profit after loan repayments and owner withdrawals" : "average monthly profit";
    return {
      affordable: false, overdrawn: true,
      message: monthlyProfit >= (Number(monthlyCost) || 0)
        ? `Your ${basis} (${fmt(monthlyProfit, currency)}) covers this, but your cash balance is ${fmt(currentCash, currency)}, so until profit rebuilds it this would be paid from an overdraft or borrowing.`
        : `Your cash balance is ${fmt(currentCash, currency)} and your ${basis} (${fmt(Math.max(0, monthlyProfit), currency)}) does not cover this, so it would deepen the shortfall every month.`,
    };
  }
  const horizonDays = 365;
  const synthetic = {
    label: "Hypothetical new cost", cadence: "monthly",
    typical_amount: Number(monthlyCost) || 0, next_expected: fromDate, active: true,
    excludeFromBackground: false,
  };
  const withNew = computeForwardRunway({ currentCash, avgRev, avgExp, avgFinOut: finOut, obligations: [...(obligations || []), synthetic], fromDate, horizonDays });

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

// ─── AMOUNT PARSING ─────────────────────────────────────────────
// Exports write money in many ways: "$1,234.56", "R 1 234,56", "1.234,56",
// "(1,234.56)", "1,234.56 Cr", "1,000.00 Dr", "ZAR 1500.00". Both parsers
// read amounts through parseAmount(), so they can never disagree.
//
// Whether "," or "." is the decimal mark is decided once per column from
// every value in it (detectDecimalStyle), because a lone "1,234" cannot say
// which it is. A column that never settles it keeps the dot reading, which
// is how every file was read before comma decimals were supported.
//
// A marker on the amount ("R", "$", "ZAR") or a Currency column records the
// row's currency. It is never used to convert anything.

// Longest first, so "US$" is not read as "$" and "R$" (Brazilian real) is
// not read as "R" (rand). A bare "$" is taken as US dollars.
const CURRENCY_MARKERS = [
  ["US$", "USD"], ["AU$", "AUD"], ["CA$", "CAD"], ["NZ$", "NZD"],
  ["A$", "AUD"], ["C$", "CAD"], ["R$", "BRL"],
  ["$", "USD"], ["€", "EUR"], ["£", "GBP"], ["R", "ZAR"],
];

// A Currency column's value ("ZAR", "zar", "R", "$") as an ISO code, or null.
export function currencyCode(val) {
  const s = String(val ?? "").trim();
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  const marker = CURRENCY_MARKERS.find(([sym]) => sym === s);
  return marker ? marker[1] : null;
}

// Strips signs, Cr/Dr, currency codes and symbols from an amount, leaving
// only digits and separators in `core`.
function amountCore(raw) {
  let s = String(raw ?? "").replace(/[   ]/g, " ").trim();
  if (s === "" || s === "-" || s === "—" || s === "–") return { empty: true, core: "", negative: false, currency: null };
  let negative = false;
  let currency = null;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) { negative = true; s = paren[1].trim(); }
  // An ISO code before or after the number: "ZAR 1500.00", "1500.00 USD".
  let m = s.match(/^([A-Z]{3})\s*([-+(]?[\d.,].*)$/);
  if (m) { currency = m[1]; s = m[2].trim(); }
  else {
    m = s.match(/^(.*[\d.,)])\s*([A-Z]{3})$/);
    if (m) { currency = m[2]; s = m[1].trim(); }
  }
  // Bank statements mark direction with a suffix: Cr is money in, Dr money out.
  m = s.match(/^(.*?)\s*(cr|dr)\.?$/i);
  if (m && /[\d]/.test(m[1])) { if (m[2].toLowerCase() === "dr") negative = true; s = m[1].trim(); }
  const takeSign = () => {
    if (s.startsWith("-")) { negative = true; s = s.slice(1).trim(); }
    else if (s.startsWith("+")) s = s.slice(1).trim();
  };
  takeSign();
  const prefix = CURRENCY_MARKERS.find(([sym]) => s.startsWith(sym));
  if (prefix) { currency = currency || prefix[1]; s = s.slice(prefix[0].length).trim(); takeSign(); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1).trim(); }
  const suffix = CURRENCY_MARKERS.find(([sym]) => s.endsWith(sym) && /[\d.,]\s*$/.test(s.slice(0, -sym.length)));
  if (suffix) { currency = currency || suffix[1]; s = s.slice(0, -suffix[0].length).trim(); }
  const paren2 = s.match(/^\((.*)\)$/);
  if (paren2) { negative = true; s = paren2[1].trim(); }
  return { empty: false, core: s.replace(/[\s']/g, ""), negative, currency };
}

// "comma" when the column writes decimals with a comma ("1 234,56",
// "1.234,56", "250,75"), otherwise "dot".
export function detectDecimalStyle(values) {
  let comma = 0, dot = 0;
  (values || []).forEach(v => {
    const { core } = amountCore(v);
    const lastComma = core.lastIndexOf(",");
    const lastDot = core.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) { if (lastComma > lastDot) comma++; else dot++; return; }
    if (lastComma >= 0) {
      if ((core.match(/,/g) || []).length > 1) dot++;           // 1,234,567: commas group thousands
      else if (core.length - lastComma - 1 !== 3) comma++;      // 250,75
      // exactly three digits after one comma fits either reading: no vote
    } else if (lastDot >= 0) {
      if ((core.match(/\./g) || []).length > 1) comma++;        // 1.234.567: dots group thousands
      else if (core.length - lastDot - 1 !== 3) dot++;          // 250.75
    }
  });
  return comma > dot ? "comma" : "dot";
}

// One amount as { value, currency, ok }. An empty cell is 0 and ok; text
// that is not a number is 0 and not ok, so the caller can count it rather
// than silently treating it as zero.
export function parseAmount(raw, decimalStyle = "dot") {
  const a = amountCore(raw);
  if (a.empty) return { value: 0, currency: null, ok: true };
  let s = a.core;
  if (!/^[\d.,]*\d[\d.,]*$/.test(s)) return { value: 0, currency: a.currency, ok: false };
  s = decimalStyle === "comma" ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return { value: 0, currency: a.currency, ok: false };
  const n = Number(s);
  if (!Number.isFinite(n)) return { value: 0, currency: a.currency, ok: false };
  return { value: a.negative ? -n : n, currency: a.currency, ok: true };
}

// Reads amounts from one parsed sheet, deciding each column's decimal mark
// from the whole column the first time it is read.
function columnAmountReader(dataRows) {
  const styles = new Map();
  return (row, col) => {
    if (col === -1) return { value: 0, currency: null, ok: true };
    if (!styles.has(col)) styles.set(col, detectDecimalStyle(dataRows.map(r => r[col])));
    return parseAmount(row[col], styles.get(col));
  };
}

const CURRENCY_HEADERS = ["currency", "ccy", "curr", "cur", "currency code"];

// Some bank exports give an unsigned Amount and state its direction in a
// column of its own ("Dr/Cr": Dr is money out, Cr money in). Headers arrive
// lowercased with spaces, underscores and hyphens collapsed to one space.
const DIRECTION_HEADERS = ["dr/cr", "cr/dr", "dr cr", "cr dr", "drcr", "crdr", "d/c", "c/d", "dr or cr", "cr or dr", "debit/credit", "credit/debit"];
// +1 for money in, -1 for money out, 0 when the cell does not say.
function directionSign(val) {
  const v = String(val ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (["dr", "d", "debit"].includes(v)) return -1;
  if (["cr", "c", "credit"].includes(v)) return 1;
  return 0;
}
// Applies a Dr/Cr column to a bank-mode amount. A cell that says nothing
// leaves the amount exactly as the file wrote it.
function withDirection(amount, row, directionCol) {
  if (directionCol === -1) return amount;
  const sign = directionSign(row[directionCol]);
  return sign === 0 ? amount : sign * Math.abs(amount);
}

// The currency a row declares, from its Currency column or a marker on any
// of its amounts, or null when it declares none.
function rowDeclaredCurrency(row, currencyCol, amountCols) {
  if (currencyCol !== -1) {
    const code = currencyCode(row[currencyCol]);
    if (code) return code;
  }
  for (const col of amountCols) {
    if (col === -1) continue;
    const c = amountCore(row[col]).currency;
    if (c) return c;
  }
  return null;
}

// ─── FILE READING ───────────────────────────────────────────────
// One reader serves both parsers, so a file is understood the same way for
// the session preview and for the saved history. It accepts comma,
// semicolon, tab or pipe delimited text; a header row anywhere in the first
// 25 lines (bank exports often open with an account summary); quoted fields
// holding delimiters, doubled quotes or line breaks; and UTF-8 or UTF-16
// text (decodeTextFile). Headers are matched by whole name or whole word,
// never by substring: "Value Date" is a date, not an amount, and an empty
// header from a trailing comma matches nothing.

// Uploaded bytes to text. Excel's "Unicode Text" export is UTF-16; most
// other exports are UTF-8, sometimes with a byte-order mark.
export function decodeTextFile(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  const start = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  // UTF-16 without a byte-order mark: plain text then has a zero byte in
  // every other position.
  const sample = b.subarray(start, Math.min(b.length, start + 400));
  let evenZeros = 0, oddZeros = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZeros++; else evenZeros++; }
  if (sample.length >= 4 && (evenZeros + oddZeros) / sample.length > 0.3) {
    return new TextDecoder(oddZeros >= evenZeros ? "utf-16le" : "utf-16be").decode(b.subarray(start));
  }
  return new TextDecoder("utf-8").decode(b.subarray(start));
}

const DELIMITERS = [",", ";", "\t", "|"];
const MAX_HEADER_SCAN = 25;

function countOutsideQuotes(line, d) {
  let n = 0, quoted = false;
  for (const ch of line) { if (ch === '"') quoted = !quoted; else if (ch === d && !quoted) n++; }
  return n;
}

// The delimiter that splits the most lines into the same number of fields.
function detectDelimiter(lines) {
  let best = ",", bestScore = 0;
  for (const d of DELIMITERS) {
    const freq = {};
    lines.forEach(l => { const c = countOutsideQuotes(l, d); if (c > 0) freq[c] = (freq[c] || 0) + 1; });
    for (const [count, agree] of Object.entries(freq)) {
      const score = agree * 100 + Number(count);
      if (score > bestScore) { best = d; bestScore = score; }
    }
  }
  return best;
}

// RFC 4180: a field that starts with a quote may hold delimiters, doubled
// quotes and line breaks. A quote inside an unquoted field is just a character.
function tokenize(text, d) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (ch === d) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ""));
}

const HEADER_CURRENCY_SUFFIX = /\s+(zar|usd|eur|gbp|aud|cad|nzd|chf|r|\$)$/;
function normalizeHeader(h) {
  return String(h ?? "").replace(/^﻿/, "").toLowerCase()
    .replace(/\(([^)]*)\)/g, " $1 ")        // "Amount (ZAR)" -> "amount zar"
    .replace(/[_\-\s.:#]+/g, " ").trim()
    .replace(HEADER_CURRENCY_SUFFIX, "").trim(); // "debit usd" -> "debit"
}

// Exact header names for each column role, in order of preference.
const HEADER_ROLES = {
  date:        ["date", "transaction date", "trans date", "txn date", "posting date", "post date", "posted date", "date posted", "booking date", "effective date", "statement date", "value date", "period", "month"],
  description: ["description", "narrative", "details", "transaction details", "transaction description", "reference", "memo", "particulars", "payee", "payer", "name", "merchant", "counterparty", "beneficiary", "transaction", "notes", "description 1"],
  amount:      ["amount", "transaction amount", "net amount", "value", "amt", "net"],
  debit:       ["debit", "debits", "debit amount", "money out", "paid out", "withdrawal", "withdrawals", "payment", "payments", "out", "dr", "outflow", "spent", "charges"],
  credit:      ["credit", "credits", "credit amount", "money in", "paid in", "deposit", "deposits", "in", "cr", "inflow", "received", "receipts"],
  balance:     ["balance", "running balance", "closing balance", "available balance", "ledger balance", "current balance", "account balance"],
  revenue:     ["revenue", "income", "sales", "turnover", "gross sales", "total income", "total revenue", "receipts earned"],
  expense:     ["expenses", "expense", "costs", "cost", "total expenses", "total expense", "expenditure", "overheads", "total costs"],
  currency:    CURRENCY_HEADERS,
  direction:   [...DIRECTION_HEADERS, "type", "transaction type", "dr cr indicator", "debit credit indicator"],
};
// Without an exact match, a whole word in the header can still say what it holds.
const HEADER_WORDS = {
  date: ["date"], amount: ["amount"], balance: ["balance"],
  description: ["description", "narrative", "details", "memo", "reference", "payee"],
  debit: ["debit", "withdrawal", "withdrawals"], credit: ["credit", "deposit", "deposits"],
  revenue: ["revenue", "income", "sales"], expense: ["expense", "expenses", "costs"],
};

function mapColumns(rawHeaders) {
  const headers = rawHeaders.map(normalizeHeader);
  const roles = {};
  const used = new Set();
  for (const [role, names] of Object.entries(HEADER_ROLES)) {
    for (const name of names) {
      const idx = headers.findIndex((h, i) => h === name && !used.has(i));
      if (idx !== -1) { roles[role] = idx; used.add(idx); break; }
    }
  }
  for (const [role, words] of Object.entries(HEADER_WORDS)) {
    if (roles[role] !== undefined) continue;
    const idx = headers.findIndex((h, i) => h && !used.has(i) && h.split(/[^a-z]+/).some(w => words.includes(w)));
    if (idx !== -1) { roles[role] = idx; used.add(idx); }
  }
  return roles;
}

const hasMoneyColumns = r => r.amount !== undefined || (r.debit !== undefined && r.credit !== undefined) || (r.revenue !== undefined && r.expense !== undefined);

// The first row in the scan window that names a date and money columns.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(MAX_HEADER_SCAN, rows.length); i++) {
    const roles = mapColumns(rows[i]);
    if (roles.date !== undefined && hasMoneyColumns(roles)) return { index: i, roles };
  }
  return null;
}

// ─── DATES ──────────────────────────────────────────────────────
// A numeric date such as 05/03/2026 is 5 March (day first) or 3 May (month
// first). The order is decided once per column from every value in it: a
// first part above 12 can only be a day, a second part above 12 can only be
// a day. A column that never settles it is read day first, the South
// African and most of the world's convention; the upload message says how
// dates were read so a founder can spot a US file read the wrong way. Every
// date is checked against the calendar: 31/02/2026 is not a date, and an
// impossible date never reaches the database.
const MONTH_NAMES_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T].*)?$/;
const NUMERIC_DATE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})(?:[ T].*)?$/;

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const fullYear = y => { const n = Number(y); return n < 100 ? 2000 + n : n; };
const monthIndex = name => MONTH_NAMES_SHORT.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;

export function detectDateOrder(values) {
  let dayFirst = 0, monthFirst = 0;
  (values || []).forEach(v => {
    const m = String(v ?? "").trim().match(NUMERIC_DATE);
    if (!m) return;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  });
  return { order: monthFirst > dayFirst ? "mdy" : "dmy", resolved: dayFirst + monthFirst > 0, conflicting: dayFirst > 0 && monthFirst > 0 };
}

// One date as YYYY-MM-DD, or null when it is not a real calendar date.
export function parseDateValue(value, order = "dmy") {
  const s = String(value ?? "").trim();
  if (!s) return null;
  let m = s.match(ISO_DATE);
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return validYmd(y, mo, d) ? ymd(y, mo, d) : null; }
  m = s.match(NUMERIC_DATE);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(m[3]);
    const [d, mo] = order === "mdy" ? [b, a] : [a, b];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); // 20261005
  if (m) { const y = +m[1], mo = +m[2], d = +m[3]; return validYmd(y, mo, d) ? ymd(y, mo, d) : null; }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-\/]+([a-z]{3,9})\.?[\s\-\/,]+(\d{2}|\d{4})\b/i); // 5 Jan 2026, 05-Jan-26
  if (m) { const mo = monthIndex(m[2]), y = fullYear(m[3]); return mo > 0 && validYmd(y, mo, +m[1]) ? ymd(y, mo, +m[1]) : null; }
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i); // Jan 5, 2026
  if (m) { const mo = monthIndex(m[1]), y = +m[3]; return mo > 0 && validYmd(y, mo, +m[2]) ? ymd(y, mo, +m[2]) : null; }
  return null;
}

// A month on its own, for monthly summaries: 2026-07, 07/2026, Jul 2026, July-26.
export function parseMonthValue(value) {
  const s = String(value ?? "").trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(+m[2]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${String(+m[1]).padStart(2, "0")}`;
  m = s.match(/^([a-z]{3,9})\.?[\s\-\/,']+(\d{2}|\d{4})$/i);
  if (m) { const mo = monthIndex(m[1]); if (mo > 0) return `${fullYear(m[2])}-${String(mo).padStart(2, "0")}`; }
  return null;
}

// ─── TRANSACTION EVENT PARSER ───────────────────────────────────
// Emits one signed record per source row; the DB is the source of truth,
// and monthly aggregation happens at read time (aggregateTransactionsByMonth),
// never as something stored.
//
// Each transaction keeps the currency it arrived in: the one its row
// declares, else the one the founder said the file is in, else null.
// Nothing is converted.
//
// A monthly summary (Revenue and Expenses columns) becomes two records per
// month, one for each column, dated the first of the month when the file
// gives only a month. Netting them into one amount, as this parser once did,
// saved R10 000 revenue and R6 000 costs as R4 000 revenue at a 100% margin.
//
// Identical rows in one file (two R50 card sales on the same day) are
// separate events. Each repeat carries its position (`occurrence`), so its
// duplicate-upload hash differs from the first while a re-upload of the
// same file still matches row for row.
export const parseTransactions = (text, options = {}) => {
  const source = String(text ?? "").replace(/^﻿/, "");
  const lines = source.split(/\r?\n/).filter(l => l.trim() !== "").slice(0, MAX_HEADER_SCAN + 30);
  if (lines.length < 2) return null;
  const allRows = tokenize(source, detectDelimiter(lines));
  const header = findHeaderRow(allRows);
  if (!header) return null;
  const { roles } = header;
  const dataRows = allRows.slice(header.index + 1);
  const col = role => roles[role] ?? -1;

  const mode = roles.revenue !== undefined && roles.expense !== undefined ? "named"
    : roles.amount !== undefined ? "bank"
    : roles.debit !== undefined && roles.credit !== undefined ? "split"
    : null;
  if (!mode) return null;

  const readAmount = columnAmountReader(dataRows);
  let unreadable = 0;
  const toNum = (row, c) => {
    const a = readAmount(row, c);
    if (!a.ok) unreadable++;
    return a.value;
  };
  const amountCols = [col("revenue"), col("expense"), col("debit"), col("credit"), col("amount")];

  const dateValues = dataRows.map(r => r[col("date")]);
  const dateOrder = detectDateOrder(dateValues);
  const monthOnly = dateValues.some(v => parseMonthValue(v) !== null)
    && dateValues.every(v => !String(v ?? "").trim() || (parseDateValue(v, dateOrder.order) === null && parseMonthValue(v) !== null));
  const dateOf = v => {
    const full = parseDateValue(v, dateOrder.order);
    if (full) return full;
    const month = monthOnly ? parseMonthValue(v) : null;
    return month ? `${month}-01` : null;
  };

  const transactions = [];
  const seen = {};
  let skippedDates = 0;
  const datedRows = []; // [rowIndex, date] for the closing balance
  const push = (txnDate, description, amount, currency) => {
    const rounded = Math.round(amount * 100) / 100;
    const key = `${txnDate}|${normalizeDescription(description)}|${rounded.toFixed(2)}`;
    const occurrence = (seen[key] = (seen[key] || 0) + 1);
    transactions.push({
      txn_date: txnDate,
      description,
      amount: rounded,
      category: rounded < 0 ? detectExpenseCategory(description) : null,
      counterparty: rounded > 0 ? extractCounterparty(description) : null,
      currency,
      ...(occurrence > 1 ? { occurrence } : {}),
    });
  };

  dataRows.forEach((row, i) => {
    if (row.every(c => c === "")) return;
    const rawDesc = roles.description !== undefined ? (row[roles.description] || "") : "";
    const currency = rowDeclaredCurrency(row, col("currency"), amountCols) || options.currency || null;
    let parts;
    if (mode === "named") {
      const revenue = Math.abs(toNum(row, col("revenue")));
      const expenses = Math.abs(toNum(row, col("expense")));
      parts = [[revenue, rawDesc || "Revenue"], [-expenses, rawDesc || "Expenses"]];
    } else if (mode === "split") {
      parts = [[Math.abs(toNum(row, col("credit"))) - Math.abs(toNum(row, col("debit"))), rawDesc || "Transaction"]];
    } else {
      parts = [[withDirection(toNum(row, col("amount")), row, col("direction")), rawDesc || "Transaction"]];
    }
    parts = parts.filter(([amount]) => amount !== 0);
    if (parts.length === 0) return;
    const txnDate = dateOf(row[col("date")]);
    if (!txnDate) { skippedDates++; return; } // no reliable date: can't place it in the timeline honestly
    datedRows.push([i, txnDate, currency]);
    parts.forEach(([amount, description]) => push(txnDate, description, amount, currency));
  });

  if (transactions.length === 0) return null;

  // The balance after the most recent transaction. Exports run newest first
  // or oldest first; on the last day, the final balance is the first such
  // row in a newest-first file and the last in an oldest-first one.
  let closingBalance = null;
  if (roles.balance !== undefined && datedRows.length > 0) {
    const newestFirst = datedRows[0][1] > datedRows[datedRows.length - 1][1];
    const lastDate = datedRows.reduce((m, r) => (r[1] > m ? r[1] : m), datedRows[0][1]);
    const onLastDay = datedRows.filter(r => r[1] === lastDate);
    const [rowIndex, date, currency] = newestFirst ? onLastDay[0] : onLastDay[onLastDay.length - 1];
    const bal = readAmount(dataRows[rowIndex], roles.balance);
    if (bal.ok && String(dataRows[rowIndex][roles.balance] ?? "").trim() !== "") {
      closingBalance = { amount: Math.round(bal.value * 100) / 100, date, currency: bal.currency || currency };
    }
  }

  return {
    transactions, mode, unreadable, skippedDates, closingBalance,
    dateOrder: { ...dateOrder, monthOnly, numeric: dateValues.some(v => NUMERIC_DATE.test(String(v ?? "").trim())) },
    columns: Object.keys(roles),
  };
};

// Monthly totals for the session preview and the public demo, from the same
// records parseTransactions saves. Monthly buckets add rows together, so
// they hold one currency: the one the caller names, else the one most rows
// declare. Rows in another currency are left out and counted, never added in.
export const parseAnyCSV = (text, options = {}) => {
  const parsed = parseTransactions(text, options);
  if (!parsed) return null;
  const declared = {};
  parsed.transactions.forEach(t => { if (t.currency) declared[t.currency] = (declared[t.currency] || 0) + 1; });
  const currency = options.currency || Object.keys(declared).sort((a, b) => declared[b] - declared[a])[0] || null;
  const excludedCounts = {};
  const included = parsed.transactions.filter(t => {
    if (!currency || !t.currency || t.currency === currency) return true;
    excludedCounts[t.currency] = (excludedCounts[t.currency] || 0) + 1;
    return false;
  });
  const rows = aggregateTransactionsByMonth(included, { today: options.today, rules: options.rules });
  if (rows.length === 0) return null;
  // The file's own closing balance, when it is in this currency.
  const cb = parsed.closingBalance;
  if (cb && (!currency || !cb.currency || cb.currency === currency)) Object.assign(rows[rows.length - 1], { cash: cb.amount, cashKnown: true });

  const fields = new Set(parsed.columns);
  const detectedFields = [];
  if (parsed.mode === "named") detectedFields.push("Revenue", "Expenses");
  if (parsed.mode === "bank") detectedFields.push("Transactions", "Income", "Outflows");
  if (parsed.mode === "split") detectedFields.push("Debits", "Credits");
  if (fields.has("date")) detectedFields.push("Dates");
  if (fields.has("description")) detectedFields.push("Categories");
  if (fields.has("balance")) detectedFields.push("Balance");
  const excluded = Object.entries(excludedCounts).map(([code, count]) => ({ currency: code, count }));
  return {
    rows, detectedFields, mode: parsed.mode, currency, excluded,
    unreadable: parsed.unreadable, skippedDates: parsed.skippedDates, dateOrder: parsed.dateOrder,
    closingBalance: cb,
  };
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

// A repeat of an identical row in the same file (`occurrence` 2, 3, ...)
// gets its own hash, so two genuine R50 sales on one day are both kept. The
// first occurrence keeps the original form, so hashes already stored still
// match.
export function dedupeHashInput(txn) {
  const base = `${txn.txn_date}|${normalizeDescription(txn.description)}|${Number(txn.amount).toFixed(2)}`;
  return txn.occurrence > 1 ? `${base}|#${txn.occurrence}` : base;
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
//
// Each transaction counts by its kind (see TRANSACTION KINDS; `options.rules`
// is the founder's rule index). Revenue is money from customers less refunds
// paid to them; expenses are costs less refunds received. Loans, owner money
// and transfers are kept in their own totals and added to neither.
//
// A month is `partial` when it is not over yet (it is this month, by
// `options.today`), or when the data starts or stops more than a week
// inside it (only the first and last months can be cut short). Its money is
// real and counts in period totals, but it is not a month's worth: on the
// 4th, a month holds four days of sales, and comparing that with a full
// month read as revenue collapsing. Monthly summaries date every row on the
// 1st, so a last month whose transactions all fall on the 1st, after a
// month that did the same, is a summary and complete unless it is this
// month. After ordinary daily data, a last month that stops on the 1st is
// one day of a month: partial.
const CATEGORY_BUCKETS = new Set(["payroll", "marketing", "cogs", "rent", "software"]);
const PARTIAL_GAP_DAYS = 7;
function daysInMonthOf(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const onlyOnThe1st = b => b.lastDate.slice(8, 10) === "01";
function monthIsPartial(key, b, prev, isFirst, isLast, today) {
  if (key >= today.slice(0, 7)) return true;
  if (isFirst && Number(b.firstDate.slice(8, 10)) - 1 > PARTIAL_GAP_DAYS) return true;
  if (isLast && !(onlyOnThe1st(b) && (!prev || onlyOnThe1st(prev)))
    && daysInMonthOf(key) - Number(b.lastDate.slice(8, 10)) > PARTIAL_GAP_DAYS) return true;
  return false;
}

// A month's name as every screen and the report CSV show it: a partial
// month says it is only to date, so it is never read as a whole month.
export const monthLabel = r => (r?.partial ? `${r.month} (to date)` : r?.month || "");

// The first day of the month `months` calendar months before today's
// month, so "the last 3 months" in November is August, September and
// October in full (plus November so far), never a cut that starts on the
// 4th and leaves the first month partial.
export function periodStartDate(months, today = new Date().toISOString().slice(0, 10)) {
  const m = Number(months);
  if (!Number.isFinite(m) || m <= 0) return null;
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 - Math.floor(m);
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}
// Rounded to whole units, without a negative zero ("-$0").
const wholeUnits = v => { const r = Math.round(v); return r === 0 ? 0 : r; };

export function aggregateTransactionsByMonth(transactions, options = {}) {
  const rules = asRuleIndex(options.rules);
  const today = options.today || new Date().toISOString().slice(0, 10);
  const buckets = {};
  (transactions || []).forEach(t => {
    const date = String(t.txn_date).slice(0, 10);
    const key = date.slice(0, 7);
    if (!buckets[key]) buckets[key] = {
      revenue:0, expenses:0, payroll:0, marketing:0, cogs:0, rent:0, software:0,
      financingIn:0, financingOut:0, transferIn:0, transferOut:0, refundsIn:0, refundsOut:0,
      firstDate: date, lastDate: date,
    };
    const b = buckets[key];
    if (date < b.firstDate) b.firstDate = date;
    if (date > b.lastDate) b.lastDate = date;
    const amt = Number(t.amount) || 0;
    if (amt === 0) return;
    const abs = Math.abs(amt);
    const kind = transactionKind(t, rules);
    if (kind === "transfer") {
      if (amt > 0) b.transferIn += abs; else b.transferOut += abs;
    } else if (kind === "financing") {
      if (amt > 0) b.financingIn += abs; else b.financingOut += abs;
    } else if (kind === "refund") {
      if (amt > 0) {
        // Money back from a supplier: a cost that did not stay a cost.
        b.refundsIn += abs;
        b.expenses -= abs;
        const cat = detectExpenseCategory(t.description);
        if (CATEGORY_BUCKETS.has(cat)) b[cat] -= abs;
      } else {
        // Money returned to a customer: revenue that did not stay revenue.
        b.refundsOut += abs;
        b.revenue -= abs;
      }
    } else if (amt > 0) {
      b.revenue += abs;
    } else {
      b.expenses += abs;
      if (t.category && CATEGORY_BUCKETS.has(t.category)) b[t.category] += abs;
    }
  });

  const keys = Object.keys(buckets).sort();
  return keys.map((key, i) => {
    const b = buckets[key];
    // A refund larger than the month's spend in its category leaves the
    // category at zero, not below it; the expense total keeps the full amount.
    const category = c => wholeUnits(Math.max(0, b[c]));
    return {
      period_month: `${key}-01`,
      // In UTC, like the date it is made from: in the viewer's own time
      // zone, midnight on 1 April UTC is still 31 March west of Greenwich,
      // and every month was labelled one month early for US visitors.
      month: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month:"short", year:"2-digit", timeZone:"UTC" }),
      partial: monthIsPartial(key, b, i > 0 ? buckets[keys[i - 1]] : null, i === 0, i === keys.length - 1, today),
      coveredFrom: b.firstDate, coveredTo: b.lastDate,
      revenue: wholeUnits(b.revenue), expenses: wholeUnits(b.expenses), cash: 0,
      payroll: category("payroll"), marketing: category("marketing"), cogs: category("cogs"),
      rent: category("rent"), software: category("software"),
      financingIn: wholeUnits(b.financingIn), financingOut: wholeUnits(b.financingOut),
      transferIn: wholeUnits(b.transferIn), transferOut: wholeUnits(b.transferOut),
      refundsIn: wholeUnits(b.refundsIn), refundsOut: wholeUnits(b.refundsOut),
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
// noisy single-month spike. The trailing growth rate (same smoothing used
// for the 90-day projection) sets the direction and size: 50 + 3 points per
// percent a month, so 0% sits at 50, the middle of the "Flat" band. How
// consistently the recent month-over-month changes moved that way scales
// the distance from 50, between 60% (none did) and 100% (all did), so three
// steadily-growing months outscore one great month sandwiched between two
// down months at the same average rate, and a steady decline reads worse
// than a noisy one. Flat revenue is always 50. The previous formula added
// 30 points for consistency separately, so perfectly flat revenue (no
// positive changes) scored 35 and read as "Declining".
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
  // `consistency`: the share of the last three changes that moved the same
  // way as the rate (up for growth, down for decline).
  let consistency = 0.5;
  if (!usingSeasonalRate && rows && rows.length >= 3) {
    const deltas = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].revenue > 0) deltas.push(rows[i].revenue - rows[i - 1].revenue);
    }
    const lastFew = deltas.slice(-3);
    if (lastFew.length > 0) consistency = lastFew.filter(d => (rate < 0 ? d < 0 : d > 0)).length / lastFew.length;
  }

  const score = Math.min(100, Math.max(0, 50 + (rateScore - 50) * (0.6 + 0.4 * consistency)));
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
// `runwayKnown` is false when no cash balance exists to measure runway
// against. burnMonths is then meaningless (not short), so runway scores no
// risk — the same rule as every other missing input here.
export function computeRiskScore({ cashFlowPositive, burnMonths, runwayKnown = true, concentration, concentrationReliable, ltvcac, margin, trends, growthScore }) {
  const runwayRisk = cashFlowPositive || !runwayKnown ? 0
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
export function detectTrends(rows, seasonalPattern = null, currency = "USD") {
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
        message: `Margin ${delta > 0 ? "improved" : "fell"} to ${latest.toFixed(1)}% in the latest complete month, vs a ${avgPrior.toFixed(1)}% average over the prior ${prior.length} month(s).`,
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
          message: `${cat.charAt(0).toUpperCase()}${cat.slice(1)} grew to ${latest.toFixed(0)}% of expenses in the latest complete month, up from a ${avgPrior.toFixed(0)}% average.`,
        });
      }
    }
  });

  // The same basis as netBurn in computeMetrics: loan repayments and owner
  // withdrawals leave the bank, so they are part of burn.
  const burns = rows.map(r => r.expenses + (r.financingOut || 0) - r.revenue);
  if (burns.length >= 3) {
    const latest = burns[burns.length - 1];
    const prior = burns.slice(0, -1);
    const avgPrior = prior.reduce((s, v) => s + v, 0) / prior.length;
    const delta = latest - avgPrior;
    const materialMove = CURRENCY_BY_CODE[currency]?.materialMove ?? CURRENCY_BY_CODE.USD.materialMove;
    if (Math.abs(delta) >= Math.max(materialMove, Math.abs(avgPrior) * 0.15)) {
      trends.push({
        type: "burn",
        direction: delta < 0 ? "improving" : "worsening",
        message: `Net burn ${delta < 0 ? "improved" : "worsened"} to ${fmt(latest, currency)}/mo in the latest complete month, vs a ${fmt(avgPrior, currency)}/mo average.`,
      });
    }
  }

  if (seasonalPattern) {
    const note = ` This may reflect a recurring seasonal pattern for ${seasonalPattern.month} rather than a new problem: it has moved this way for ${seasonalPattern.occurrences} years running.`;
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
  // `context.cash` ({ amount, on }, from effectiveCashBalance) is a known
  // balance: used as it is, an overdraft or zero included. Without it the
  // older inputs stand: a file's closing balance on the newest row, or the
  // manual figure, where 0 means "not entered".
  const { lastTxnDate = null, revenueConcentration = null, currency = "USD", cash = null } = context;
  const { mRev, mExp, mCash, mCac, mLtv, mLeads, mClose, mFinOut = 0 } = manual;

  const tr = mode === "safe" ? 0.30 : 0.25;
  const sr = mode === "safe" ? 0.20 : 0.10;

  // Partial months (see aggregateTransactionsByMonth) count toward the
  // period's totals, but not toward anything that treats a row as a whole
  // month: the averages behind burn, runway and hiring capacity, the latest
  // month, growth, trends, seasonality and the projection. Until one month
  // is complete, the partial months are all there is, and they are used.
  const complete = rows ? rows.filter(r => !r.partial) : null;
  const basis    = rows ? (complete.length > 0 ? complete : rows) : null;
  const latest   = basis ? basis[basis.length - 1] : { revenue:mRev, expenses:mExp };
  const prev     = basis && basis.length > 1 ? basis[basis.length - 2] : latest;
  const sumRows  = (list, f) => list.reduce((s, d) => s + (Number(d[f]) || 0), 0);
  const totRev   = rows ? sumRows(rows, "revenue")  : mRev;
  const totExp   = rows ? sumRows(rows, "expenses") : mExp;
  const totCogs  = rows ? rows.reduce((s,d) => s + (d.cogs||0), 0) : 0;
  const totMkt   = rows ? rows.reduce((s,d) => s + (d.marketing||0), 0) : 0;
  const totL     = rows ? rows.reduce((s,d) => s + (d.leads||0), 0) : mLeads;
  const totC     = rows ? rows.reduce((s,d) => s + (d.closures||0), 0) : mClose;
  // Money kept out of revenue and costs (see TRANSACTION KINDS). Only
  // financing going out reaches a figure: it is part of burn.
  const sumOf = f => rows ? rows.reduce((s, d) => s + (Number(d[f]) || 0), 0) : 0;
  const totFinIn  = sumOf("financingIn");
  const totFinOut = rows ? sumOf("financingOut") : (Number(mFinOut) || 0);
  const totTrIn   = sumOf("transferIn"),  totTrOut  = sumOf("transferOut");
  const totRefIn  = sumOf("refundsIn"),   totRefOut = sumOf("refundsOut");
  // A balance belongs to the newest row, complete or not.
  const lastRow    = rows ? rows[rows.length - 1] : null;
  const knownCash  = cash && finiteOrNull(cash.amount) !== null ? Number(cash.amount)
    : lastRow?.cashKnown ? Number(lastRow.cash) || 0 : null;
  const cashKnown  = knownCash !== null;
  const activeCash = cashKnown ? knownCash : rows ? (lastRow.cash || mCash) : mCash;
  const activeCac  = rows ? (latest.cac  || mCac)  : mCac;
  const activeLtv  = rows ? (latest.ltv  || mLtv)  : mLtv;

  // Months behind the averages: complete months, or the partial ones when
  // nothing is complete yet.
  const n = basis?.length || 1;
  const partialMonths = rows ? rows.length - complete.length : 0;
  const hasData  = rows !== null || mRev > 0;
  const totPro   = totRev - totExp;
  const margin   = totRev > 0 ? (totPro / totRev) * 100 : 0;
  const vel      = prev.revenue > 0 ? ((latest.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  // Only persisted, period_month-bearing history (aggregateTransactionsByMonth's
  // output) can be checked for real calendar seasonality — a CSV parsed for
  // this session only carries a display-string month label, not a date.
  const hasPeriodMonth = !!(rows && rows.length > 0 && rows[0].period_month);
  const seasonalPattern = hasPeriodMonth ? detectCurrentMonthSeasonality(basis) : null;
  const seasonalAdjustedVel = seasonalPattern ? computeSeasonallyAdjustedVelocity(basis) : null;
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
  // Reserves are set aside out of profit. A loss owes no tax and funds no
  // buffer, so both are zero then and profit after reserves is the full loss —
  // reserving a negative amount used to report only half of it.
  const taxV      = Math.max(0, totPro) * tr;
  const safV      = Math.max(0, totPro) * sr;
  const free      = totPro - taxV - safV;
  const avgExp     = (rows ? sumRows(basis, "expenses") : mExp) / Math.max(n, 1);
  const avgRev     = (rows ? sumRows(basis, "revenue") : mRev) / Math.max(n, 1);
  const avgFinOut  = (rows ? sumRows(basis, "financingOut") : (Number(mFinOut) || 0)) / Math.max(n, 1);
  // Everything that leaves the bank in an average month: costs, plus loan
  // repayments and money the owner takes out.
  const avgCashOut = avgExp + avgFinOut;
  // Runway must reflect net burn (cash out less revenue), not gross
  // expenses — dividing cash by gross expenses tells a profitable,
  // cash-flow-positive company it's about to run out of money. When
  // revenue already covers it there's no burn to measure against. Loan
  // repayments and owner withdrawals are not costs, but they empty the bank
  // just the same, so they count here; a loan received does not offset
  // burn, because it is a one-off addition to cash, not income.
  const netBurn        = avgCashOut - avgRev;
  const cashFlowPositive = hasData && netBurn <= 0;
  // The mode's safety share is held back from one month's burn. It used to
  // be taken from the whole period's loss, so the same cash and burn read
  // as a shorter runway the longer the selected history — and went negative
  // ("---", maximum risk) on a long enough one.
  // Never below zero: cash that does not cover the safety share, or an
  // overdraft, is no runway, not negative runway.
  const burnMonths = netBurn > 0 ? Math.max(0, (activeCash - netBurn * sr) / netBurn) : 0;
  // Hiring capacity: the largest new fully-loaded monthly cost (salary,
  // payroll tax, benefits) the business's own average monthly profit can
  // carry without drawing down cash, after holding back the mode's safety
  // share. It replaced a yes/no "hire ready" test that compared the whole
  // period's profit against a fixed $25k/month hire — never true for a
  // $5k/month business, always true for a $5M one, and different for every
  // period filter. Measured against the founder's own numbers, it scales
  // with them. Whether a specific salary also holds against cash and dated
  // obligations is checkAffordability()'s job. Loan repayments and owner
  // withdrawals come out first: that money is already spoken for.
  const hiringCapacity = Math.max(0, (avgRev - avgCashOut) * (1 - sr));
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
  const proj90GrowthRate = Math.max(-50, Math.min(50, trailingGrowthRate(basis, vel)));
  const proj90     = latest.revenue * Math.pow(1 + proj90GrowthRate / 100, 3);
  // "low"    — a single manually-typed snapshot, no transaction history.
  // "medium" — real uploaded data, but under 3 months of it.
  // "high"   — real uploaded data with 3+ months of history.
  const dataConfidence = !rows ? "low" : n >= 3 ? "high" : "medium";

  const growth = computeGrowthScore(basis, vel, seasonalAdjustedVel);
  const trends = detectTrends(basis, seasonalPattern, currency);
  const risk = computeRiskScore({ cashFlowPositive, burnMonths, runwayKnown: cashKnown || activeCash > 0, concentration, concentrationReliable, ltvcac, margin, trends, growthScore: growth.score });

  // Long-run trajectory, seasonality, and a plain-language narrative —
  // same 13+/2+ month floors as the functions themselves. Every field
  // here is null (not fabricated) until there's real history behind it.
  const trajectory = hasPeriodMonth && basis.length >= 2 ? computeHistoricalTrajectory(basis) : null;
  const historicalConfidence = hasPeriodMonth ? computeHistoricalConfidence(n) : null;
  const founderNarrative = hasPeriodMonth ? buildFounderNarrative(trajectory, margin) : null;

  // Completeness: a field being 0 here is indistinguishable from it never
  // having been entered (manual inputs all default to 0), so — consistent
  // with how this engine already treats missing CAC/lead data elsewhere —
  // "present" means "greater than zero," not "not undefined."
  const hasCashData = cashKnown || activeCash > 0;
  const hasUnitEconomicsData = activeCac > 0 && activeLtv > 0;

  const runwayBase = metricConfidence(
    cashFlowPositive || hasCashData,
    "no cash balance entered. Add it under Transactions to calculate runway",
    n, lastTxnDate
  );
  // A balance from weeks ago says little about today's runway: one level
  // lower, and the reason says how old it is.
  const cashAgeDays = cash?.on ? Math.floor(((context.today ? Date.parse(context.today) : Date.now()) - Date.parse(cash.on)) / 86400000) : null;
  const runwayConfidence = runwayBase.shown && !cashFlowPositive && cashAgeDays !== null && cashAgeDays > CONFIDENCE_RECENCY_DAYS
    ? {
        ...runwayBase,
        level: runwayBase.level === "high" ? "moderate" : "low",
        reason: `${runwayBase.reason}, and a cash balance from ${cash.on}, ${cashAgeDays} days ago`,
      }
    : runwayBase;
  const breakEvenConfidence = metricConfidence(hasData, "no revenue/expense data yet", n, lastTxnDate);
  const proj90Confidence    = metricConfidence(hasData, "no revenue/expense data yet", n, lastTxnDate);
  const hiringCapacityConfidence = metricConfidence(hasData, "no revenue/expense data yet", n, lastTxnDate);
  const ltvcacConfidence    = metricConfidence(hasUnitEconomicsData, "enter both CAC and LTV to calculate", n, lastTxnDate);
  const growthConfidence    = metricConfidence(hasData, "no revenue data yet", n, lastTxnDate);

  return {
    tr, sr, latest, prev, totRev, totExp, totCogs, totMkt, totL, totC,
    hasConversionData, avgRev, netBurn, cashFlowPositive, dataConfidence,
    totFinIn, totFinOut, totTrIn, totTrOut, totRefIn, totRefOut, avgFinOut, avgCashOut, partialMonths,
    activeCash, activeCac, activeLtv, n, totPro, margin, vel, conv, ltvcac,
    cogsRatio, mktRatio, sov, sovLbl, taxV, safV, free, avgExp, burnMonths,
    hiringCapacity, concentration, concentrationReliable, revenueConcentration,
    breakEven, proj90, proj90GrowthRate, hasData,
    growth, risk, trends, seasonalPattern, trajectory, historicalConfidence, founderNarrative,
    hasCashData, hasUnitEconomicsData, cashKnown, cashOn: cash?.on ?? null,
    runwayConfidence, breakEvenConfidence, proj90Confidence,
    hiringCapacityConfidence, ltvcacConfidence, growthConfidence,
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
    // Loan repayments and owner withdrawals: not costs, but part of burn.
    mFinOut: Math.max(0, baseline.financingOut || 0),
  };
}

// Runs a scenario through computeMetrics and returns it alongside the
// baseline (unadjusted) result, so the caller can show a before/after
// comparison without computing the baseline twice.
// `options.cashKnown`: the baseline's cash is a known balance, passed as it
// is (an overdraft included), where a typed figure is floored at zero.
export function runScenario(baseline, adjustments, mode, options = {}) {
  const baselineManual = applyScenario(baseline, {});
  const scenarioManual = applyScenario(baseline, adjustments);
  const known = delta => options.cashKnown
    ? { cash: { amount: (Number(baseline.cash) || 0) + (Number(delta) || 0) } }
    : {};
  return {
    before: computeMetrics(null, baselineManual, mode, known(0)),
    after: computeMetrics(null, scenarioManual, mode, known(adjustments?.cashDelta)),
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
  if (n <= 1)  return { score: 40, label: "low",       reason: "based on a single month, with no trend context yet" };
  if (n <= 5)  return { score: 60, label: "medium",     reason: `based on ${n} months of history, an early trend signal` };
  if (n <= 11) return { score: 80, label: "high",       reason: `based on ${n} months of history, a real trend but not yet a full year` };
  return          { score: 92, label: "very high",  reason: `based on ${n} months of history, enough to account for seasonality` };
}

// Turns the computed trajectory into the kind of sentence a CFO would
// actually say — context, not just a number. Every clause here traces to a
// computed streak above; nothing is invented.
export function buildFounderNarrative(trajectory, currentMargin) {
  if (!trajectory) {
    return `Margin is ${pc(currentMargin)} this period. Connect more months of history for trend context: one data point isn't a trend.`;
  }
  const parts = [];

  if (trajectory.margin.streak.length >= 2) {
    const months = trajectory.margin.streak.length + 1;
    const verb = trajectory.margin.direction === "improving" ? "improved" : trajectory.margin.direction === "declining" ? "declined" : "held steady";
    parts.push(`Margin has ${verb} for ${months} consecutive months, now at ${pc(trajectory.margin.current)}.`);
  } else {
    // The trajectory's current margin is the latest complete month's, not
    // the selected period's.
    parts.push(`Margin was ${pc(trajectory.margin.current)} in the latest complete month.`);
  }

  if (trajectory.revenue.streak.length >= 2) {
    const months = trajectory.revenue.streak.length + 1;
    parts.push(`Revenue has been ${trajectory.revenue.direction} for ${months} consecutive months.`);
  }

  if (trajectory.cashFlow.direction === "deteriorating" && trajectory.cashFlow.streak.length >= 2) {
    parts.push(`Net burn has worsened for ${trajectory.cashFlow.streak.length + 1} straight months. This is a trend, not a one-off.`);
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
// `runwayKnown` (a cash balance is known) and `cashFlowPositive` tell a
// runway of 0 months (no cash left to burn) from one that was never
// measured; without them, 0 is read as unmeasured, as before.
export function computeDirective({ margin, burnMonths, free, vel, conv, ltvcac, months, concentration, currency = "USD", runwayKnown = false, cashFlowPositive = false }) {
  const raw = (() => {
    // Reserves come out of profit only, so this is a loss for the period.
    // The rule keeps its stored name.
    if (safe(free) < 0) return {
      text: "Cut all non-essential spend before end of this week.",
      reason: `The business made a loss of ${fmt(Math.abs(free), currency)} in this period: costs are higher than revenue, so there is nothing to set aside for tax or a safety buffer. Each month at this rate is paid for from cash or borrowing.`,
      severity: "critical", rule: "negative_free_cash", targetMetric: "free",
    };
    const outOfRunway = runwayKnown && !cashFlowPositive && safe(burnMonths) <= 0;
    if ((safe(burnMonths) > 0 && safe(burnMonths) < 3) || outOfRunway) return {
      text: "Protect your runway. You have less than 3 months.",
      reason: outOfRunway
        ? "Your cash balance no longer covers a month of net burn after the safety share. Suspend all non-revenue-generating spend immediately."
        : `At current burn rate you have ${safe(burnMonths).toFixed(1)} months before the business runs dry. Suspend all non-revenue-generating spend immediately.`,
      severity: "critical", rule: "low_runway", targetMetric: "burnMonths",
    };
    // Only from real, confidently-extracted payer names — never from a
    // low-confidence parse. `concentration.shown` already means
    // "confidence moderate or high," by construction of computeRevenueConcentration.
    if (concentration?.shown && concentration.severity) {
      const isCritical = concentration.severity === "critical";
      // Fewer than three named clients is fewer than three clients only when
      // no money arrives through a processor, whose customers are hidden.
      const tooFewPayers = concentration.distinctPayers < 3 && !(concentration.aggregatorRevenue > 0);
      return {
        text: isCritical
          ? "Diversify your revenue before growing it."
          : tooFewPayers
            ? "Land a third paying client before scaling spend."
            : "Reduce reliance on your largest client before it becomes a crisis.",
        reason: tooFewPayers
          ? `You have ${concentration.distinctPayers} distinct paying client${concentration.distinctPayers === 1 ? "" : "s"} this period. Losing any one of them is a material hit to revenue, however the revenue splits between them.`
          : `${concentration.largestPct.toFixed(0)}% of revenue comes from your single largest client. One client exit or contract loss exposes the business at this concentration, and the risk stays invisible until it is catastrophic.`,
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
      reason: `Margin at ${pc(margin)} and conversion at ${pc(conv)} are both above threshold. This is a deployment window. Increase lead volume 30%; the economics support it.`,
      severity: "go", rule: "scale_window", targetMetric: "vel",
    };
    // There is no "hire now" directive. Telling a founder to hire needs a
    // view of what the role costs and returns, which this engine does not
    // have; the one it had assumed $25k/month for every business. Hiring
    // capacity is shown as a figure instead, and a specific salary is tested
    // with checkAffordability().
    if (safe(vel) < 5 && safe(vel) >= 0) return {
      text: "Revenue growth has stalled. Find the constraint this week.",
      reason: `Velocity at ${pc(vel)}/month signals a blockage in pipeline, conversion or retention. Diagnose before spending more on growth.`,
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
  free: { label: "Profit after reserves", fmt: (v, currency) => fmt(v, currency), higherIsBetter: true },
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
export function describeDirectiveOutcome(directive, currency = "USD") {
  const meta = DIRECTIVE_METRIC_LABELS[directive?.target_metric] || null;
  if (directive?.outcome_metric === null || directive?.outcome_metric === undefined || !meta) {
    const daysSince = directive?.issued_at
      ? Math.floor((Date.now() - new Date(directive.issued_at).getTime()) / 86400000)
      : 0;
    const daysRemaining = Math.max(0, 60 - daysSince);
    return {
      status: "pending",
      message: daysRemaining > 0
        ? `Pending: measured 60 days after issue (${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining).`
        : "Pending: outcome not yet measured.",
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
      ? `${meta.label} has not moved: still ${meta.fmt(after, currency)}.`
      : `${meta.label} moved from ${meta.fmt(before, currency)} to ${meta.fmt(after, currency)}.`,
  };
}

// ─── CHECKOUT PRICE INTEGRITY ───────────────────────────────────
// PayPal holds the authoritative terms of a subscription: the price, currency
// and billing interval live on the PayPal plan, and this app only renders a
// number beside it. If the two disagree, the page is misstating what the
// customer's card will be charged, and a subscription must not be created.
//
// `verified` is the plan summary returned by the plan-pricing Edge Function,
// read live from PayPal at checkout time — not a price typed into the code,
// which could go stale the moment someone edits the plan in PayPal.
//
// The rule: checkout opens only when every charge, starting with the first,
// equals the price on the page. A setup fee always blocks. A trial cycle
// blocks unless the page discloses it as the plan's `intro` ({ usd, months })
// and PayPal bills exactly that: one trial cycle, at that amount, in USD, on
// the plan's interval, for that many cycles. An undisclosed trial blocks even
// when it favours the customer, and so does a disclosed intro that PayPal no
// longer bills, because the page would then promise a price nobody is
// charged. Tax works the same way: a tax PayPal adds on top of each charge
// (not inclusive) must be disclosed as the plan's `tax` ({ percent }) at the
// same rate, and a disclosed tax PayPal does not add blocks too; an inclusive
// tax is already inside the price shown. A tax PayPal reports but plan-pricing
// could not read blocks as unverified. Checks run from the most serious
// disagreement to the least, so a wrong recurring price is reported ahead of
// a trial.
//
// Returns null when checkout is safe, otherwise a machine-readable reason.
export function checkoutBlockReason(plan, verified) {
  if (!plan || typeof plan.usd !== "number") return "unknown_plan";
  if (!verified || !verified.planId) return "not_configured";
  if (verified.status !== "ACTIVE") return "plan_inactive";
  if (verified.currency !== "USD") return "currency_mismatch";
  if (verified.intervalUnit !== (plan.interval || "MONTH") || verified.intervalCount !== 1) return "interval_mismatch";
  if (typeof verified.amount !== "number" || !Number.isFinite(verified.amount)) return "price_unverified";
  if (verified.amount !== plan.usd) return "price_mismatch";
  if (typeof verified.taxPercent !== "number" || !Number.isFinite(verified.taxPercent)) return "price_unverified";
  const taxAdded = verified.taxInclusive === true ? 0 : verified.taxPercent;
  if (taxAdded !== (plan.tax ? plan.tax.percent : 0)) return "tax_mismatch";
  if (verified.setupFee !== 0) return "first_charge_differs";
  const trials = Array.isArray(verified.trials) ? verified.trials : [];
  if (plan.intro) {
    const t = trials[0];
    const billsDisclosedIntro = trials.length === 1 && !!t
      && t.amount === plan.intro.usd && t.currency === "USD"
      && t.intervalUnit === (plan.interval || "MONTH") && t.intervalCount === 1
      && t.totalCycles === plan.intro.months;
    return billsDisclosedIntro ? null : "first_charge_differs";
  }
  if (verified.hasTrial === true || trials.length > 0) return "first_charge_differs";
  return null;
}

// ─── WORKSPACE SEARCH ──────────────────────────────────────────
// Backs the header search box. Every result is something real: a page of the
// app, or a transaction from the founder's own history. A token matches a
// transaction's description or category, a date prefix ("2026-03"), or its
// amount ("1500", "$1,500.00" — sign ignored, whole dollars match any cents).
// Every token in the query must match.
function transactionTokenMatches(txn, token) {
  if (String(txn.description || "").toLowerCase().includes(token)) return true;
  if (String(txn.category || "").toLowerCase().includes(token)) return true;
  if (String(txn.txn_date || "").startsWith(token)) return true;
  const numeric = token.replace(/[$,]/g, "").replace(/^[-+]/, "");
  if (/^\d+(\.\d+)?$/.test(numeric)) {
    const abs = Math.abs(Number(txn.amount) || 0);
    return numeric.includes(".") ? Math.abs(abs - Number(numeric)) < 0.005 : Math.floor(abs) === Number(numeric);
  }
  return false;
}

const searchTokens = query => String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);

export function filterTransactions(transactions, query) {
  const tokens = searchTokens(query);
  const list = transactions || [];
  return tokens.length === 0 ? list : list.filter(t => tokens.every(tok => transactionTokenMatches(t, tok)));
}

// `destinations` is [{ id, label, keywords }]; one matches when any query
// token of 2+ characters starts a word of its label or keywords.
export function searchWorkspace(query, { transactions = [], destinations = [], limit = 6 } = {}) {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return { destinations: [], transactions: [], transactionTotal: 0 };
  const matchedDestinations = destinations.filter(d => {
    const words = [d.label, ...(d.keywords || [])].join(" ").toLowerCase().split(/[\s/&-]+/).filter(Boolean);
    return tokens.some(tok => tok.length >= 2 && words.some(w => w.startsWith(tok)));
  });
  const matched = filterTransactions(transactions, query)
    .slice()
    .sort((a, b) => String(b.txn_date).localeCompare(String(a.txn_date)));
  return { destinations: matchedDestinations, transactions: matched.slice(0, limit), transactionTotal: matched.length };
}

// ─── ALERTS ────────────────────────────────────────────────────
// The header's notification bell. Each alert is a live condition computed
// from the founder's data, not a stored message: it appears while the
// condition holds and disappears once it is resolved. `section` is where
// the founder goes to act on it.
export function buildAlerts({
  hasData = false, missedObligations = [], currentDirective = null,
  needsAcknowledgement = false, latestDirective = null, lastTxnDate = null,
  today, showForwardRunway = false, forwardRunway = null, directives = [], currency = "USD",
} = {}) {
  const alerts = [];
  if (!hasData) {
    alerts.push({ id: "no-data", severity: "info", title: "Connect your financial data",
      detail: "Upload a bank or accounting export to activate your metrics.", section: "transactions" });
  }
  (missedObligations || []).forEach(m => alerts.push({
    id: `missed-${m.normalized_key || m.label}`, severity: "critical",
    title: `${m.label} has not appeared`, detail: m.message, section: "forecasts",
  }));
  if (currentDirective?.severity === "critical") {
    alerts.push({ id: `directive-${currentDirective.rule}`, severity: "critical",
      title: currentDirective.text, detail: "This week's directive.", section: "dashboard" });
  }
  if (showForwardRunway && forwardRunway?.crossesZero) {
    alerts.push({ id: "forward-runway", severity: "warning",
      title: `Cash runs out around ${forwardRunway.crossDate} against known bills`,
      detail: `${forwardRunway.monthsUntilCross} months, counting recurring obligations on their real dates.`,
      section: "forecasts" });
  }
  if (needsAcknowledgement && latestDirective) {
    alerts.push({ id: `ack-${latestDirective.id}`, severity: "warning",
      title: "Did you act on your last directive?", detail: latestDirective.directive_text, section: "decisions" });
  }
  if (lastTxnDate && today) {
    const days = daysBetween(lastTxnDate, today);
    if (days > CONFIDENCE_RECENCY_DAYS) {
      alerts.push({ id: "stale-data", severity: "warning", title: `Latest transaction is ${days} days old`,
        detail: "Confidence in every metric is reduced until you upload a recent export.", section: "transactions" });
    }
  }
  if (today) {
    (directives || [])
      .filter(d => d.outcome_at && daysBetween(String(d.outcome_at).slice(0, 10), today) <= 14)
      .forEach(d => alerts.push({ id: `outcome-${d.id}`, severity: "info", title: "Directive outcome measured",
        detail: `"${d.directive_text}": ${describeDirectiveOutcome(d, currency).message}`, section: "decisions" }));
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ─── REPORT EXPORT ─────────────────────────────────────────────
// The Reports page's CSV: the monthly profit-and-loss table plus the metric
// summary, exactly as shown on screen. Text cells that a spreadsheet would
// execute as a formula (=, +, -, @) are prefixed with an apostrophe;
// numbers are written as numbers.
function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "";
  let s = String(v);
  const isFormattedNumber = /^-?\$?[\d,]+(\.\d+)?%?$/.test(s);
  if (/^[=+\-@\t\r]/.test(s) && !isFormattedNumber) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildReportCsv({ title = "Command Ledger financial summary", periodLabel = "", generatedAt = "", rows = [], summary = [], currency = "USD" } = {}) {
  // Every amount in the file is in one currency, named in its own row and in
  // each money column, so a spreadsheet total can never mix currencies.
  const unit = currency || "no currency chosen";
  const lines = [[title], ["Period", periodLabel], ["Currency", unit], ["Generated", generatedAt], [],
    ["Month", `Revenue (${unit})`, `Expenses (${unit})`, `Net (${unit})`, "Margin %"]];
  let rev = 0, exp = 0;
  (rows || []).forEach(r => {
    const net = (r.revenue || 0) - (r.expenses || 0);
    rev += r.revenue || 0; exp += r.expenses || 0;
    lines.push([monthLabel(r), r.revenue || 0, r.expenses || 0, net, r.revenue > 0 ? (net / r.revenue) * 100 : ""]);
  });
  lines.push(["Total", rev, exp, rev - exp, rev > 0 ? ((rev - exp) / rev) * 100 : ""]);
  lines.push([], ["Metric", "Value"]);
  (summary || []).forEach(([label, value]) => lines.push([label, value]));
  return lines.map(cols => cols.map(csvCell).join(",")).join("\r\n");
}
