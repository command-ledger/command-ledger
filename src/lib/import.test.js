import { describe, it, expect } from "vitest";
import {
  parseTransactions, parseAnyCSV, decodeTextFile, detectDateOrder, parseDateValue, parseMonthValue,
  dedupeHashInput, computeDedupeHash,
} from "./financials.js";

// Every case here is a file shape a real export produces. Each one used to
// be misread or rejected; the audit of 2026-11-03 reproduced them all.
const amounts = r => r.transactions.map(t => t.amount);
const dates = r => r.transactions.map(t => t.txn_date);

describe("dates", () => {
  it("reads a US file month first, decided by the column's own values", () => {
    const r = parseTransactions("Date,Description,Amount\n03/05/2026,Client A,1000\n03/15/2026,Client B,2000\n12/31/2026,Client C,3000");
    expect(dates(r)).toEqual(["2026-03-05", "2026-03-15", "2026-12-31"]);
    expect(r.dateOrder).toMatchObject({ order: "mdy", resolved: true });
  });

  it("reads a South African file day first", () => {
    const r = parseTransactions("Date,Description,Amount\n05/03/2026,Client A,1000\n15/03/2026,Client B,2000");
    expect(dates(r)).toEqual(["2026-03-05", "2026-03-15"]);
    expect(r.dateOrder).toMatchObject({ order: "dmy", resolved: true });
  });

  it("reads an ambiguous column day first and says it could not tell", () => {
    const r = parseTransactions("Date,Description,Amount\n05/03/2026,Client A,1000\n06/04/2026,Client B,2000");
    expect(dates(r)).toEqual(["2026-03-05", "2026-04-06"]);
    expect(r.dateOrder).toMatchObject({ order: "dmy", resolved: false, numeric: true });
  });

  it("never produces an impossible date, and counts the rows it skips", () => {
    const r = parseTransactions("Date,Description,Amount\n31/02/2026,Bad date,100\n2026-02-28,Good,200\nyesterday,Words,300\n2026-13-01,Bad month,400");
    expect(dates(r)).toEqual(["2026-02-28"]);
    expect(r.skippedDates).toBe(3);
  });

  it("reads dotted, two-digit-year, compact, named-month and timestamped dates", () => {
    expect(parseDateValue("05.03.2026")).toBe("2026-03-05");
    expect(parseDateValue("05/03/26")).toBe("2026-03-05");
    expect(parseDateValue("20261005")).toBe("2026-10-05");
    expect(parseDateValue("5 Jan 2026")).toBe("2026-01-05");
    expect(parseDateValue("05-Jan-26")).toBe("2026-01-05");
    expect(parseDateValue("Jan 5, 2026")).toBe("2026-01-05");
    expect(parseDateValue("September 30 2026")).toBe("2026-09-30");
    expect(parseDateValue("2026-03-01 14:22:11")).toBe("2026-03-01");
    expect(parseDateValue("03/15/2026", "dmy")).toBeNull();
    expect(parseDateValue("03/15/2026", "mdy")).toBe("2026-03-15");
  });

  it("reads months on their own for monthly summaries", () => {
    expect(parseMonthValue("2026-07")).toBe("2026-07");
    expect(parseMonthValue("07/2026")).toBe("2026-07");
    expect(parseMonthValue("Jul 2026")).toBe("2026-07");
    expect(parseMonthValue("July-26")).toBe("2026-07");
    expect(parseMonthValue("13/2026")).toBeNull();
  });

  it("decides the order from the whole column", () => {
    expect(detectDateOrder(["01/02/2026", "13/02/2026"])).toMatchObject({ order: "dmy", resolved: true, conflicting: false });
    expect(detectDateOrder(["01/02/2026", "02/13/2026"])).toMatchObject({ order: "mdy", resolved: true });
    expect(detectDateOrder(["13/02/2026", "02/13/2026"]).conflicting).toBe(true);
  });
});

describe("monthly Revenue/Expenses summaries", () => {
  const SUMMARY = "Month,Revenue,Expenses\n2026-07,120000,90000\n2026-08,125000,95000\nSep 2026,118000,99000";

  it("can be saved: one revenue and one expense record per month, dated the first", () => {
    const r = parseTransactions(SUMMARY, { currency: "ZAR" });
    expect(r.mode).toBe("named");
    expect(r.transactions.map(t => [t.txn_date, t.amount])).toEqual([
      ["2026-07-01", 120000], ["2026-07-01", -90000], ["2026-08-01", 125000], ["2026-08-01", -95000], ["2026-09-01", 118000], ["2026-09-01", -99000],
    ]);
    expect(r.dateOrder.monthOnly).toBe(true);
  });

  it("produce the same monthly totals in the preview", () => {
    const rows = parseAnyCSV(SUMMARY, { currency: "ZAR" }).rows;
    expect(rows.map(x => [x.month, x.revenue, x.expenses])).toEqual([["Jul 26", 120000, 90000], ["Aug 26", 125000, 95000], ["Sep 26", 118000, 99000]]);
  });
});

describe("headers and layouts", () => {
  it("ignores the empty column a trailing comma leaves", () => {
    const r = parseTransactions("Date,Description,Amount,Balance,\n2026-10-01,Client A,1000,5000,\n2026-10-02,Rent,-400,4600,");
    expect(amounts(r)).toEqual([1000, -400]);
  });

  it("does not take a Value Date column for the amount", () => {
    const r = parseTransactions("Value Date,Description,Amount\n2026-10-01,Client A,1000\n2026-10-02,Rent,-400");
    expect(amounts(r)).toEqual([1000, -400]);
  });

  it("reads Money In / Money Out beside Posting and Value dates", () => {
    const r = parseTransactions("Posting Date,Value Date,Description,Money In,Money Out,Balance\n2026-10-01,2026-10-01,Client A,1000,,5000\n2026-10-02,2026-10-02,Rent,,400,4600");
    expect(r.mode).toBe("split");
    expect(amounts(r)).toEqual([1000, -400]);
  });

  it("reads Paid In / Paid Out and Deposit / Withdrawal", () => {
    expect(amounts(parseTransactions("Date,Details,Paid In,Paid Out\n2026-10-01,Client,1000,\n2026-10-02,Rent,,400"))).toEqual([1000, -400]);
    expect(amounts(parseTransactions("Date,Payee,Deposit,Withdrawal\n2026-10-01,Client,1000,\n2026-10-02,Rent,,400"))).toEqual([1000, -400]);
  });

  it("finds the header below a long account summary", () => {
    const preamble = "ACCOUNT HISTORY\nAccount: 6200000000\nBranch: 250655\nFrom: 2026-10-01\nTo: 2026-10-31\nCurrency: ZAR\nOpening balance: 4000\n";
    expect(amounts(parseTransactions(preamble + "Date,Description,Amount\n2026-10-01,Client A,1000\n2026-10-02,Rent,-400"))).toEqual([1000, -400]);
  });

  it("detects a semicolon file even when it opens with a title line", () => {
    const r = parseTransactions("Transactions export\nDate;Description;Amount\n2026-10-01;Client A;1 000,00\n2026-10-02;Rent;-400,00");
    expect(amounts(r)).toEqual([1000, -400]);
  });

  it("reads tab- and pipe-delimited files", () => {
    expect(amounts(parseTransactions("Date\tDescription\tAmount\n2026-10-01\tClient A\t1000\n2026-10-02\tRent\t-400"))).toEqual([1000, -400]);
    expect(amounts(parseTransactions("Date|Description|Amount\n2026-10-01|Client A|1000\n2026-10-02|Rent|-400"))).toEqual([1000, -400]);
  });

  it("keeps quoted delimiters, doubled quotes and line breaks inside a field", () => {
    const r = parseTransactions('Date,Description,Amount\n2026-10-01,"Smith, Jones ""and"" Co",1000\n2026-10-02,"Rent\nOctober",-400');
    expect(r.transactions.map(t => t.description)).toEqual(['Smith, Jones "and" Co', "Rent\nOctober"]);
    expect(amounts(r)).toEqual([1000, -400]);
  });

  it("treats a quote inside an unquoted field as a character", () => {
    const r = parseTransactions('Date,Description,Amount\n2026-10-01,27" monitor,-4000\n2026-10-02,Client,1000');
    expect(amounts(r)).toEqual([-4000, 1000]);
  });

  it("reads currency-tagged headers such as Debit_USD and Amount (ZAR)", () => {
    expect(amounts(parseTransactions("Date,Description,Debit_USD,Credit_USD\n2026-10-01,Client,0,1000\n2026-10-02,Rent,400,0"))).toEqual([1000, -400]);
    expect(amounts(parseTransactions("Date,Description,Amount (ZAR)\n2026-10-01,Client,1000\n2026-10-02,Rent,-400"))).toEqual([1000, -400]);
  });

  it("still rejects a file with no date or money columns", () => {
    expect(parseTransactions("Name,Email\nJane,jane@example.com")).toBeNull();
  });
});

describe("text encodings", () => {
  const utf16le = s => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 255; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };
  const TEXT = "Date\tDescription\tAmount\r\n2026-10-01\tClient A\t1000\r\n2026-10-02\tRent\t-400\r\n";

  it("decodes UTF-16 with a byte-order mark (Excel's Unicode Text)", () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...utf16le(TEXT)]);
    expect(amounts(parseTransactions(decodeTextFile(bytes)))).toEqual([1000, -400]);
  });

  it("decodes UTF-16 without a byte-order mark", () => {
    expect(amounts(parseTransactions(decodeTextFile(utf16le(TEXT))))).toEqual([1000, -400]);
  });

  it("decodes UTF-8 with and without a byte-order mark", () => {
    const utf8 = new TextEncoder().encode("Date,Description,Amount\n2026-10-01,Café Rosé,1000");
    expect(parseTransactions(decodeTextFile(utf8)).transactions[0].description).toBe("Café Rosé");
    expect(parseTransactions(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).transactions[0].description).toBe("Café Rosé");
  });
});

describe("identical rows on the same day", () => {
  const SALES = "Date,Description,Amount\n2026-10-01,Card sale,50.00\n2026-10-01,Card sale,50.00\n2026-10-01,Card sale,75.00\n2026-10-01,Card sale,50.00";

  it("are all kept, each with its own duplicate-upload hash", async () => {
    const t = parseTransactions(SALES).transactions;
    expect(t.map(x => x.occurrence ?? 1)).toEqual([1, 2, 1, 3]);
    const hashes = await Promise.all(t.map(computeDedupeHash));
    expect(new Set(hashes).size).toBe(4);
  });

  it("still match row for row when the same file is uploaded again", async () => {
    const first = await Promise.all(parseTransactions(SALES).transactions.map(computeDedupeHash));
    const again = await Promise.all(parseTransactions(SALES).transactions.map(computeDedupeHash));
    expect(again).toEqual(first);
  });

  it("leave the hash of a single row exactly as it was before repeats were counted", () => {
    expect(dedupeHashInput({ txn_date: "2026-10-01", description: "Card sale", amount: 50 })).toBe("2026-10-01|card sale|50.00");
  });
});

describe("closing balance", () => {
  it("is the balance after the latest transaction in an oldest-first file", () => {
    const r = parseTransactions("Date,Description,Amount,Balance\n2026-10-01,Client,1000,5000\n2026-10-02,Rent,-400,4600\n2026-10-02,Fee,-10,4590", { currency: "ZAR" });
    expect(r.closingBalance).toEqual({ amount: 4590, date: "2026-10-02", currency: "ZAR" });
  });

  it("is the balance after the latest transaction in a newest-first file", () => {
    const r = parseTransactions("Date,Description,Amount,Balance\n2026-10-02,Fee,-10,4590\n2026-10-02,Rent,-400,4600\n2026-10-01,Client,1000,5000", { currency: "ZAR" });
    expect(r.closingBalance).toEqual({ amount: 4590, date: "2026-10-02", currency: "ZAR" });
  });

  it("reads an overdrawn balance marked Dr as negative", () => {
    const r = parseTransactions('Date,Description,Amount,Balance\n2026-10-01,Rent,-400,"1 200,00 Dr"', { currency: "ZAR" });
    expect(r.closingBalance.amount).toBe(-1200);
  });

  it("is absent when the file has no balance column", () => {
    expect(parseTransactions("Date,Description,Amount\n2026-10-01,Client,1000").closingBalance).toBeNull();
  });
});
