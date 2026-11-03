import { describe, it, expect } from "vitest";
import {
  fmt, fmtCompact, currencySymbol, currencyName, isSupportedCurrency, partitionByCurrency, currencyCode,
  parseAmount, detectDecimalStyle, parseAnyCSV, parseTransactions, computeMetrics, detectTrends,
  checkAffordability, computeDirective, describeDirectiveOutcome, buildReportCsv,
} from "./financials.js";

// Intl writes South African amounts with non-breaking spaces; tests compare
// against plain spaces so the expectations stay readable.
const plain = s => s.replace(/[  ]/g, " ");

describe("money formatting", () => {
  it("keeps US dollar output exactly as before", () => {
    expect(fmt(1250)).toBe("$1,250");
    expect(fmt(1250, "USD")).toBe("$1,250");
    expect(fmt(-98765.4, "USD")).toBe("-$98,765");
    expect(fmtCompact(1234567, "USD")).toBe("$1.2M");
    expect(fmtCompact(99999, "USD")).toBe("$99,999");
  });

  it("writes rand the South African way", () => {
    expect(plain(fmt(1234567.89, "ZAR"))).toBe("R 1 234 568");
    expect(plain(fmt(-98765, "ZAR"))).toBe("-R 98 765");
    expect(plain(fmt(0, "ZAR"))).toBe("R 0");
    expect(plain(fmtCompact(1234567, "ZAR"))).toBe("R 1,2M");
    expect(plain(fmtCompact(99999, "ZAR"))).toBe("R 99 999");
  });

  it("prints a bare number, never a guessed symbol, when no currency is chosen", () => {
    expect(fmt(1250, null)).toBe("1,250");
  });

  it("names the code instead of borrowing another currency's symbol", () => {
    expect(fmt(1234, "EUR")).toBe("€1,234");
    expect(fmt(1234, "XYZ")).toMatch(/^(XYZ|¤)/);
  });

  it("knows each supported currency's symbol and name", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("ZAR")).toBe("R");
    expect(currencySymbol(null)).toBe("");
    expect(currencyName("ZAR")).toBe("South African rand");
    expect(isSupportedCurrency("ZAR")).toBe(true);
    expect(isSupportedCurrency("EUR")).toBe(false);
  });
});

describe("parseAmount", () => {
  const cases = [
    // [input, decimal style, value, currency]
    ["$1,234.56", "dot", 1234.56, "USD"],
    ["R1,234.56", "dot", 1234.56, "ZAR"],
    ["R1 234.56", "dot", 1234.56, "ZAR"],
    ["1 234,56", "comma", 1234.56, null],
    ["R 1 234,56", "comma", 1234.56, "ZAR"],
    ["1.234,56", "comma", 1234.56, null],
    ["250,75", "comma", 250.75, null],
    ["-R 1 234,56", "comma", -1234.56, "ZAR"],
    ["R-1234.50", "dot", -1234.5, "ZAR"],
    ["(1,234.56)", "dot", -1234.56, null],
    ["1234.56-", "dot", -1234.56, null],
    ["1,234.56 Cr", "dot", 1234.56, null],
    ["1,000.00 Dr", "dot", -1000, null],
    ["1 000,00Dr", "comma", -1000, null],
    ["1,234.56 CR", "dot", 1234.56, null],
    ["ZAR 1500.00", "dot", 1500, "ZAR"],
    ["USD 1500.00", "dot", 1500, "USD"],
    ["1500.00 USD", "dot", 1500, "USD"],
    ["US$500", "dot", 500, "USD"],
    ["R$500", "dot", 500, "BRL"],
    ["€1.234,56", "comma", 1234.56, "EUR"],
    [" R 1 234,56", "comma", 1234.56, "ZAR"],
    ["1500", "dot", 1500, null],
    ["-42", "dot", -42, null],
  ];
  it.each(cases)("reads %j (%s decimals)", (input, style, value, currency) => {
    const a = parseAmount(input, style);
    expect(a.ok).toBe(true);
    expect(a.value).toBeCloseTo(value, 6);
    expect(a.currency).toBe(currency);
  });

  it("treats an empty cell as zero, and flags text that is not a number", () => {
    expect(parseAmount("", "dot")).toEqual({ value: 0, currency: null, ok: true });
    expect(parseAmount("-", "dot").ok).toBe(true);
    expect(parseAmount("N/A", "dot").ok).toBe(false);
    expect(parseAmount("1.234.567", "dot").ok).toBe(false);
  });

  it("reads a Currency column's value as an ISO code", () => {
    expect(currencyCode("zar")).toBe("ZAR");
    expect(currencyCode(" USD ")).toBe("USD");
    expect(currencyCode("R")).toBe("ZAR");
    expect(currencyCode("$")).toBe("USD");
    expect(currencyCode("rand")).toBe(null);
  });
});

describe("detectDecimalStyle", () => {
  it("settles a column from the values that can only be read one way", () => {
    expect(detectDecimalStyle(["1 234,56", "250,75", "18 500,00"])).toBe("comma");
    expect(detectDecimalStyle(["1.234,56", "12,00"])).toBe("comma");
    expect(detectDecimalStyle(["1,234.56", "250.75"])).toBe("dot");
    expect(detectDecimalStyle(["1,234,567", "1,234"])).toBe("dot");
    expect(detectDecimalStyle(["1.234.567", "1.234"])).toBe("comma");
  });

  it("keeps the old dot reading when every value fits both", () => {
    expect(detectDecimalStyle(["1,234", "5,600", "12"])).toBe("dot");
    expect(detectDecimalStyle(["", "-", "1500"])).toBe("dot");
  });
});

// A South African bank export written the South African way: semicolons
// between fields, comma decimals, spaces between thousands, and Cr/Dr for
// direction. Hand-computed: money in 18 500 + 9 600,50 + 18 500 = 46 600,50;
// money out 14 200 + 1 240,25 + 14 200 + 1 310,75 = 30 951.
const ZAR_BANK_CSV = `Date;Description;Amount
2026-04-03;Acme retainer;18 500,00 Cr
2026-04-08;AWS hosting;1 240,25 Dr
2026-04-12;Payroll run;14 200,00 Dr
2026-04-18;Bolt Studio project;9 600,50 Cr
2026-05-02;Acme retainer;18 500,00 Cr
2026-05-09;AWS hosting;1 310,75 Dr
2026-05-12;Payroll run;14 200,00 Dr`;

describe("parsing a South African export", () => {
  it("reads every amount at its true size and direction", () => {
    const { transactions, unreadable } = parseTransactions(ZAR_BANK_CSV, { currency: "ZAR" });
    expect(unreadable).toBe(0);
    expect(transactions.map(t => t.amount)).toEqual([18500, -1240.25, -14200, 9600.5, 18500, -1310.75, -14200]);
    expect(transactions.every(t => t.currency === "ZAR")).toBe(true);
    const moneyIn = transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const moneyOut = transactions.filter(t => t.amount < 0).reduce((s, t) => s - t.amount, 0);
    expect(moneyIn).toBeCloseTo(46600.5, 6);
    expect(moneyOut).toBeCloseTo(30951, 6);
  });

  it("builds the same monthly totals in parseAnyCSV", () => {
    const result = parseAnyCSV(ZAR_BANK_CSV, { currency: "ZAR" });
    expect(result.currency).toBe("ZAR");
    expect(result.rows.map(r => [r.revenue, r.expenses])).toEqual([[28101, 15440], [18500, 15511]]);
  });

  it("produces ZAR metrics and messages from the same engine", () => {
    const rows = parseAnyCSV(ZAR_BANK_CSV, { currency: "ZAR" }).rows;
    const m = computeMetrics(rows, { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 }, "safe", { currency: "ZAR" });
    expect(m.totRev).toBe(46601);
    expect(m.totExp).toBe(30951);
    expect(plain(fmt(m.totPro, "ZAR"))).toBe("R 15 650");
  });
});

describe("files that mix currencies", () => {
  const MIXED = `Date,Description,Amount
2026-04-03,Local client,R18500.00
2026-04-04,US client,$1000.00
2026-04-08,Rent,R-6000.00
2026-04-09,Unlabelled fee,-250.00`;

  it("never adds two currencies together", () => {
    const result = parseAnyCSV(MIXED, { currency: "ZAR" });
    expect(result.rows[0].revenue).toBe(18500);
    expect(result.rows[0].expenses).toBe(6250);
    expect(result.excluded).toEqual([{ currency: "USD", count: 1 }]);
  });

  it("follows the currency most rows declare when the caller names none", () => {
    expect(parseAnyCSV(MIXED).currency).toBe("ZAR");
  });

  it("keeps each transaction's own currency, defaulting unmarked rows to the file's", () => {
    const { transactions } = parseTransactions(MIXED, { currency: "ZAR" });
    expect(transactions.map(t => t.currency)).toEqual(["ZAR", "USD", "ZAR", "ZAR"]);
    expect(transactions.map(t => t.amount)).toEqual([18500, 1000, -6000, -250]);
  });

  it("reads a Currency column", () => {
    const csv = `Date,Description,Amount,Currency
2026-04-03,Client,1500.00,USD
2026-04-04,Client,2500.00,ZAR`;
    expect(parseTransactions(csv, { currency: "ZAR" }).transactions.map(t => t.currency)).toEqual(["USD", "ZAR"]);
  });

  it("leaves the currency unknown rather than guessing it", () => {
    const csv = `Date,Description,Amount
2026-04-03,Client,1500.00`;
    expect(parseTransactions(csv).transactions[0].currency).toBe(null);
    expect(parseAnyCSV(csv).currency).toBe(null);
  });
});

describe("partitionByCurrency", () => {
  const txns = [
    { amount: 100, currency: "ZAR" }, { amount: 50, currency: "USD" },
    { amount: 70, currency: "ZAR" }, { amount: 20, currency: "USD" }, { amount: 5, currency: null },
  ];
  it("computes from the base currency only and counts the rest", () => {
    const p = partitionByCurrency(txns, "ZAR");
    expect(p.included.map(t => t.amount)).toEqual([100, 70]);
    expect(p.excluded).toEqual([{ currency: "USD", count: 2 }, { currency: "unlabelled", count: 1 }]);
    expect(p.excludedTotal).toBe(3);
  });
  it("includes nothing until a base currency is chosen", () => {
    expect(partitionByCurrency(txns, null).included).toEqual([]);
  });
});

describe("messages carry the business currency", () => {
  it("checkAffordability", () => {
    const r = checkAffordability({ currentCash: 0, avgRev: 50000, avgExp: 30000, obligations: [], monthlyCost: 10000, fromDate: "2026-06-01", currency: "ZAR" });
    expect(plain(r.message)).toContain("(R 20 000)");
  });
  it("computeDirective", () => {
    const d = computeDirective({ margin: -5, burnMonths: 2, free: -12000, vel: 0, conv: 0, ltvcac: 0, months: 3, concentration: null, currency: "ZAR" });
    expect(plain(d.reason)).toContain("-R 12 000");
  });
  it("describeDirectiveOutcome", () => {
    const out = describeDirectiveOutcome({ target_metric: "free", metric_at_issue: 1000, outcome_metric: 2500 }, "ZAR");
    expect(plain(out.message)).toBe("True Free Cash moved from R 1 000 to R 2 500.");
  });
  it("detectTrends uses each currency's own materiality floor", () => {
    // Net burn of 3 000 a month, then 9 000: a 6 000 move. Material in
    // dollars (floor 500), not in rand (floor 10 000).
    const rows = [
      { revenue: 10000, expenses: 13000 }, { revenue: 10000, expenses: 13000 },
      { revenue: 10000, expenses: 13000 }, { revenue: 10000, expenses: 19000 },
    ];
    expect(detectTrends(rows, null, "USD").some(t => t.type === "burn")).toBe(true);
    expect(detectTrends(rows, null, "ZAR").some(t => t.type === "burn")).toBe(false);
  });
  it("the report CSV names its currency in a row and in every money column", () => {
    const csv = buildReportCsv({ rows: [{ month: "Apr 26", revenue: 100, expenses: 40 }], currency: "ZAR" });
    expect(csv).toContain("Currency,ZAR");
    expect(csv).toContain("Month,Revenue (ZAR),Expenses (ZAR),Net (ZAR),Margin %");
  });
});

describe("a separate Dr/Cr column", () => {
  it("signs unsigned amounts by their direction, and leaves blank directions as written", () => {
    const csv = `Date,Description,Amount,Dr/Cr
2026-04-03,Client,"1,500.00",Cr
2026-04-04,Rent,800.00,Dr
2026-04-05,Fee,-25.00,
2026-04-06,Refund,40.00,C`;
    expect(parseTransactions(csv, { currency: "ZAR" }).transactions.map(t => t.amount)).toEqual([1500, -800, -25, 40]);
    // The refund is money back on a cost, so it lowers expenses instead of
    // counting as revenue: 800 + 25 - 40.
    const monthly = parseAnyCSV(csv, { currency: "ZAR" }).rows[0];
    expect([monthly.revenue, monthly.expenses]).toEqual([1500, 785]);
  });

  it("reads the common header and value spellings", () => {
    const csv = `Date,Description,Amount,Debit/Credit
2026-04-03,Client,1500.00,Credit
2026-04-04,Rent,800.00,Debit
2026-04-05,Stock,300.00,DR.`;
    expect(parseTransactions(csv).transactions.map(t => t.amount)).toEqual([1500, -800, -300]);
  });
});
