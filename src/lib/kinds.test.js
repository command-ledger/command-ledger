// Transaction kinds: transfers, loans and owner money, and refunds are kept
// out of revenue and costs. Every expected figure below is worked out by
// hand in the comment beside it.
import { describe, it, expect } from "vitest";
import {
  TRANSACTION_KINDS, classifyTransaction, classificationKey, buildRuleIndex, resolveKind, transactionKind,
  summarizeKinds, aggregateTransactionsByMonth, computeMetrics, computeRevenueConcentration,
  detectRecurringObligations, computeForwardRunway, checkAffordability, applyScenario, detectTrends, parseAnyCSV,
} from "./financials.js";

const NO_MANUAL = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };

describe("classifyTransaction", () => {
  it("knows exactly four kinds", () => {
    expect(TRANSACTION_KINDS).toEqual(["operating", "transfer", "financing", "refund"]);
  });

  it.each([
    "Transfer to own account",
    "IB TRANSFER TO OWN A/C 1234",
    "Internal Transfer",
    "FNB App Transfer To Savings",
    "Inter-account transfer",
    "Inter account transfer",
    "Transfer between accounts",
    "Online Transfer to SAV ...1234 Transaction#: 556677",
    "Online Banking transfer to CHK 5678 Confirmation# 123",
    "Transfer from Main Account",
    "Savings transfer",
    "Auto sweep to call account",
  ])("reads %s as a transfer between the business's own accounts", d => {
    expect(classifyTransaction(d)).toBe("transfer");
  });

  it.each([
    ["Transfer from Coastal Retail Group", "a customer paying by transfer"],
    ["IB transfer to 62012345", "an unnamed account, as likely a supplier"],
    ["Stripe transfer", "a card processor paying out sales"],
    ["Shopify Payout", "a processor paying out sales"],
    ["Wire transfer from First Savings Bank", "a customer whose bank has Savings in its name"],
    ["Transfer from SAV Logistics", "a company whose name starts with SAV"],
    ["Interest on savings", "interest earned"],
    ["Clean Sweep Services", "a supplier with sweep in its name"],
  ])("keeps %s as operating (%s)", d => {
    expect(classifyTransaction(d)).toBe("operating");
  });

  it.each([
    "Loan repayment",
    "LULALEND",
    "Business loan advance",
    "SBA EIDL LOAN PAYMENT",
    "PAYPAL WORKING CAPITAL",
    "Shopify Capital",
    "Capital injection - J Smith",
    "Owner's draw",
    "Drawings - J Smith",
    "Director drawings",
    "Members drawings",
    "Dividend paid",
    "Internal transfer to loan account",
  ])("reads %s as a loan or owner money", d => {
    expect(classifyTransaction(d)).toBe("financing");
  });

  it.each([
    ["Payment from Lakeside Loans", "a lender paying an invoice is a customer"],
    ["Technical Drawings Ltd", "a drafting supplier"],
    ["Loan interest", "interest is a cost of borrowing"],
    ["Loan admin fee", "a fee is a cost"],
    ["Sterling Savings and Loan wire", "a customer's bank name"],
  ])("keeps %s as operating (%s)", d => {
    expect(classifyTransaction(d)).toBe("operating");
  });

  it.each(["Refund - Order 1234", "Debit order reversal", "Chargeback", "SARS refund", "Returned debit", "Fee reversal"])(
    "reads %s as a refund", d => {
      expect(classifyTransaction(d)).toBe("refund");
    });

  it.each(["Client Payment - Coastal Retail Group", "Salary J Smith", "Rent - March", "AWS hosting", "", null, undefined])(
    "keeps %s as operating", d => {
      expect(classifyTransaction(d)).toBe("operating");
    });
});

describe("classificationKey", () => {
  it("ignores case, punctuation and reference numbers", () => {
    expect(classificationKey("Loan repayment 0123")).toBe("loan repayment");
    expect(classificationKey("LOAN REPAYMENT #0456")).toBe("loan repayment");
    expect(classificationKey("Online Transfer to SAV ...1234 Transaction#: 5566")).toBe("online transfer to sav transaction");
  });

  it("has no key for a description of digits only, or none at all", () => {
    expect(classificationKey("12345")).toBe("");
    expect(classificationKey(null)).toBe("");
  });

  it("caps a very long description at 200 characters", () => {
    expect(classificationKey("a".repeat(500))).toHaveLength(200);
  });
});

describe("rules the founder sets", () => {
  const loanStar  = { dedupe_hash: "h1", description: "Loan Star Ltd payment 4411", amount: 5000 };
  const loanStar2 = { dedupe_hash: "h2", description: "Loan Star Ltd payment 4412", amount: 6000 };

  it("reads the description when no rule applies", () => {
    expect(resolveKind(loanStar, null)).toEqual({ kind: "financing", source: "auto" });
  });

  it("applies a rule to every transaction described alike", () => {
    const rules = buildRuleIndex([{ scope: "similar", match_key: classificationKey(loanStar.description), kind: "operating" }]);
    expect(resolveKind(loanStar, rules)).toEqual({ kind: "operating", source: "similar" });
    expect(resolveKind(loanStar2, rules)).toEqual({ kind: "operating", source: "similar" });
  });

  it("lets a rule for one transaction win over a rule for all like it", () => {
    const rules = buildRuleIndex([
      { scope: "similar", match_key: "loan star ltd payment", kind: "operating" },
      { scope: "single", match_key: "h2", kind: "financing" },
    ]);
    expect(transactionKind(loanStar, rules)).toBe("operating");
    expect(resolveKind(loanStar2, rules)).toEqual({ kind: "financing", source: "single" });
  });

  it("ignores a rule with an unknown kind or scope, and never reads a built-in property", () => {
    const rules = buildRuleIndex([
      { scope: "similar", match_key: "loan star ltd payment", kind: "revenue" },
      { scope: "everything", match_key: "loan star ltd payment", kind: "operating" },
      null,
    ]);
    expect(resolveKind(loanStar, rules).source).toBe("auto");
    expect(resolveKind({ description: "constructor", amount: 10 }, buildRuleIndex([]))).toEqual({ kind: "operating", source: "auto" });
    expect(resolveKind({ description: "__proto__", amount: 10 }, buildRuleIndex([]))).toEqual({ kind: "operating", source: "auto" });
  });

  it("accepts rule rows as stored, as well as a built index", () => {
    expect(transactionKind(loanStar, [{ scope: "single", match_key: "h1", kind: "transfer" }])).toBe("transfer");
  });
});

describe("summarizeKinds", () => {
  it("counts each kind and its money in and out", () => {
    const s = summarizeKinds([
      { description: "Client invoice", amount: 1000 },
      { description: "Loan advance", amount: 50000 },
      { description: "Loan repayment", amount: -2500.5 },
      { description: "Transfer to savings", amount: -3000 },
      { description: "Refund to customer", amount: -200 },
    ]);
    expect(s.operating).toEqual({ count: 1, moneyIn: 1000, moneyOut: 0 });
    expect(s.financing).toEqual({ count: 2, moneyIn: 50000, moneyOut: 2500.5 });
    expect(s.transfer).toEqual({ count: 1, moneyIn: 0, moneyOut: 3000 });
    expect(s.refund).toEqual({ count: 1, moneyIn: 0, moneyOut: 200 });
  });
});

describe("monthly figures by kind", () => {
  const march = [
    { txn_date: "2026-03-02", description: "Client invoice Acme",    amount: 20000,  category: null },
    { txn_date: "2026-03-03", description: "Business loan advance",  amount: 100000, category: null },
    { txn_date: "2026-03-05", description: "Payroll run",            amount: -12000, category: "payroll" },
    { txn_date: "2026-03-06", description: "Facebook Ads",           amount: -3000,  category: "marketing" },
    { txn_date: "2026-03-10", description: "Loan repayment",         amount: -4000,  category: "other" },
    { txn_date: "2026-03-12", description: "Transfer to savings",    amount: -10000, category: "other" },
    { txn_date: "2026-03-15", description: "Refund to customer Acme", amount: -500,  category: "other" },
    { txn_date: "2026-03-20", description: "Facebook ads refund",    amount: 1000,   category: null },
    { txn_date: "2026-03-25", description: "Transfer from savings",  amount: 2000,   category: null },
  ];

  it("keeps a loan, transfers and refunds out of revenue and costs", () => {
    const [row] = aggregateTransactionsByMonth(march);
    expect(row).toMatchObject({
      revenue: 19500,      // 20,000 invoice less the 500 refunded to the customer
      expenses: 14000,     // 12,000 payroll + 3,000 ads, less the 1,000 ads refund
      payroll: 12000,
      marketing: 2000,     // 3,000 ads less the 1,000 refunded
      financingIn: 100000, financingOut: 4000,
      transferIn: 2000,    transferOut: 10000,
      refundsIn: 1000,     refundsOut: 500,
    });
  });

  it("computes margin from operating money only, and burn from everything that leaves the bank", () => {
    const m = computeMetrics(aggregateTransactionsByMonth(march), NO_MANUAL, "safe");
    expect(m.margin).toBeCloseTo((5500 / 19500) * 100, 6); // 28.2%; counting the loan and transfers as revenue read 76%
    expect(m.totFinIn).toBe(100000);
    expect(m.totFinOut).toBe(4000);
    expect(m.avgCashOut).toBe(18000);   // 14,000 costs + 4,000 loan repayment
    expect(m.netBurn).toBe(-1500);      // 18,000 out less 19,500 revenue
    expect(m.cashFlowPositive).toBe(true);
    expect(m.hiringCapacity).toBeCloseTo(1200, 6); // (19,500 - 18,000) x (1 - 0.20)
  });

  it("follows the founder's rules", () => {
    // The founder says the "loan" is a customer called Loan Star, not a loan.
    const rules = [{ scope: "similar", match_key: "business loan advance", kind: "operating" }];
    const [row] = aggregateTransactionsByMonth(march, { rules });
    expect(row.revenue).toBe(119500);
    expect(row.financingIn).toBe(0);
  });

  it("leaves a category at zero when a refund is larger than the month's spend in it", () => {
    const [row] = aggregateTransactionsByMonth([
      { txn_date: "2026-03-20", description: "Facebook ads refund", amount: 1000, category: null },
    ]);
    expect(row.marketing).toBe(0);
    expect(row.expenses).toBe(-1000); // the money back is still counted in full
  });

  it("never prints a negative zero", () => {
    const [row] = aggregateTransactionsByMonth([
      { txn_date: "2026-03-01", description: "Sale", amount: 10.2 },
      { txn_date: "2026-03-02", description: "Refund to customer", amount: -10.4 },
    ]);
    expect(Object.is(row.revenue, 0)).toBe(true); // Math.round(-0.2) is -0
  });
});

describe("loan repayments and owner withdrawals in the metrics", () => {
  const months = [
    { period_month: "2026-01-01", revenue: 10000, expenses: 8000, financingOut: 5000 },
    { period_month: "2026-02-01", revenue: 10000, expenses: 8000, financingOut: 5000 },
  ];

  it("count toward burn and runway but not toward costs or margin", () => {
    const m = computeMetrics(months, { ...NO_MANUAL, mCash: 30000 }, "safe");
    expect(m.margin).toBeCloseTo(20, 6);           // (20,000 - 16,000) / 20,000
    expect(m.netBurn).toBe(3000);                  // 8,000 + 5,000 - 10,000
    expect(m.cashFlowPositive).toBe(false);
    expect(m.burnMonths).toBeCloseTo(10, 6);       // 30,000 / 3,000
    expect(m.hiringCapacity).toBe(0);              // nothing left after the repayments
  });

  it("leave history without them exactly as it was", () => {
    const plain = months.map(({ financingOut, ...r }) => r);
    const m = computeMetrics(plain, { ...NO_MANUAL, mCash: 30000 }, "safe");
    expect(m.netBurn).toBe(-2000);                 // 8,000 - 10,000
    expect(m.hiringCapacity).toBeCloseTo(1600, 6); // 2,000 x 0.8
  });

  it("make the burn trend worsen when repayments start", () => {
    const rows = [
      { revenue: 10000, expenses: 9000 },
      { revenue: 10000, expenses: 9000 },
      { revenue: 10000, expenses: 9000, financingOut: 6000 }, // burn 5,000 against a -1,000 average
    ];
    expect(detectTrends(rows).find(t => t.type === "burn")).toMatchObject({ direction: "worsening" });
  });

  it("carry through a scenario", () => {
    const manual = applyScenario({ revenue: 10000, expenses: 8000, cash: 50000, financingOut: 3000 }, {});
    expect(manual.mFinOut).toBe(3000);
    const m = computeMetrics(null, manual, "safe");
    expect(m.margin).toBeCloseTo(20, 6);
    expect(m.netBurn).toBe(1000);                  // 8,000 + 3,000 - 10,000
    expect(m.burnMonths).toBeCloseTo(50, 6);       // 50,000 / 1,000
  });

  it("run the forward cash simulation down", () => {
    const base = { currentCash: 10010, avgRev: 5000, avgExp: 4000, obligations: [], fromDate: "2026-05-01", horizonDays: 365 };
    expect(computeForwardRunway(base).crossesZero).toBe(false); // +1,000 a month
    // -1,000 a month, so 10,010 lasts 300.3 days: the first day below zero is day 301.
    const withRepayments = computeForwardRunway({ ...base, avgFinOut: 2000 });
    expect(withRepayments.crossesZero).toBe(true);
    expect(withRepayments.daysUntilCross).toBe(301);
  });

  it("are taken out before saying whether profit covers a new cost", () => {
    const args = { currentCash: 0, avgRev: 10000, avgExp: 6000, obligations: [], monthlyCost: 2000, fromDate: "2026-05-01", currency: "USD" };
    expect(checkAffordability(args)).toMatchObject({ affordable: true, message: expect.stringContaining("average monthly profit ($4,000)") });
    const r = checkAffordability({ ...args, avgFinOut: 3000 });
    expect(r.affordable).toBe(false);
    expect(r.message).toContain("average monthly profit after loan repayments and owner withdrawals ($1,000)");
  });
});

describe("client concentration counts customers only", () => {
  const txns = [
    { description: "Client Payment - Coastal Retail", amount: 6000 },
    { description: "Client Payment - Bolt Studio",    amount: 4000 },
    { description: "Business loan advance",           amount: 100000 },
    { description: "Transfer from savings",           amount: 5000 },
    { description: "Supplier refund",                 amount: 300 },
  ];

  it("leaves out the loan, the transfer and the refund", () => {
    const c = computeRevenueConcentration(txns);
    expect(c.totalRevenue).toBe(10000);
    expect(c.distinctPayers).toBe(2);
    expect(c.largestPct).toBeCloseTo(60, 6);
    expect(c.payers.map(p => p.name)).toEqual(["coastal retail", "bolt studio"]);
  });

  it("follows the founder's rules", () => {
    const c = computeRevenueConcentration(txns, [{ scope: "similar", match_key: classificationKey("Client Payment - Bolt Studio"), kind: "financing" }]);
    expect(c.totalRevenue).toBe(6000);
    expect(c.payers).toHaveLength(1);
  });
});

describe("recurring bills", () => {
  const monthly = (description, day, amount) => ["01", "02", "03", "04"].map(mm => ({
    txn_date: `2026-${mm}-${day}`, description, amount, category: null,
  }));
  const txns = [...monthly("Rent", "02", -8000), ...monthly("Loan repayment", "05", -2000), ...monthly("Transfer to savings", "01", -5000)];

  it("include loan repayments but never a transfer to savings", () => {
    const labels = detectRecurringObligations(txns, { asOf: "2026-04-30" }).map(o => o.label).sort();
    expect(labels).toEqual(["Loan repayment", "Rent"]);
  });

  it("follow the founder's rules", () => {
    const rules = [{ scope: "similar", match_key: "loan repayment", kind: "transfer" }];
    const labels = detectRecurringObligations(txns, { asOf: "2026-04-30", rules }).map(o => o.label);
    expect(labels).toEqual(["Rent"]);
  });
});

describe("parseAnyCSV", () => {
  const csv = `Date,Description,Amount
2026-04-01,Client invoice,10000
2026-04-02,Business loan advance,50000
2026-04-03,Transfer to savings,-20000
2026-04-04,Rent,-4000`;

  it("previews a file with its loans and transfers kept apart", () => {
    const [row] = parseAnyCSV(csv).rows;
    expect(row).toMatchObject({ revenue: 10000, expenses: 4000, financingIn: 50000, transferOut: 20000 });
  });

  it("passes the founder's rules through", () => {
    const [row] = parseAnyCSV(csv, { rules: [{ scope: "similar", match_key: "business loan advance", kind: "operating" }] }).rows;
    expect(row.revenue).toBe(60000);
  });
});
