import { describe, it, expect } from "vitest";
import { detectFileCurrency, resolveFileCurrency, parseTransactions } from "./financials.js";

// A wrong currency label gives wrong figures with no warning, so each case here
// is as much about what must NOT be guessed as what must be read.

const rows = (...lines) => lines.join("\n");
const PLAIN = rows("Date,Description,Amount", "2026-10-01,Client invoice,1500.00", "2026-10-03,Office rent,-800.00");

describe("what the file states", () => {
  it("reads R on the amounts", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,Sale,R1 500.00", "2026-10-03,Rent,-R800.00"));
    expect(d).toMatchObject({ currency: "ZAR", confidence: "stated", basis: "rows" });
  });

  it("reads $ on the amounts", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,Sale,$1500.00", "2026-10-03,Rent,-$800.00"));
    expect(d).toMatchObject({ currency: "USD", confidence: "stated" });
  });

  it("reads a Currency column", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount,Currency", "2026-10-01,Sale,1500.00,ZAR", "2026-10-03,Rent,-800.00,ZAR"));
    expect(d).toMatchObject({ currency: "ZAR", confidence: "stated", basis: "rows" });
  });

  it("takes the majority and reports the rest, never merging them", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount,Currency", "2026-10-01,Sale,100,ZAR", "2026-10-02,Sale,200,ZAR", "2026-10-03,Fee,-5,USD"));
    expect(d.currency).toBe("ZAR");
    expect(d.mixed).toEqual([{ currency: "USD", count: 1 }]);
  });

  it("reads a money column's heading", () => {
    expect(detectFileCurrency(rows("Date,Description,Amount (ZAR)", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00"))).toMatchObject({ currency: "ZAR", basis: "heading" });
    expect(detectFileCurrency(rows("Date,Description,Debit USD,Credit USD", "2026-10-01,Sale,,1500.00", "2026-10-03,Rent,800.00,"))).toMatchObject({ currency: "USD", basis: "heading" });
    expect(detectFileCurrency(rows("Date,Description,Amount (R)", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00"))).toMatchObject({ currency: "ZAR", basis: "heading" });
  });

  it("does not read a currency from an unrelated heading", () => {
    expect(detectFileCurrency(rows("Date,Description,Amount,Reference R", "2026-10-01,Sale,1500.00,A1", "2026-10-03,Rent,-800.00,A2")).currency).toBeNull();
  });

  it("reads a line above the table", () => {
    expect(detectFileCurrency(rows("Account statement", "Currency: ZAR", "", "Date,Description,Amount", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00"))).toMatchObject({ currency: "ZAR", confidence: "stated", basis: "above the table" });
    expect(detectFileCurrency(rows("All amounts in South African rand", "Date,Description,Amount", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00")).currency).toBe("ZAR");
    expect(detectFileCurrency(rows("Amounts in US dollars", "Date,Description,Amount", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00")).currency).toBe("USD");
  });

  it("will not choose between two currencies named above the table", () => {
    expect(detectFileCurrency(rows("Rate: USD to ZAR 16.49", "Date,Description,Amount", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00")).currency).toBeNull();
  });

  it("does not mistake a supplier's name for a currency", () => {
    expect(detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,Rand Water,-1500.00", "2026-10-03,Randburg Stationers,-800.00")).currency).toBeNull();
  });
});

describe("what the details show", () => {
  it("reads South African details when two clues agree", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,YOCO SETTLEMENT,15000.00", "2026-10-03,ESKOM PREPAID,-800.00", "2026-10-05,Client,2000.00"));
    expect(d).toMatchObject({ currency: "ZAR", confidence: "inferred", basis: "details" });
  });

  it("trusts the file's own bank named above the table", () => {
    const d = detectFileCurrency(rows("FNB Business Account", "Date,Description,Amount", "2026-10-01,Client,15000.00", "2026-10-03,Rent,-800.00"));
    expect(d).toMatchObject({ currency: "ZAR", confidence: "inferred" });
  });

  it("reads US details the same way", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,ZELLE FROM CLIENT,1500.00", "2026-10-03,ACH DEBIT COMCAST,-80.00"));
    expect(d).toMatchObject({ currency: "USD", confidence: "inferred" });
  });

  it("will not infer from one passing mention", () => {
    expect(detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,Client,1500.00", "2026-10-03,ESKOM,-80.00")).currency).toBeNull();
  });

  it("will not infer when the details disagree", () => {
    expect(detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,YOCO,1500.00", "2026-10-02,ESKOM,-80.00", "2026-10-03,ZELLE,-10.00", "2026-10-04,VENMO,-10.00")).currency).toBeNull();
  });

  it("lets what is stated beat any clue", () => {
    const d = detectFileCurrency(rows("Date,Description,Amount", "2026-10-01,YOCO,$1500.00", "2026-10-03,ESKOM,-$80.00"));
    expect(d).toMatchObject({ currency: "USD", confidence: "stated" });
  });
});

describe("when nothing proves it", () => {
  it("says so instead of guessing", () => {
    expect(detectFileCurrency(PLAIN)).toMatchObject({ currency: null, confidence: null });
  });

  it("returns null for a file it cannot read", () => {
    expect(detectFileCurrency("not a spreadsheet")).toBeNull();
    expect(detectFileCurrency("")).toBeNull();
  });
});

describe("resolveFileCurrency", () => {
  const stated = { currency: "ZAR", confidence: "stated" };
  const inferred = { currency: "ZAR", confidence: "inferred" };
  const none = { currency: null, confidence: null };

  it("puts the founder's choice first", () => {
    expect(resolveFileCurrency({ manual: "USD", detected: stated, business: "ZAR" })).toMatchObject({ currency: "USD", how: "chosen", ask: false });
  });

  it("uses what the file says, even against the business currency", () => {
    expect(resolveFileCurrency({ detected: stated, business: "USD" })).toMatchObject({ currency: "ZAR", how: "stated" });
    expect(resolveFileCurrency({ detected: inferred, business: "USD" })).toMatchObject({ currency: "ZAR", how: "inferred" });
  });

  it("falls back to the business currency and says it did", () => {
    expect(resolveFileCurrency({ detected: none, business: "ZAR" })).toMatchObject({ currency: "ZAR", how: "business", ask: false });
  });

  it("asks, never defaulting to dollars, when nothing is known", () => {
    expect(resolveFileCurrency({ detected: none })).toMatchObject({ currency: null, ask: true });
  });

  it("will not make an unsupported currency the business currency", () => {
    expect(resolveFileCurrency({ detected: { currency: "EUR", confidence: "stated" } })).toMatchObject({ currency: null, ask: false, unsupported: "EUR" });
  });

  it("keeps an unsupported file's own label when the business has a currency", () => {
    expect(resolveFileCurrency({ detected: { currency: "EUR", confidence: "stated" }, business: "ZAR" })).toMatchObject({ currency: "EUR", how: "stated" });
  });
});

describe("the label reaches the transactions", () => {
  it("labels unmarked rows with what the heading stated, without changing amounts", () => {
    const text = rows("Date,Description,Amount (ZAR)", "2026-10-01,Sale,1500.00", "2026-10-03,Rent,-800.00");
    const d = detectFileCurrency(text);
    const t = parseTransactions(text, { currency: d.currency }).transactions;
    expect(t.map(x => x.currency)).toEqual(["ZAR", "ZAR"]);
    expect(t.map(x => x.amount)).toEqual([1500, -800]);
  });
});
