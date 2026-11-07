import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  verifyImport, aggregateTransactionsByMonth, computeMetrics, computeDirective, buildRuleIndex, classificationKey, detectExpenseCategory,
  dedupeHashInput, computeDedupeHash, accountKey, detectAccountLabel, compareWithStored, importBatchFields, reviewRuleRows, batchVerification,
  summarizeVerification, verificationNotice, effectiveCashBalance, buildReportCsv, workbookToText,
  NOT_RECONCILED_MESSAGE,
} from "./financials.js";
import { guardVerificationClaims, verificationPromptLine } from "../../supabase/functions/_shared/verification-brief.ts";

// The acceptance tests for verified imports. Every file here is invented, and
// every expected figure is worked by hand from the rows shown, not from the code.
const rows = (...lines) => lines.join("\n");
const check = (text, options = {}) => verifyImport(text, { currency: "ZAR", fileName: "test.csv", ...options });
const codes = r => r.rejections.map(x => x.code);
const TODAY = "2026-07-15";
const months = r => aggregateTransactionsByMonth(r.transactions, { today: TODAY, rules: r.rules });
const total = (list, field) => list.reduce((s, m) => s + (m[field] || 0), 0);

describe("A. Files with no running balance", () => {
  it("A1 accepts a signed amount file and marks it not reconciled", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment Coastal,1000.00", "2026-05-06,Rent,-400.00"));
    expect(r.importStatus).toBe("accepted");
    expect(r.reconciliationStatus).toBe("not_reconciled");
    expect(r.canSave).toBe(true);
    expect(r).toMatchObject({ moneyIn: 1000, moneyOut: 400, netMovement: 600, transactionRows: 2 });
  });

  it("A2 accepts separate debit and credit columns and marks them not reconciled", () => {
    const r = check(rows("Date,Description,Debit,Credit", "2026-05-02,Client payment,,1000.00", "2026-05-06,Rent,400.00,"));
    expect(r.importStatus).toBe("accepted");
    expect(r.reconciliationStatus).toBe("not_reconciled");
    expect(r).toMatchObject({ moneyIn: 1000, moneyOut: 400 });
  });

  it("A3 accepts money in and money out columns and marks them not reconciled", () => {
    const r = check(rows("Date,Description,Money In,Money Out", "2026-05-02,Client payment,1000.00,", "2026-05-06,Rent,,400.00"));
    expect(r.importStatus).toBe("accepted");
    expect(r.reconciliationStatus).toBe("not_reconciled");
    expect(r).toMatchObject({ moneyIn: 1000, moneyOut: 400 });
  });

  it("A4 rejects a row with an amount but no date, and a file with no date column", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", ",No date here,700.00"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("missing_date");
    expect(r.canSave).toBe(false);
    expect(check(rows("Description,Amount", "Client payment,1000.00", "Rent,-400.00")).importStatus).toBe("rejected");
  });

  it("A5 rejects a dated row with no amount, and a file with no amount column", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Rent,"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("missing_amount");
    expect(check(rows("Date,Description", "2026-05-02,Client payment")).importStatus).toBe("rejected");
  });

  it("A5 rejects an amount that cannot be read as a number", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Rent,abc"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("unreadable_amount");
  });

  it("A6 rejects unsigned amounts with nothing to say which way the money moved", () => {
    const r = check(rows("Date,Transaction Type,Name,Memo,Account,Amount",
      "05/02/2026,Invoice,Coastal Retail,Consulting,Accounts Receivable,10000.00",
      "05/20/2026,Expense,Landlord,Rent,Rent Expense,4000.00",
      "05/25/2026,Bill,Supplier,Stock,Accounts Payable,2500.00"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("direction_unknown");
  });

  it("A6 accepts unsigned amounts when a Dr/Cr column gives every row's direction", () => {
    const r = check(rows("Date,Description,Amount,Dr/Cr", "2026-05-02,Client payment,1000.00,Cr", "2026-05-03,Rent,400.00,Dr"));
    expect(r.importStatus).toBe("accepted");
    expect(r).toMatchObject({ moneyIn: 1000, moneyOut: 400 });
  });

  it("A6 rejects a Dr/Cr column that leaves a row's direction unstated", () => {
    const r = check(rows("Date,Description,Amount,Dr/Cr", "2026-05-02,Client payment,1000.00,Cr", "2026-05-03,Rent,400.00,"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("direction_unknown");
  });

  it("A7 rejects columns that could each be the amount", () => {
    const a = check(rows("Date,Description,Amount,Net Amount", "2026-05-02,Client payment,1000.00,870.00", "2026-05-03,Rent,-400.00,-348.00"));
    expect(a.importStatus).toBe("rejected");
    expect(codes(a)).toContain("ambiguous_columns");
    const b = check(rows("Date,Description,Amount,Debit,Credit", "2026-05-02,Client payment,1000.00,,1000.00", "2026-05-03,Rent,-400.00,400.00,"));
    expect(codes(b)).toContain("ambiguous_columns");
  });

  it("A8 never assumes a currency", () => {
    const text = rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-06,Rent,-400.00");
    const unknown = verifyImport(text, { fileName: "test.csv" });
    expect(unknown.importStatus).toBe("rejected");
    expect(codes(unknown)).toContain("currency_unknown");
    expect(verifyImport(text, { fileName: "test.csv", currency: "USD" }).currency).toBe("USD");
    const stated = verifyImport(rows("Date,Description,Amount (ZAR)", "2026-05-02,Client payment,1000.00", "2026-05-06,Rent,-400.00"), { fileName: "test.csv" });
    expect(stated.importStatus).toBe("accepted");
    expect(stated.currency).toBe("ZAR");
  });

  it("A9 rejects an empty file", () => {
    expect(codes(check(""))).toContain("empty_file");
    expect(codes(check("   \n\n  "))).toContain("empty_file");
  });

  it("A10 rejects a file holding only headings and summaries", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-01,Opening balance,,1000.00", "2026-05-31,Closing balance,,1000.00"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("no_transactions");
    expect(codes(check("Date,Description,Amount"))).toContain("no_transactions");
  });

  it("explains every rejection in plain words", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", ",No date here,700.00"));
    expect(r.rejections[0].message).toMatch(/No date here/);
  });

  it("carries the required warning, word for word", () => {
    expect(NOT_RECONCILED_MESSAGE).toBe("Command Ledger has interpreted this file, but it has not verified the transactions against a bank running balance. Figures are based on the uploaded transaction data.");
  });

  it("labels a monthly summary not reconciled, with its column names trusted as revenue", () => {
    const r = check(rows("Month,Revenue,Expenses", "2026-04,120000,90000", "2026-05,125000,95000"));
    expect(r.importStatus).toBe("accepted");
    expect(r.reconciliationStatus).toBe("not_reconciled");
    expect(total(months(r), "revenue")).toBe(245000);
  });
});

describe("B. Files with a running balance", () => {
  const GOOD = rows("Date,Description,Amount,Balance",
    "2026-05-01,Opening balance,,1000.00",
    "2026-05-02,Client payment,500.00,1500.00",
    "2026-05-03,Rent,-200.00,1300.00",
    "2026-05-31,Closing balance,,1300.00");

  it("B1 passes a correct opening balance and transactions", () => {
    const r = check(GOOD);
    expect(r.reconciliationStatus).toBe("verified");
    expect(r).toMatchObject({ openingBalance: 1000, closingBalance: 1300, transactionRows: 2, excludedRows: 2, canSave: true });
    expect(r.discrepancies).toEqual([]);
  });

  it("B2 passes a correct sequence of balances, oldest first or newest first", () => {
    const oldest = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00", "2026-05-04,Fee,-10.00,1290.00"));
    expect(oldest.reconciliationStatus).toBe("verified");
    expect(oldest).toMatchObject({ openingBalance: 1000, closingBalance: 1290 });
    const newest = check(rows("Date,Description,Amount,Balance", "2026-05-04,Fee,-10.00,1290.00", "2026-05-03,Rent,-200.00,1300.00", "2026-05-02,Client payment,500.00,1500.00"));
    expect(newest.reconciliationStatus).toBe("verified");
    expect(newest).toMatchObject({ openingBalance: 1000, closingBalance: 1290 });
  });

  it("B3 fails on a one-cent discrepancy", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1299.99"));
    expect(r.reconciliationStatus).toBe("failed");
    expect(r.canSave).toBe(false);
    expect(r.discrepancies[0]).toMatchObject({ date: "2026-05-03", amount: -200, expected: 1300, stated: 1299.99 });
  });

  it("B4 fails when dates are out of order", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-09,Rent,-200.00,1300.00", "2026-05-04,Fee,-10.00,1290.00"));
    expect(r.reconciliationStatus).toBe("failed");
    expect(r.canSave).toBe(false);
    expect(r.discrepancies[0].type).toBe("order");
  });

  it("B5 fails when a balance is missing in the middle", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,", "2026-05-04,Fee,-10.00,1290.00"));
    expect(r.reconciliationStatus).toBe("failed");
    expect(r.discrepancies[0]).toMatchObject({ type: "missing_balance", date: "2026-05-03" });
  });

  it("B6 fails on an incorrect closing balance", () => {
    const r = check(GOOD.replace("Closing balance,,1300.00", "Closing balance,,1400.00"));
    expect(r.reconciliationStatus).toBe("failed");
    expect(r.discrepancies[0]).toMatchObject({ type: "closing_balance", expected: 1300, stated: 1400 });
  });

  it("B6 fails when the first transaction does not follow the opening balance", () => {
    const r = check(GOOD.replace("Opening balance,,1000.00", "Opening balance,,900.00"));
    expect(r.reconciliationStatus).toBe("failed");
    expect(r.discrepancies[0]).toMatchObject({ date: "2026-05-02", expected: 1400, stated: 1500 });
  });

  it("B6 checks balances stated above the table", () => {
    const text = rows("Opening balance: 1000.00", "Closing balance: 1400.00", "Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00");
    expect(check(text).reconciliationStatus).toBe("failed");
  });

  it("B6 reconciles opening and closing balances when there is no running column", () => {
    const pass = rows("Opening balance: 1000.00", "Closing balance: 1300.00", "Date,Description,Amount", "2026-05-02,Client payment,500.00", "2026-05-03,Rent,-200.00");
    expect(check(pass).reconciliationStatus).toBe("verified");
    expect(check(pass.replace("1300.00", "1300.50")).reconciliationStatus).toBe("failed");
  });

  it("B7 does not count opening and closing rows as transactions", () => {
    const r = check(rows("Date,Description,Amount,Balance",
      "2026-05-01,Opening balance,100000.00,100000.00",
      "2026-05-02,Client payment,15000.00,115000.00",
      "2026-05-28,Rent,-4000.00,111000.00",
      "2026-05-31,Closing balance,111000.00,111000.00"));
    expect(r).toMatchObject({ transactionRows: 2, excludedRows: 2, moneyIn: 15000, moneyOut: 4000 });
    expect(r.reconciliationStatus).toBe("verified");
  });

  it("B7 recognises the abbreviated balance rows real statements print", () => {
    const r = check(rows("Date,Transaction Description,Charge,Debit Amount,Credit Amount,Balance",
      "7/08/2026,Bal Brought Forward,,,,49.99",
      "13/08/2026,Client payment,,,100.00,149.99",
      "14/08/2026,Rent,,40.00,,109.99",
      "15/08/2026,Bal Carried Forward,,,,109.99"));
    expect(r).toMatchObject({ importStatus: "accepted", reconciliationStatus: "verified", openingBalance: 49.99, closingBalance: 109.99, transactionRows: 2, excludedRows: 2 });
  });

  it("B8 makes the discrepancy visible, with the date, transaction and amounts", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,6300.00"));
    const d = r.discrepancies[0];
    expect(d).toMatchObject({ date: "2026-05-03", description: "Rent", amount: -200, expected: 1300, stated: 6300, difference: 5000 });
    expect(d.message).toMatch(/Rent/);
    expect(d.message).toMatch(/2026-05-03/);
  });

  it("never adjusts the figures to make them match", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,6300.00"));
    expect(r).toMatchObject({ moneyIn: 500, moneyOut: 200 });
  });

  it("follows a posting date when transaction dates are out of order", () => {
    const r = check(rows("Transaction Date,Posting Date,Description,Amount,Balance",
      "2026-05-03,2026-05-04,Client payment,500.00,1500.00",
      "2026-05-02,2026-05-05,Rent,-200.00,1300.00",
      "2026-05-06,2026-05-06,Fee,-10.00,1290.00"));
    expect(r.reconciliationStatus).toBe("verified");
  });

  it("does not claim to verify a single transaction with nothing before it", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00"));
    expect(r.reconciliationStatus).toBe("not_reconciled");
  });

  it("saves a closing balance only from a file that proved it", () => {
    expect(check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00")).closingRecord)
      .toEqual({ amount: 1300, date: "2026-05-03", currency: "ZAR" });
    expect(check(rows("Closing balance: 1300.00", "Date,Description,Amount", "2026-05-02,Client payment,500.00", "2026-05-03,Rent,-200.00")).closingRecord).toBeNull();
  });

  it("treats a balance column left wholly blank as no running balance", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,", "2026-05-03,Rent,-200.00,"));
    expect(r.reconciliationStatus).toBe("not_reconciled");
    expect(r.closingBalance).toBeNull();
  });

  it("reads an overdrawn running balance marked Dr", () => {
    const r = check(rows("Date,Description,Amount,Balance", '2026-05-02,Rent,-400.00,"1 200,00 Dr"', '2026-05-03,Client payment,1500.00,"300,00 Cr"'));
    expect(r.reconciliationStatus).toBe("verified");
    expect(r.closingBalance).toBe(300);
  });
});

describe("C. What the money is", () => {
  it("C1 refuses a card export where purchases are positive", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,AIRLINK FLIGHT,4000.00", "2026-05-03,TAKEALOT,1500.00", "2026-05-20,PAYMENT THANK YOU,-5500.00"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("card_statement");
  });

  it("C1 refuses a file that names itself a credit card statement", () => {
    const r = check(rows("Credit card statement", "Card number,****1234", "Date,Description,Amount", "2026-05-02,AIRLINK FLIGHT,4000.00", "2026-05-03,Refund,-100.00"));
    expect(codes(r)).toContain("card_statement");
  });

  it("C1 does not count an unlabelled positive purchase as revenue", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,AIRLINK FLIGHT,4000.00", "2026-05-03,Refund to customer,-100.00"));
    expect(total(months(r), "revenue")).toBe(-100);
    expect(total(months(r), "unconfirmedIn")).toBe(4000);
  });

  it("C1 warns when most money in is unidentified, as an unlabelled card export would be", () => {
    const card = check(rows("Date,Description,Amount", "2026-05-02,AIRLINK FLIGHT,4000.00", "2026-05-03,TAKEALOT STORE,1500.00", "2026-05-20,Online payment,-5500.00"));
    expect(card.importStatus).toBe("accepted");
    expect(card.warnings.join(" ")).toMatch(/credit card/);
    const bank = check(rows("Date,Description,Amount", "2026-05-02,Client payment,9000.00", "2026-05-03,Acme Trading,1000.00", "2026-05-20,Rent,-5500.00"));
    expect(bank.warnings.join(" ")).not.toMatch(/credit card/);
  });

  it("C1 refuses amounts whose descriptions say the signs are reversed", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,POS Purchase Woolworths,300.00", "2026-05-03,Debit order Vodacom,500.00", "2026-05-04,Client payment,-2000.00"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("direction_contradicted");
  });

  it("C2 reads a bank statement's debit as money out", () => {
    const r = check(rows("Date,Description,Debit,Credit,Balance", "2026-05-02,Client payment,,10000.00,10000.00", "2026-05-20,Rent,4000.00,,6000.00"));
    expect(r.reconciliationStatus).toBe("verified");
    expect(r).toMatchObject({ moneyIn: 10000, moneyOut: 4000 });
  });

  it("C2 reads a ledger's debit as money in when its balance proves it", () => {
    const r = check(rows("Date,Source,Description,Reference,Debit,Credit,Running Balance",
      "2026-05-02,Receive Money,Client payment,INV-1,10000.00,,10000.00",
      "2026-05-20,Spend Money,Rent,,,4000.00,6000.00"));
    expect(r.reconciliationStatus).toBe("verified");
    expect(r).toMatchObject({ moneyIn: 10000, moneyOut: 4000 });
    expect(total(months(r), "revenue")).toBe(10000);
    expect(total(months(r), "expenses")).toBe(4000);
    expect(r.warnings.join(" ")).toMatch(/Debit/);
  });

  it("C2 refuses a ledger with no balance to prove its direction", () => {
    const r = check(rows("General Ledger", "Date,Account,Description,Debit,Credit", "2026-05-02,Bank,Client payment,10000.00,", "2026-05-20,Bank,Rent,,4000.00"));
    expect(r.importStatus).toBe("rejected");
    expect(codes(r)).toContain("ledger_export");
  });

  it("C2 refuses a row with both a debit and a credit", () => {
    const r = check(rows("Date,Description,Debit,Credit", "2026-05-02,Journal,100.00,100.00", "2026-05-03,Client payment,,500.00"));
    expect(codes(r)).toContain("both_sides");
  });

  it("C3 takes refunds off the right total", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Refund to customer,-100.00", "2026-05-04,Rent,-400.00", "2026-05-05,Refund from supplier,50.00"));
    const m = months(r);
    expect(total(m, "revenue")).toBe(900);
    expect(total(m, "expenses")).toBe(350);
  });

  it("C4 does not count owner money as revenue", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Owner deposit,5000.00", "2026-05-04,Capital injection,7000.00", "2026-05-05,Rent,-400.00"));
    const m = months(r);
    expect(total(m, "revenue")).toBe(1000);
    expect(total(m, "financingIn")).toBe(7000);
    expect(total(m, "unconfirmedIn")).toBe(5000);
  });

  it("C5 does not count loan money as revenue", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Loan advance from Nedbank,20000.00", "2026-05-04,Facility drawdown,9000.00", "2026-05-05,Rent,-400.00"));
    const m = months(r);
    expect(total(m, "revenue")).toBe(1000);
    expect(total(m, "financingIn")).toBe(20000);
    expect(total(m, "unconfirmedIn")).toBe(9000);
  });

  it("C6 does not count transfers as revenue", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Transfer from savings account,3000.00", "2026-05-04,Transfer from cheque account,2000.00", "2026-05-05,Rent,-400.00"));
    const m = months(r);
    expect(total(m, "revenue")).toBe(1000);
    expect(total(m, "transferIn")).toBe(3000);
    expect(total(m, "unconfirmedIn")).toBe(2000);
  });

  it("C7 does not count an unknown description as revenue, and raises it for review", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-20,EFT from K Ndlovu,300000.00", "2026-05-22,Rent,-400.00"));
    expect(total(months(r), "revenue")).toBe(1000);
    expect(r.unconfirmedIn).toBe(300000);
    expect(r.largestMoneyIn[0]).toMatchObject({ description: "EFT from K Ndlovu", total: 300000, needsDecision: true });
  });

  // Banks print words like these on every incoming row, whoever sent the money.
  it("C7 does not take a bank's own label as proof of revenue", () => {
    const r = check(rows("Date,Description,Amount",
      "2026-05-02,Payshap Ext Credit Settlement A Person,1000.00",
      "2026-05-03,Digital Transf Cr Settlement Family,2000.00",
      "2026-05-04,Acb Credit Settlement Someone,3000.00",
      "2026-05-05,Payment Receipt 4471,4000.00",
      "2026-05-06,Rent,-100.00"));
    expect(total(months(r), "revenue")).toBe(0);
    expect(total(months(r), "unconfirmedIn")).toBe(10000);
  });

  it("C7 still counts a processor's payout and a named invoice as revenue", () => {
    const r = check(rows("Date,Description,Amount",
      "2026-05-02,Yoco Payout 8812,1000.00",
      "2026-05-03,PayFast Settlement,2000.00",
      "2026-05-04,Payshap Ext Credit Settlement Invoice 44,3000.00",
      "2026-05-05,Rent,-100.00"));
    expect(total(months(r), "revenue")).toBe(6000);
    expect(total(months(r), "unconfirmedIn")).toBe(0);
  });

  it("C8 files a bank's transaction fee under banking, not rent", () => {
    expect(detectExpenseCategory("Transaction Fee Headoffice * Payshap Ext Debit")).toBe("banking");
    expect(detectExpenseCategory("Monthly Account Fee Headoffice")).toBe("banking");
    expect(detectExpenseCategory("Rent Sandton Office")).toBe("rent");
  });

  it("C8 does not take a banking app's name for a software cost", () => {
    expect(detectExpenseCategory("Banking App External PayShap Payment: A Person")).not.toBe("software");
    expect(detectExpenseCategory("FNB App Payment To Supplier Ltd")).not.toBe("software");
    expect(detectExpenseCategory("Adobe subscription")).toBe("software");
    expect(detectExpenseCategory("Apple App Store")).toBe("software");
  });

  it("C7 lets the founder's decision count it as revenue", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-20,Acme Trading,3000.00", "2026-05-22,Rent,-400.00"));
    const rules = buildRuleIndex([{ scope: "similar", match_key: classificationKey("Acme Trading"), kind: "operating" }]);
    const m = aggregateTransactionsByMonth(r.transactions, { today: TODAY, rules });
    expect(total(m, "revenue")).toBe(3000);
    expect(total(m, "unconfirmedIn")).toBe(0);
  });

  it("C7 keeps unconfirmed money out of profit and reports it", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-20,EFT from K Ndlovu,3000.00", "2026-05-22,Rent,-400.00"));
    const m = computeMetrics(months(r), { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 }, "safe", { currency: "ZAR", today: TODAY });
    expect(m.totRev).toBe(1000);
    expect(m.totPro).toBe(600);
    expect(m.totUnconfirmedIn).toBe(3000);
  });

  it("C7 leaves files uploaded before this check as they were", () => {
    const old = [{ txn_date: "2026-05-02", amount: 3000, description: "Acme Trading", currency: "ZAR" }];
    expect(aggregateTransactionsByMonth(old, { today: TODAY })[0].revenue).toBe(3000);
  });

  it("C7 raises money out that may be a transfer or a loan", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-20,IB transfer to 62123456789,-8000.00", "2026-05-22,Credit card payment,-900.00"));
    expect(r.reviewOut.map(x => x.description)).toEqual(["IB transfer to 62123456789", "Credit card payment"]);
  });

  it("C8 keeps a separate fee column, proved by the balance", () => {
    const r = check(rows("Posting Date,Description,Money In,Money Out,Fee,Balance",
      "2026-05-02,Client payment Coastal,15000.00,,,115000.00",
      "2026-05-10,Stationery,,-500.00,-7.50,114492.50",
      "2026-05-28,Rent Sandton,,-4000.00,-7.50,110485.00"));
    expect(r.reconciliationStatus).toBe("verified");
    expect(r).toMatchObject({ moneyIn: 15000, moneyOut: 4515 });
    expect(r.transactions.filter(t => /fee/i.test(t.description))).toHaveLength(2);
  });

  it("C8 does not double count a fee already inside money out, proved by the balance", () => {
    const r = check(rows("Date,Description,Money In,Money Out,Fee,Balance", "2026-05-02,Client payment,1000.00,,,2000.00", "2026-05-10,Rent,,407.50,7.50,1592.50"));
    expect(r.reconciliationStatus).toBe("verified");
    expect(r).toMatchObject({ moneyIn: 1000, moneyOut: 407.5 });
  });

  it("C8 keeps a fee when no balance can prove it, and says so", () => {
    const r = check(rows("Date,Description,Money In,Money Out,Fee", "2026-05-02,Client payment,1000.00,,", "2026-05-10,Rent,,400.00,7.50"));
    expect(r).toMatchObject({ moneyIn: 1000, moneyOut: 407.5 });
    expect(r.warnings.join(" ")).toMatch(/fee/i);
  });

  it("C9 keeps opening and closing rows out of revenue and costs", () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-01,Opening balance,100000.00,100000.00", "2026-05-02,Client payment,15000.00,115000.00", "2026-05-28,Rent,-4000.00,111000.00", "2026-05-31,Closing balance,111000.00,111000.00"));
    const m = months(r);
    expect(total(m, "revenue")).toBe(15000);
    expect(total(m, "expenses")).toBe(4000);
  });

  it("C9 keeps a real payee whose name starts with Total", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-03,Total Energies fuel,-300.00"));
    expect(r).toMatchObject({ transactionRows: 2, moneyOut: 300 });
  });

  it("C10 reads decimal and thousands separators correctly", () => {
    expect(check(rows("Date;Description;Amount", "2026-05-02;Client payment;1.234,56", "2026-05-03;Rent;-500,25")).moneyIn).toBe(1234.56);
    expect(check(rows("Date,Description,Amount", '2026-05-02,Client payment,"1,234.56"', "2026-05-03,Rent,-500.25")).moneyIn).toBe(1234.56);
    expect(check(rows("Date,Description,Amount", '2026-05-02,Client payment,"1 234,56"', '2026-05-03,Rent,"-500,25"')).moneyOut).toBe(500.25);
    expect(check(rows("Date,Description,Amount", '2026-05-02,Client payment,"R 1,234.56"', '2026-05-03,Rent,"R -500.25"')).moneyIn).toBe(1234.56);
  });

  it("excludes repeated headings and zero-value rows, and counts them", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "Date,Description,Amount", "2026-05-03,Balance enquiry,0.00", "2026-05-04,Rent,-400.00"));
    expect(r).toMatchObject({ importStatus: "accepted", transactionRows: 2, excludedRows: 2, moneyIn: 1000, moneyOut: 400 });
    expect(r.excluded.map(x => x.reason)).toEqual(expect.arrayContaining(["Repeated heading", "Zero amount"]));
  });

  it("reports the date range and format", () => {
    const r = check(rows("Date,Description,Money In,Money Out", "2026-05-02,Client payment,1000.00,", "2026-06-06,Rent,,400.00"));
    expect(r).toMatchObject({ dateFrom: "2026-05-02", dateTo: "2026-06-06", format: "money_in_out" });
  });
});

describe("Excel workbooks", () => {
  const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  const book = sheets => {
    const wb = XLSX.utils.book_new();
    Object.entries(sheets).forEach(([name, ws]) => XLSX.utils.book_append_sheet(wb, ws, name));
    return XLSX.read(XLSX.write(wb, { type: "array", bookType: "xlsx" }), { type: "array", cellNF: true });
  };
  const head = { A1:{t:"s",v:"Date"}, B1:{t:"s",v:"Description"}, C1:{t:"s",v:"Amount"} };

  it("reads the true value of a cell shown without decimals", () => {
    const wb = book({ Sheet1: { ...head,
      A2:{t:"s",v:"2026-05-02"}, B2:{t:"s",v:"Client payment"}, C2:{t:"n",v:1234.56,z:"#,##0"},
      A3:{t:"s",v:"2026-05-03"}, B3:{t:"s",v:"Rent"}, C3:{t:"n",v:-400.75,z:"#,##0"}, "!ref":"A1:C3" } });
    const { text } = workbookToText(XLSX, wb);
    expect(check(text)).toMatchObject({ moneyIn: 1234.56, moneyOut: 400.75 });
  });

  it("reads date cells from their day count", () => {
    const wb = book({ Sheet1: { ...head,
      A2:{t:"n",v:serial(2026,3,5),z:"m/d/yy"}, B2:{t:"s",v:"Client payment"}, C2:{t:"n",v:100},
      A3:{t:"n",v:serial(2026,3,6),z:"m/d/yy"}, B3:{t:"s",v:"Rent"}, C3:{t:"n",v:-40}, "!ref":"A1:C3" } });
    expect(check(workbookToText(XLSX, wb).text).dateFrom).toBe("2026-03-05");
  });

  it("names any other sheet that holds data, so nothing is dropped silently", () => {
    const sheet = (d, a) => ({ ...head, A2:{t:"s",v:d}, B2:{t:"s",v:"Client payment"}, C2:{t:"n",v:a}, A3:{t:"s",v:d}, B3:{t:"s",v:"Rent"}, C3:{t:"n",v:-1}, "!ref":"A1:C3" });
    const wb = book({ May: sheet("2026-05-02", 100), June: sheet("2026-06-02", 200), Notes: { "!ref":"A1:A1" } });
    const { text, otherSheets } = workbookToText(XLSX, wb);
    expect(otherSheets).toEqual(["June"]);
    const r = check(text, { otherSheets });
    expect(r.warnings.join(" ")).toMatch(/June/);
  });
});

describe("D. Status after saving", () => {
  const notRec = check(rows("Date,Description,Amount", "2026-05-02,Client payment,1000.00", "2026-05-06,Rent,-400.00"));
  const good = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00"));
  const saved = (id, report) => ({ id, ...JSON.parse(JSON.stringify(importBatchFields(report, "Main account"))) });

  it("D1 D2 keeps the status with the saved upload, not in the browser", () => {
    const stored = saved("a", notRec);
    expect(stored).toMatchObject({ import_status: "accepted", reconciliation_status: "not_reconciled", account_label: "Main account" });
    expect(batchVerification(stored)).toBe("not_reconciled");
  });

  it("never saves a failed file's status as a saved upload", () => {
    const bad = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1299.99"));
    expect(() => importBatchFields(bad, "Main account")).toThrow();
  });

  it("D3 tells the dashboard when figures rest on unreconciled data", () => {
    const summary = summarizeVerification([saved("a", notRec)], [{ source_batch_id: "a" }]);
    expect(summary.status).toBe("not_reconciled");
    const notice = verificationNotice(summary);
    expect(notice.title).toBe("NOT RECONCILED");
    expect(notice.detail).not.toMatch(/bank-verified/i);
  });

  it("D3 treats an upload from before these checks as not reconciled", () => {
    expect(batchVerification({ id: "old", reconciliation_status: null })).toBe("not_reconciled");
  });

  it("D4 carries the warning into the report", () => {
    const notice = verificationNotice(summarizeVerification([saved("a", notRec)], [{ source_batch_id: "a" }]));
    const csv = buildReportCsv({ rows: [], currency: "ZAR", verification: notice });
    expect(csv).toMatch(/NOT RECONCILED/);
  });

  it("D5 tells the AI what the figures rest on, and removes any claim they are verified", () => {
    expect(verificationPromptLine({ status: "not_reconciled", notReconciledFiles: 1, totalFiles: 2 })).toMatch(/not reconciled/i);
    const out = guardVerificationClaims({ whatHappened: "Your bank-verified balance is healthy and your verified figures show growth.", confidenceReason: "6 months of data" }, "not_reconciled");
    expect(out.whatHappened).not.toMatch(/verified/i);
    expect(out.confidenceReason).toMatch(/not reconciled/i);
  });

  it("D5 leaves the wording alone when every source reconciled", () => {
    const rec = { whatHappened: "Cash fell.", confidenceReason: "6 months of data" };
    expect(guardVerificationClaims(rec, "verified")).toEqual(rec);
  });

  it("D6 does not turn a missing cash balance into a verified zero", () => {
    expect(effectiveCashBalance({ profile: {}, batches: [], baseCurrency: "ZAR" })).toBeNull();
    const m = computeMetrics([{ month: "May 26", revenue: 100, expenses: 200 }], { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 }, "safe", { currency: "ZAR" });
    expect(m.cashKnown).toBe(false);
    expect(m.runwayConfidence.shown).toBe(false);
  });

  it("D6 marks a balance verified only when it came from a reconciled file", () => {
    const batch = { closing_balance: 1300, closing_balance_on: "2026-05-03", currency: "ZAR", filename: "a.csv", reconciliation_status: "verified" };
    expect(effectiveCashBalance({ profile: {}, batches: [batch], baseCurrency: "ZAR" }).verified).toBe(true);
    expect(effectiveCashBalance({ profile: {}, batches: [{ ...batch, reconciliation_status: null }], baseCurrency: "ZAR" }).verified).toBeFalsy();
    expect(effectiveCashBalance({ profile: { cash_balance: 5, cash_balance_on: "2026-05-04", cash_balance_currency: "ZAR" }, batches: [], baseCurrency: "ZAR" }).verified).toBeFalsy();
  });

  it("D7 keeps each import's own status", () => {
    const list = [saved("a", notRec), saved("b", good)];
    expect(list.map(batchVerification)).toEqual(["not_reconciled", "verified"]);
  });

  it("D8 never claims all data is verified when one source is not", () => {
    const list = [saved("a", notRec), saved("b", good)];
    const both = summarizeVerification(list, [{ source_batch_id: "a" }, { source_batch_id: "b" }]);
    expect(both).toMatchObject({ status: "not_reconciled", notReconciledFiles: 1, totalFiles: 2 });
    expect(summarizeVerification(list, [{ source_batch_id: "b" }]).status).toBe("verified");
    expect(summarizeVerification(list, []).status).toBe("none");
  });
});

// Found by running a real file end to end: with most money in unconfirmed, the
// dashboard announced a loss and critical risk for an account that took in more
// than it spent. Money nobody has identified is a gap, not a zero.
describe("Figures that wait for unconfirmed money", () => {
  const NO = { mRev:0, mExp:0, mCash:0, mCac:0, mLtv:0, mLeads:0, mClose:0 };
  const metrics = (text, ctx = {}) => { const r = check(text); return computeMetrics(months(r), NO, "safe", { currency: "ZAR", today: TODAY, ...ctx }); };
  const OPEN = rows("Date,Description,Amount", "2026-05-02,EFT from K Ndlovu,6000.00", "2026-05-03,Client payment,100.00", "2026-05-20,Office costs,-5000.00");
  const CLOSED = rows("Date,Description,Amount", "2026-05-02,EFT from K Ndlovu,500.00", "2026-05-03,Client payment,9500.00", "2026-05-20,Office costs,-5000.00");

  it("holds back what depends on revenue while the gap is material", () => {
    const m = metrics(OPEN, { cash: { amount: 1000, on: "2026-05-30" } });
    expect(m.figuresOpen).toBe(true);
    expect(m.runwayConfidence.shown).toBe(false);
    expect(m.hiringCapacityConfidence.shown).toBe(false);
    expect(m.proj90Confidence.shown).toBe(false);
  });

  it("carries on as normal when the gap is small", () => {
    const m = metrics(CLOSED, { cash: { amount: 1000, on: "2026-05-30" } });
    expect(m.figuresOpen).toBe(false);
    expect(m.hiringCapacityConfidence.shown).toBe(true);
  });

  it("asks the founder to confirm the money, not to cut spending", () => {
    const m = metrics(OPEN);
    const d = computeDirective({ margin: m.margin, burnMonths: m.burnMonths, free: m.free, vel: m.vel, conv: m.conv, ltvcac: m.ltvcac, months: m.n, concentration: null, currency: "ZAR", figuresOpen: m.figuresOpen, unconfirmedIn: m.totUnconfirmedIn });
    expect(d.rule).toBe("unconfirmed_money_in");
    expect(d.severity).toBe("warn");
    expect(d.text).not.toMatch(/cut/i);
    expect(d.reason).toMatch(/6/);
  });

  it("keeps every smaller payer decidable, not only the largest eight", () => {
    const payers = Array.from({ length: 12 }, (_, i) => `2026-05-${String(i + 2).padStart(2, "0")},Payer Number ${String.fromCharCode(65 + i)},${(i + 1) * 100}.00`);
    const r = check(rows("Date,Description,Amount", ...payers, "2026-05-20,Office costs,-50.00"));
    expect(r.largestMoneyIn).toHaveLength(8);
    expect(r.otherUnconfirmed).toHaveLength(4);
    expect(r.otherUnconfirmed.reduce((s, g) => s + g.total, 0)).toBe(1000);
  });
});

// Found by a real bank CSV. The layout is the bank's, the contents are invented.
describe("A real bank export's layout", () => {
  const HEAD = "Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance";
  const line = (nr, date, desc, moneyIn, moneyOut, fee, bal) => `${nr},1000000001,${date},${date} 09:00,${desc},${desc},Group,Group,${moneyIn},${moneyOut},${fee},${bal}`;

  it("leaves out a row where no money moved, when the balances prove it", () => {
    const r = check(rows(HEAD,
      line(1, "2026-05-02", "Payment Received: Client A", "500.00", "", "", "600.00"),
      line(2, "2026-05-03", "Declined card attempt", "", "", "", ""),
      line(3, "2026-05-03", "Declined Attempt Fee", "", "", "-2.00", "598.00")));
    expect(r).toMatchObject({ importStatus: "accepted", reconciliationStatus: "verified", transactionRows: 2, excludedRows: 1, moneyIn: 500, moneyOut: 2 });
    expect(r.excluded[0].reason).toBe("No money moved");
  });

  it("fails if such a row was really hiding money, because the balance gives it away", () => {
    const r = check(rows(HEAD,
      line(1, "2026-05-02", "Payment Received: Client A", "500.00", "", "", "600.00"),
      line(2, "2026-05-03", "A real payment with its amount missing", "", "", "", ""),
      line(3, "2026-05-03", "Service Fee", "", "", "-2.00", "548.00")));
    expect(r.reconciliationStatus).toBe("failed");
    expect(r.canSave).toBe(false);
  });

  it("still refuses a row with no amount when no balance can prove nothing moved", () => {
    const r = check(rows("Date,Description,Money In,Money Out", "2026-05-02,Client payment,500.00,", "2026-05-03,Declined card attempt,,"));
    expect(codes(r)).toContain("missing_amount");
  });

  it("still refuses a row with a balance but no amount", () => {
    const r = check(rows(HEAD,
      line(1, "2026-05-02", "Payment Received: Client A", "500.00", "", "", "600.00"),
      line(2, "2026-05-03", "Something unexplained", "", "", "", "550.00")));
    expect(codes(r)).toContain("missing_amount");
  });

  it("leaves pending transactions out until they clear, and says so", () => {
    const r = check(rows(HEAD,
      line(1, "2026-05-02", "Payment Received: Client A", "500.00", "", "", "600.00"),
      line(2, "2026-05-03", "(Pending) Cafe Durban (Card 0001)", "", "-112.00", "", ""),
      line(3, "2026-05-03", "Service Fee", "", "", "-2.00", "598.00")));
    expect(r).toMatchObject({ reconciliationStatus: "verified", transactionRows: 2, excludedRows: 1, moneyOut: 2 });
    expect(r.excluded[0].reason).toBe("Pending, not yet cleared");
    expect(r.warnings.join(" ")).toMatch(/pending/i);
    expect(r.transactions.some(t => /pending/i.test(t.description))).toBe(false);
  });

  it("keeps a real payee whose name starts with Pending", () => {
    const r = check(rows("Date,Description,Amount", "2026-05-02,Client payment,500.00", "2026-05-03,Pending Design Studio,-100.00"));
    expect(r).toMatchObject({ transactionRows: 2, moneyOut: 100 });
  });

  it("accepts money out written as negative when there is no balance", () => {
    const r = check(rows("Date,Description,Money In,Money Out", "2026-05-02,Client payment,500.00,", "2026-05-03,Rent,,-200.00"));
    expect(r).toMatchObject({ importStatus: "accepted", reconciliationStatus: "not_reconciled", moneyIn: 500, moneyOut: 200 });
  });

  it("still refuses one column that mixes signs when no balance shows what they mean", () => {
    const r = check(rows("Date,Description,Money In,Money Out", "2026-05-02,Client payment,500.00,", "2026-05-03,Rent,,-200.00", "2026-05-04,Refund,,50.00"));
    expect(codes(r)).toContain("direction_unknown");
  });

  it("follows the posting date when a card purchase clears days later", () => {
    const r = check(rows(HEAD,
      line(1, "2026-05-02", "Payment Received: Client A", "500.00", "", "", "600.00"),
      "2,1000000001,2026-05-05,2026-05-05 09:00,Service Fee,Service Fee,Fees,Fees,,,-2.00,598.00",
      "3,1000000001,2026-05-06,2026-05-03 14:00,Shop (Card 0001),SHOP,Food,Food,,-48.00,,550.00"));
    expect(r.reconciliationStatus).toBe("verified");
  });
});

// The review is enforced by how the app is wired. These read the source, as
// workspace.test.js does, so a later change cannot quietly go around it.
describe("The upload path in App.jsx", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

  it("stores a file only through the confirmed save, with its status", () => {
    expect(app.match(/from\("upload_batches"\)\.insert\(/g)).toHaveLength(1);
    expect(app).toMatch(/\.\.\.importBatchFields\(report, accountLabel\)/);
    expect(app).not.toMatch(/onDataLoaded|handleDataLoaded/);
  });

  it("shows the warning on every workspace page, and in the report", () => {
    expect(app).toMatch(/<VerificationNotice info=\{verificationInfo\}/);
    expect(app).toMatch(/buildReportCsv\(\{[^}]*verification: verificationInfo/);
    expect(app).toMatch(/dataVerification: verification/);
  });

  it("has no session-only figures for an unsaved file", () => {
    expect(app).not.toMatch(/setData\(/);
    expect(app).toMatch(/const rows = history\.length > 0 \? history : null;/);
  });
});

// What a real database refuses and a test double does not. Both refusals were
// reproduced on Postgres against the live table's structure: a save that touches
// one rule twice is refused whole and keeps nothing, and an account name over 120
// characters stops the file being saved at all.
describe("What the live database will accept", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const FILE = rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00");

  it("saves one rule when two choices on one description agree", () => {
    const out = reviewRuleRows([
      { description: "Transfer 0012", kind: "transfer" },
      { description: "TRANSFER 0099", kind: "transfer" },
      { description: "Client payment", kind: "operating" },
    ]);
    expect(out.rows.map(r => r.match_key).sort()).toEqual(["client payment", "transfer"]);
    expect(out.unsaved).toBe(0);
  });

  it("keeps neither of two choices that disagree, and still saves the others", () => {
    const out = reviewRuleRows([
      { description: "Transfer 0012", kind: "transfer" },
      { description: "Transfer 0099", kind: "financing" },
      { description: "Client payment", kind: "operating" },
    ]);
    expect(out.rows).toEqual([{ kind: "operating", scope: "similar", match_key: "client payment", description_key: null }]);
    expect(out.unsaved).toBe(2);
  });

  it("counts a choice on a description of digits only, which cannot have a rule", () => {
    expect(reviewRuleRows([{ description: "0012345", kind: "operating" }])).toEqual({ rows: [], unsaved: 1 });
  });

  it("has nothing to do when nothing was decided", () => {
    expect(reviewRuleRows([])).toEqual({ rows: [], unsaved: 0 });
    expect(reviewRuleRows(undefined)).toEqual({ rows: [], unsaved: 0 });
  });

  it("offers only kinds the rules table accepts", () => {
    const offered = [...app.matchAll(/const REVIEW_(?:IN|OUT)_KINDS = (\[.*?\]\]);/gs)].flatMap(m => [...m[1].matchAll(/\["(\w*)",/g)].map(x => x[1]));
    expect(offered.length).toBeGreaterThan(4);
    expect(offered.filter(k => k && !["operating", "transfer", "financing", "refund"].includes(k))).toEqual([]);
  });

  it("fits any account name into the 120 characters the table allows", () => {
    const label = importBatchFields(check(FILE), "x".repeat(300)).account_label;
    expect(label).toHaveLength(120);
    expect(importBatchFields(check(FILE), `${"x".repeat(119)} y`).account_label).toBe("x".repeat(119));
    // Cutting the name must not move a row's duplicate hash.
    expect(accountKey("x".repeat(300))).toBe(accountKey("x".repeat(120)));
  });

  it("tells the founder when a choice was not kept", () => {
    expect(app).toMatch(/reviewRuleRows\(decisions\)/);
    expect(app).toMatch(/if \(unsaved > 0\)/);
  });

  it("waits for a pause in typing before reading every saved transaction", () => {
    expect(app).toMatch(/setTimeout\(\(\) => \{\s*onCompare\(report\.transactions, label\)/);
    expect(app).toMatch(/clearTimeout\(wait\)/);
  });
});

describe("E. Duplicates", () => {
  const FILE = rows("Date,Description,Amount", "2026-05-31,Monthly account fee,-69.00", "2026-05-31,Client payment,1000.00");
  const hashed = async (report, label) => Promise.all(report.transactions.map(async t => ({
    dedupe_hash: await computeDedupeHash({ ...t, account: accountKey(label) }), txn_date: t.txn_date, description: t.description, amount: t.amount,
  })));

  it("E1 adds nothing when the same file is uploaded to the same account again", async () => {
    const r = check(FILE);
    const stored = await hashed(r, "Main account");
    const out = await compareWithStored(r.transactions, stored, accountKey("Main account"));
    expect(out).toMatchObject({ newRows: 0, duplicates: 2, matchesOtherAccount: 0 });
  });

  it("E2 keeps identical transactions on two different accounts", async () => {
    const r = check(FILE);
    const stored = await hashed(r, "Main account");
    const out = await compareWithStored(r.transactions, stored, accountKey("Savings account"));
    expect(out).toMatchObject({ newRows: 2, duplicates: 0, matchesOtherAccount: 2 });
    expect(dedupeHashInput({ ...r.transactions[0], account: accountKey("Main account") }))
      .not.toBe(dedupeHashInput({ ...r.transactions[0], account: accountKey("Savings account") }));
  });

  it("E2 still recognises rows saved before accounts were recorded", async () => {
    const r = check(FILE);
    const stored = await Promise.all(r.transactions.map(async t => ({ dedupe_hash: await computeDedupeHash(t), txn_date: t.txn_date, description: t.description, amount: t.amount })));
    const out = await compareWithStored(r.transactions, stored, accountKey("Main account"));
    expect(out).toMatchObject({ newRows: 0, duplicates: 2 });
  });

  it("E2 leaves a hash with no account exactly as stored today", () => {
    expect(dedupeHashInput({ txn_date: "2026-10-01", description: "Card sale", amount: 50 })).toBe("2026-10-01|card sale|50.00");
  });

  it("offers the account a file names, keeping only its last four digits", () => {
    expect(detectAccountLabel(rows("Account History", "Account: 62000000001", "Date,Description,Amount"))).toBe("Account ending 0001");
    expect(detectAccountLabel(rows("Date,Description,Amount", "2026-05-02,Client,100"))).toBe("");
  });

  it("E3 does not let duplicates change a file's status", async () => {
    const r = check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00"));
    const before = r.reconciliationStatus;
    await compareWithStored(r.transactions, await hashed(r, "Main account"), accountKey("Main account"));
    expect(r.reconciliationStatus).toBe(before);
    expect(check(rows("Date,Description,Amount,Balance", "2026-05-02,Client payment,500.00,1500.00", "2026-05-03,Rent,-200.00,1300.00")).reconciliationStatus).toBe("verified");
  });
});
