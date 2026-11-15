// Account answers and statement coverage (correction plan, revision 4: D10a,
// D10c and D1's window; Phase 1, task 3). Every expected figure below is worked
// out by hand from the plan's own examples, not read from the code under test.
import { describe, it, expect } from "vitest";
import {
  accountAnswerRow, accountAnswerRows, uploadAccountKey, resolveAccounts, accountCoverage,
  judgementWindow, canConfirmQuietMonth, coverageNote, aggregateTransactionsByMonth, currentRunRate, fmt,
  runRateRowsWithQuietMonths, computeMetrics,
} from "./financials.js";

const TODAY = "2026-07-15";
const USER = "11111111-1111-4111-8111-111111111111";
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Revenue reads as revenue and rent as a cost: neither wording is a transfer,
// loan or refund.
const tx = (batch, txn_date, amount) => ({
  source_batch_id: batch, txn_date, amount, category: null, currency: "ZAR",
  description: amount > 0 ? "Invoice Acme Trading" : "Office rent",
});
const batch = (n, fields = {}) => ({ id: ID(n), currency: "ZAR", filename: `file-${n}.csv`, account_label: null, reconciliation_status: null, ...fields });
const cheque = (n, fields = {}) => batch(n, { account_label: "Cheque", ...fields });
const verified = (fields = {}) => ({ reconciliation_status: "verified", duplicate_count: 0, ...fields });

// A month of the plan's missing-month example: revenue on the 5th, costs of
// R100,000 on the 28th, so the data is within 7 days of both ends.
const month = (b, ym, revenue, costs = 100000) => [tx(b, `${ym}-05`, revenue), tx(b, `${ym}-28`, -costs)];

const statusOf = (cov, key) => Object.fromEntries(cov.accounts.find(a => a.key === key).months.map(m => [m.key, m.status]));
const bizStatus = cov => Object.fromEntries(cov.months.map(m => [m.key, m.status]));

// ─── Saving an answer ───────────────────────────────────────────
describe("account answer rows: every save carries every field", () => {
  const FIELDS = ["user_id", "account_key", "batch_id", "kind", "slot", "closed_on", "same_as_key", "month"];

  it("a closed answer carries its date and empties the others", () => {
    const row = accountAnswerRow({ accountKey: "cheque", kind: "closed", closedOn: "2026-03-31" }, USER);
    expect(Object.keys(row).sort()).toEqual([...FIELDS].sort());
    expect(row).toEqual({ user_id: USER, account_key: "cheque", batch_id: null, kind: "closed", slot: "status",
      closed_on: "2026-03-31", same_as_key: null, month: null });
  });

  it("changing closed to still open sends the date as empty, so the old date is cleared", () => {
    const before = accountAnswerRow({ accountKey: "cheque", kind: "closed", closedOn: "2026-03-31" }, USER);
    // The founder's form may still hold the old date; it must not travel.
    const after = accountAnswerRow({ accountKey: "cheque", kind: "still_open", closedOn: "2026-03-31" }, USER);
    expect(after.slot).toBe(before.slot); // the same row is replaced
    expect(Object.prototype.hasOwnProperty.call(after, "closed_on")).toBe(true);
    expect(after.closed_on).toBeNull();
    expect(after.same_as_key).toBeNull();
    expect(after.month).toBeNull();
  });

  it("changing to same-as clears the date; changing back clears the link", () => {
    const link = accountAnswerRow({ accountKey: "savings", kind: "same_as", sameAsKey: "cheque", closedOn: "2026-01-31" }, USER);
    expect(link).toMatchObject({ kind: "same_as", same_as_key: "cheque", closed_on: null, month: null, slot: "status" });
    const closed = accountAnswerRow({ accountKey: "savings", kind: "closed", closedOn: "2026-01-31", sameAsKey: "cheque" }, USER);
    expect(closed).toMatchObject({ kind: "closed", same_as_key: null, closed_on: "2026-01-31" });
  });

  it("an unnamed upload's answer names that upload", () => {
    const row = accountAnswerRow({ accountKey: `upload:${ID(7)}`, kind: "still_open" }, USER);
    expect(row.account_key).toBe(`upload:${ID(7)}`);
    expect(row.batch_id).toBe(ID(7));
    expect(accountAnswerRow({ accountKey: "cheque", kind: "still_open" }, USER).batch_id).toBeNull();
  });

  it("a quiet month is stored on its 1st, in its own slot", () => {
    const row = accountAnswerRow({ accountKey: "cheque", kind: "no_transactions_month", month: "2026-05-17" }, USER);
    expect(row).toMatchObject({ month: "2026-05-01", slot: "month:2026-05", closed_on: null, same_as_key: null });
  });

  it("refuses an answer the database would refuse", () => {
    // Each is refused by accountAnswerRow itself, with its own message, not by
    // some other error on the way.
    const refused = f => expect(f).toThrow(/^Account answer: /);
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "closed" }, USER));                       // no date
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "closed", closedOn: "2026-02-30" }, USER)); // no such day
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "same_as", sameAsKey: "cheque" }, USER));  // itself
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "same_as" }, USER));                       // no target
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "same_as", sameAsKey: "Cheque!" }, USER)); // not a key
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "no_transactions_month" }, USER));         // no month
    refused(() => accountAnswerRow({ accountKey: "Cheque", kind: "still_open" }, USER));                    // not a key
    refused(() => accountAnswerRow({ accountKey: "upload:abc", kind: "still_open" }, USER));                // not an upload id
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "dormant" }, USER));
    refused(() => accountAnswerRow({ accountKey: "cheque", kind: "still_open" }, ""));                      // no user
  });
});

describe("account answer rows: one answer per slot in a save", () => {
  it("refuses a save that answers one account's status twice, and saves nothing", () => {
    const r = accountAnswerRows([
      { accountKey: "cheque", kind: "closed", closedOn: "2026-03-31" },
      { accountKey: "cheque", kind: "still_open" },
    ], USER);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/twice/i);
  });

  it("refuses the same month twice, whatever day each names", () => {
    const r = accountAnswerRows([
      { accountKey: "cheque", kind: "no_transactions_month", month: "2026-05-01" },
      { accountKey: "cheque", kind: "no_transactions_month", month: "2026-05-20" },
    ], USER);
    expect(r.rows).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it("saves different slots together", () => {
    const r = accountAnswerRows([
      { accountKey: "cheque", kind: "still_open" },
      { accountKey: "cheque", kind: "no_transactions_month", month: "2026-05-01" },
      { accountKey: "cheque", kind: "no_transactions_month", month: "2026-06-01" },
      { accountKey: "savings", kind: "still_open" },
    ], USER);
    expect(r.error).toBeNull();
    expect(r.rows.map(x => `${x.account_key}|${x.slot}`)).toEqual(["cheque|status", "cheque|month:2026-05", "cheque|month:2026-06", "savings|status"]);
  });

  it("refuses the whole save when one answer is invalid", () => {
    const r = accountAnswerRows([{ accountKey: "cheque", kind: "still_open" }, { accountKey: "savings", kind: "closed" }], USER);
    expect(r.rows).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});

// ─── Which account an upload is ─────────────────────────────────
describe("which account an upload belongs to", () => {
  it("a named upload is its account; an unnamed one is its own upload", () => {
    expect(uploadAccountKey(cheque(1))).toBe("cheque");
    expect(uploadAccountKey(batch(2, { account_label: "  CHEQUE " }))).toBe("cheque");
    expect(uploadAccountKey(batch(3))).toBe(`upload:${ID(3)}`);
    expect(uploadAccountKey(batch(4, { account_label: "***" }))).toBe(`upload:${ID(4)}`); // no usable name
  });

  it("two unnamed uploads are two accounts until the founder links them", () => {
    const r = resolveAccounts([batch(1), batch(2)], []);
    expect(r.groups.size).toBe(2);
    const linked = resolveAccounts([batch(1), batch(2)], [{ account_key: `upload:${ID(1)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(2)}` }]);
    expect(linked.groups.size).toBe(1);
    expect(linked.accounts.get(`upload:${ID(1)}`).group).toBe(`upload:${ID(2)}`);
  });

  it("an account with no answer is unresolved, never closed", () => {
    const r = resolveAccounts([batch(1)], []);
    const a = r.accounts.get(`upload:${ID(1)}`);
    expect(a.status).toBe("unresolved");
    expect(a.reason).toBe("no_answer");
    expect(a.closedOn).toBeNull();
  });

  it("a link to an upload that no longer exists is ignored: unresolved, not joined, not closed", () => {
    const r = resolveAccounts([batch(1), cheque(2)], [{ account_key: `upload:${ID(1)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(99)}` }]);
    const a = r.accounts.get(`upload:${ID(1)}`);
    expect(a).toMatchObject({ status: "unresolved", reason: "missing_link", group: `upload:${ID(1)}`, closedOn: null });
    expect(r.groups.size).toBe(2);
  });

  it("a link to a named account no longer on file is ignored the same way", () => {
    const r = resolveAccounts([batch(1)], [{ account_key: `upload:${ID(1)}`, kind: "same_as", slot: "status", same_as_key: "old cheque" }]);
    expect(r.accounts.get(`upload:${ID(1)}`)).toMatchObject({ status: "unresolved", reason: "missing_link" });
  });

  it("a chain of links resolves through the accounts it names", () => {
    const answers = [
      { account_key: `upload:${ID(1)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(2)}` },
      { account_key: `upload:${ID(2)}`, kind: "same_as", slot: "status", same_as_key: "cheque" },
      { account_key: "cheque", kind: "closed", slot: "status", closed_on: "2026-06-30" },
    ];
    const r = resolveAccounts([batch(1), batch(2), cheque(3)], answers);
    expect(r.groups.size).toBe(1);
    expect(r.accounts.get(`upload:${ID(1)}`).group).toBe("cheque");
    expect(r.groups.get("cheque")).toMatchObject({ status: "closed", closedOn: "2026-06-30" });
    expect(r.groups.get("cheque").members.sort()).toEqual(["cheque", `upload:${ID(1)}`, `upload:${ID(2)}`].sort());
  });

  it("a loop leaves every account in it unresolved and apart", () => {
    const answers = [
      { account_key: `upload:${ID(1)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(2)}` },
      { account_key: `upload:${ID(2)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(1)}` },
      { account_key: `upload:${ID(3)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(1)}` }, // leads into the loop
    ];
    const r = resolveAccounts([batch(1), batch(2), batch(3)], answers);
    expect(r.groups.size).toBe(3);
    [1, 2, 3].forEach(n => expect(r.accounts.get(`upload:${ID(n)}`)).toMatchObject({ status: "unresolved", reason: "loop", group: `upload:${ID(n)}` }));
  });

  it("a missing account anywhere in a chain leaves every account in the chain unresolved", () => {
    const answers = [
      { account_key: `upload:${ID(1)}`, kind: "same_as", slot: "status", same_as_key: `upload:${ID(2)}` },
      { account_key: `upload:${ID(2)}`, kind: "same_as", slot: "status", same_as_key: "gone" },
    ];
    const r = resolveAccounts([batch(1), batch(2)], answers);
    expect(r.groups.size).toBe(2);
    expect(r.accounts.get(`upload:${ID(1)}`)).toMatchObject({ status: "unresolved", reason: "missing_link" });
    expect(r.accounts.get(`upload:${ID(2)}`)).toMatchObject({ status: "unresolved", reason: "missing_link" });
  });

  it("an answer about an account no longer on file is ignored", () => {
    const r = resolveAccounts([cheque(1)], [{ account_key: "savings", kind: "closed", slot: "status", closed_on: "2026-01-31" }]);
    expect(r.ignored.map(a => a.account_key)).toEqual(["savings"]);
    expect(r.groups.size).toBe(1);
  });
});

// ─── The plan's missing-month example (defect 13, cases A, B and C) ─────
// March and April: revenue R90,000, costs R100,000. No transaction in May.
// June: revenue R60,000, costs R100,000. Window: April, May, June.
describe("a missing month: cases A, B and C", () => {
  const rows = b1 => [...month(b1, "2026-03", 90000), ...month(b1, "2026-04", 90000)];
  const june = b => month(b, "2026-06", 60000);

  // A: one verified file, 5 March to 28 June, balance unchanged across May.
  const caseA = { batches: [cheque(1, verified({ period_start: "2026-03-05", period_end: "2026-06-28" }))], transactions: [...rows(ID(1)), ...june(ID(1))] };
  // B: two files, March to April and June, no balance evidence.
  const caseB = {
    batches: [cheque(1, { period_start: "2026-03-05", period_end: "2026-04-28" }), cheque(2, { period_start: "2026-06-05", period_end: "2026-06-28" })],
    transactions: [...rows(ID(1)), ...june(ID(2))],
  };
  // C: two verified files; the first closes at R50,000, the second opens at
  // 95,000 - 60,000 = R35,000. R15,000 left with no transaction on file.
  const caseC = {
    batches: [
      cheque(1, verified({ period_start: "2026-03-05", period_end: "2026-04-28", closing_balance: 50000, reconciliation_detail: { openingBalance: 70000, closingBalance: 50000 } })),
      cheque(2, verified({ period_start: "2026-06-05", period_end: "2026-06-28", closing_balance: -5000, reconciliation_detail: { openingBalance: 35000, closingBalance: -5000 } })),
    ],
    transactions: [...rows(ID(1)), ...june(ID(2))],
  };
  const cov = (c, answers = []) => accountCoverage({ ...c, answers, today: TODAY });
  const quietMay = [{ account_key: "cheque", kind: "no_transactions_month", slot: "month:2026-05", month: "2026-05-01" }];

  it("May is a gap in all three cases, never zero", () => {
    [caseA, caseB, caseC].forEach(c => {
      const r = cov(c);
      expect(statusOf(r, "cheque")).toEqual({ "2026-03": "complete", "2026-04": "complete", "2026-05": "gap", "2026-06": "complete" });
      const may = r.months.find(m => m.key === "2026-05");
      expect(may.status).toBe("gap");
      expect(may.totals).toBeNull(); // unknown, not zero
    });
  });

  it("each case carries its own balance note, and none of them makes May a figure", () => {
    const noteA = cov(caseA).accounts[0].months.find(m => m.key === "2026-05").balance;
    expect(noteA).toMatchObject({ kind: "unchanged", source: "file" });
    expect(cov(caseB).accounts[0].months.find(m => m.key === "2026-05").balance).toBeNull();
    const noteC = cov(caseC).accounts[0].months.find(m => m.key === "2026-05").balance;
    expect(noteC).toMatchObject({ kind: "moved", amount: -15000, from: "2026-04-28", to: "2026-06-05" });
    expect(coverageNote(noteC, "Cheque", "ZAR")).toContain(fmt(15000, "ZAR"));
    expect(coverageNote(noteC, "Cheque", "ZAR")).toMatch(/left Cheque between 2026-04-28 and 2026-06-05/);
    expect(coverageNote(noteA, "Cheque", "ZAR")).toMatch(/still counts as missing/);
  });

  it("the D1 window is April, May and June, and holds on the gap in every case", () => {
    [caseA, caseB, caseC].forEach(c => {
      const w = judgementWindow(cov(c));
      expect(w.end).toBe("2026-06");
      expect(w.months.map(m => m.key)).toEqual(["2026-04", "2026-05", "2026-06"]);
      expect(w.complete).toBe(false);
      expect(w.missing).toEqual(["2026-05"]);
      expect(w.average).toBeNull();
    });
  });

  it("case A: the founder's confirmation and the unchanged balance together make May zero", () => {
    expect(canConfirmQuietMonth(cov(caseA), "cheque", "2026-05")).toEqual({ ok: true });
    const r = cov(caseA, quietMay);
    expect(statusOf(r, "cheque")["2026-05"]).toBe("quiet");
    const w = judgementWindow(r);
    expect(w.complete).toBe(true);
    // Burn: costs plus financing out less revenue. April 100,000 - 90,000 = 10,000;
    // May 0; June 100,000 - 60,000 = 40,000. (10,000 + 0 + 40,000) / 3 = 16,666.67.
    expect(w.average.burn).toBe(16666.67);
    expect(w.average.revenue).toBe(50000);     // (90,000 + 0 + 60,000) / 3
    expect(w.average.expenses).toBe(66666.67); // (100,000 + 0 + 100,000) / 3
    expect(w.months[1].totals.revenue).toBe(0);
  });

  it("case B: with no balances to check, the confirmation is refused and May stays a gap", () => {
    expect(canConfirmQuietMonth(cov(caseB), "cheque", "2026-05")).toMatchObject({ ok: false, reason: "no_balance" });
    const may = cov(caseB, quietMay).accounts[0].months.find(m => m.key === "2026-05");
    expect(may.status).toBe("gap");
    expect(may.refused).toBe("no_balance");
    expect(judgementWindow(cov(caseB, quietMay)).complete).toBe(false);
  });

  it("case C: R15,000 moved, so the confirmation is refused and May stays a gap", () => {
    expect(canConfirmQuietMonth(cov(caseC), "cheque", "2026-05")).toMatchObject({ ok: false, reason: "moved" });
    const may = cov(caseC, quietMay).accounts[0].months.find(m => m.key === "2026-05");
    expect(may.status).toBe("gap");
    expect(may.refused).toBe("moved");
    expect(judgementWindow(cov(caseC, quietMay)).complete).toBe(false);
  });

  it("matching balances between two verified files support a confirmation, and never replace it", () => {
    const c = {
      ...caseC,
      batches: [caseC.batches[0], { ...caseC.batches[1], reconciliation_detail: { openingBalance: 50000, closingBalance: 10000 } }],
    };
    const before = cov(c);
    expect(before.accounts[0].months.find(m => m.key === "2026-05")).toMatchObject({ status: "gap", balance: { kind: "unchanged", source: "files" } });
    expect(judgementWindow(before).complete).toBe(false); // balance evidence alone is never a figure
    expect(canConfirmQuietMonth(before, "cheque", "2026-05")).toEqual({ ok: true });
    expect(statusOf(cov(c, quietMay), "cheque")["2026-05"]).toBe("quiet");
  });

  it("an unnamed verified file whose duplicates were skipped gives no balance evidence inside it", () => {
    // Its skipped rows may belong to another unnamed account, so May may have
    // had transactions this account no longer shows.
    const c = { batches: [batch(1, verified({ period_start: "2026-03-05", period_end: "2026-06-28", duplicate_count: 3 }))], transactions: [...rows(ID(1)), ...june(ID(1))] };
    expect(cov(c).accounts[0].months.find(m => m.key === "2026-05").balance).toBeNull();
  });

  it("a confirmation for a month that has transactions changes nothing", () => {
    const r = cov(caseA, [{ account_key: "cheque", kind: "no_transactions_month", slot: "month:2026-04", month: "2026-04-01" }]);
    const april = r.accounts[0].months.find(m => m.key === "2026-04");
    expect(april.status).toBe("complete");
    expect(r.months.find(m => m.key === "2026-04").totals.revenue).toBe(90000);
  });
});

// ─── Several accounts ──────────────────────────────────────────
// Cheque takes in R100,000 and pays R80,000 a month; in May it also sends
// R30,000 to Savings in words not read as a transfer. Savings earns R500 of
// interest in April and June (two R250 credits, near each end of the month),
// and its May statement is not uploaded.
describe("several accounts: business months", () => {
  const savings = n => batch(n, { account_label: "Savings" });
  const chequeRows = b => ["2026-04", "2026-05", "2026-06"].flatMap(ym => month(b, ym, 100000, 80000));
  const savingsMonth = (b, ym) => [tx(b, `${ym}-02`, 250), tx(b, `${ym}-28`, 250)];
  const base = {
    batches: [cheque(1), savings(2)],
    transactions: [...chequeRows(ID(1)), tx(ID(1), "2026-05-20", -30000), ...savingsMonth(ID(2), "2026-04"), ...savingsMonth(ID(2), "2026-06")],
  };

  it("a business month is a gap when any account expected that month is a gap", () => {
    const r = accountCoverage({ ...base, answers: [], today: TODAY });
    expect(statusOf(r, "cheque")).toEqual({ "2026-04": "complete", "2026-05": "complete", "2026-06": "complete" });
    expect(statusOf(r, "savings")).toEqual({ "2026-04": "complete", "2026-05": "gap", "2026-06": "complete" });
    expect(bizStatus(r)).toEqual({ "2026-04": "complete", "2026-05": "gap", "2026-06": "complete" });
    expect(r.months.find(m => m.key === "2026-05").gapAccounts).toEqual(["savings"]);
    expect(judgementWindow(r).complete).toBe(false);
  });

  it("business months add every account's money in that month", () => {
    const r = accountCoverage({ ...base, answers: [], today: TODAY });
    const april = r.months.find(m => m.key === "2026-04").totals;
    expect(april.revenue).toBe(100500); // 100,000 + 250 + 250
    expect(april.expenses).toBe(80000);
  });

  it("with every month on file the window averages business months", () => {
    const full = { ...base, transactions: [...base.transactions, ...savingsMonth(ID(2), "2026-05")] };
    const w = judgementWindow(accountCoverage({ ...full, answers: [], today: TODAY }));
    expect(w.complete).toBe(true);
    // April: 100,500 in, 80,000 out. May: 100,500 in, 110,000 out. June: as April.
    // Revenue (3 x 100,500) / 3 = 100,500. Costs (80,000 + 110,000 + 80,000) / 3 = 90,000.
    expect(w.average.revenue).toBe(100500);
    expect(w.average.expenses).toBe(90000);
    expect(w.average.burn).toBe(-10500); // a profit of R10,500 a month, not burn
  });
});

// ─── A stopped account (D10c) ────────────────────────────────────
describe("an account whose statements stop while another continues", () => {
  const payroll = n => batch(n, { account_label: "Payroll" });
  const months = (b, list) => list.flatMap(ym => month(b, ym, 50000, 40000));
  const base = {
    batches: [cheque(1), payroll(2)],
    transactions: [...months(ID(1), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]), ...months(ID(2), ["2026-01", "2026-02", "2026-03"])],
  };
  const cov = answers => accountCoverage({ ...base, answers, today: TODAY });

  it("until answered, its later months are gaps and the founder is asked", () => {
    const r = cov([]);
    expect(statusOf(r, "payroll")).toMatchObject({ "2026-03": "complete", "2026-04": "gap", "2026-05": "gap", "2026-06": "gap" });
    expect(bizStatus(r)["2026-05"]).toBe("gap");
    expect(r.questions.map(q => [q.key, q.kind])).toEqual([["payroll", "stopped"]]);
  });

  it("closed on 31 March ends its history", () => {
    const r = cov([{ account_key: "payroll", kind: "closed", slot: "status", closed_on: "2026-03-31" }]);
    expect(Object.keys(statusOf(r, "payroll"))).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(bizStatus(r)).toMatchObject({ "2026-04": "complete", "2026-05": "complete", "2026-06": "complete" });
    expect(r.questions).toEqual([]);
    expect(judgementWindow(r).complete).toBe(true);
  });

  it("closed on 30 April leaves April missing and ends it there", () => {
    const r = cov([{ account_key: "payroll", kind: "closed", slot: "status", closed_on: "2026-04-30" }]);
    expect(statusOf(r, "payroll")).toEqual({ "2026-01": "complete", "2026-02": "complete", "2026-03": "complete", "2026-04": "gap" });
    expect(bizStatus(r)).toMatchObject({ "2026-04": "gap", "2026-05": "complete" });
  });

  it("same as Cheque joins the two histories", () => {
    // The older statements were uploaded as Payroll (January to March); the same
    // bank account's later ones as Cheque (April to June).
    const r = accountCoverage({ batches: base.batches, today: TODAY,
      transactions: [...months(ID(2), ["2026-01", "2026-02", "2026-03"]), ...months(ID(1), ["2026-04", "2026-05", "2026-06"])],
      answers: [{ account_key: "payroll", kind: "same_as", slot: "status", same_as_key: "cheque" }] });
    expect(r.accounts.map(a => a.key)).toEqual(["cheque"]);
    expect(r.accounts[0].members.sort()).toEqual(["cheque", "payroll"]);
    expect(Object.keys(statusOf(r, "cheque"))).toHaveLength(6);
    expect(Object.values(statusOf(r, "cheque")).every(s => s === "complete")).toBe(true);
    expect(r.questions).toEqual([]);
  });

  it("same as Cheque while both cover January to March: those months are held, not joined blindly", () => {
    const r = cov([{ account_key: "payroll", kind: "same_as", slot: "status", same_as_key: "cheque" }]);
    expect(statusOf(r, "cheque")).toMatchObject({ "2026-01": "overlap", "2026-03": "overlap", "2026-04": "complete" });
  });

  it("still open keeps its later months as gaps and is not asked again", () => {
    const r = cov([{ account_key: "payroll", kind: "still_open", slot: "status" }]);
    expect(statusOf(r, "payroll")["2026-06"]).toBe("gap");
    expect(bizStatus(r)).toMatchObject({ "2026-04": "gap", "2026-05": "gap", "2026-06": "gap" });
    expect(r.questions).toEqual([]);
    // The window is still April to June, the months that have ended: held.
    const w = judgementWindow(r);
    expect(w.months.map(m => m.key)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(w.complete).toBe(false);
    expect(w.missing).toEqual(["2026-04", "2026-05", "2026-06"]);
  });

  it("is not asked about while only the current month is missing", () => {
    // Payroll stops at the end of June; Cheque has rows in July, this month.
    const r = accountCoverage({ batches: base.batches, answers: [], today: TODAY,
      transactions: [...months(ID(1), ["2026-05", "2026-06"]), tx(ID(1), "2026-07-02", 100), ...months(ID(2), ["2026-05", "2026-06"])] });
    expect(statusOf(r, "payroll")["2026-07"]).toBe("gap");
    expect(r.questions).toEqual([]);
  });
});

// ─── Unnamed uploads ─────────────────────────────────────────────
describe("older uploads with no account name", () => {
  const months = (b, list) => list.flatMap(ym => month(b, ym, 50000, 40000));
  const base = {
    batches: [batch(1), batch(2)],
    transactions: [...months(ID(1), ["2026-01", "2026-02", "2026-03"]), ...months(ID(2), ["2026-04", "2026-05", "2026-06"])],
  };
  const U1 = `upload:${ID(1)}`, U2 = `upload:${ID(2)}`;
  const cov = answers => accountCoverage({ ...base, answers, today: TODAY });

  it("are separate accounts, each asked about, until linked", () => {
    const r = cov([]);
    expect(r.accounts.map(a => a.key).sort()).toEqual([U1, U2].sort());
    expect(statusOf(r, U1)).toMatchObject({ "2026-04": "gap", "2026-06": "gap" }); // its later months
    expect(Object.keys(statusOf(r, U2))).toEqual(["2026-04", "2026-05", "2026-06"]); // nothing before its own history
    expect(bizStatus(r)["2026-05"]).toBe("gap");
    expect(r.questions.map(q => [q.key, q.kind]).sort()).toEqual([[U1, "identity"], [U2, "identity"]].sort());
  });

  it("a linked pair reads as one history", () => {
    const r = cov([{ account_key: U1, kind: "same_as", slot: "status", same_as_key: U2 }]);
    expect(r.accounts.map(a => a.key)).toEqual([U2]);
    expect(Object.values(statusOf(r, U2)).every(s => s === "complete")).toBe(true);
    expect(Object.keys(statusOf(r, U2))).toHaveLength(6);
    expect(judgementWindow(r).complete).toBe(true);
    // The upload the history is joined to still has no name or answer of its own.
    expect(r.questions.map(q => [q.key, q.kind])).toEqual([[U2, "identity"]]);
  });

  it("an unnamed upload with no answer is never read as closed", () => {
    const r = cov([]);
    const a = r.accounts.find(x => x.key === U1);
    expect(a.status).toBe("unresolved");
    expect(a.status).not.toBe("closed");
    // Its later months are gaps, not months after a closed account.
    expect(["2026-04", "2026-05", "2026-06"].map(k => statusOf(r, U1)[k])).toEqual(["gap", "gap", "gap"]);
  });

  it("a stale link leaves it unresolved, with its later months gaps and the question asked again", () => {
    const r = cov([{ account_key: U1, kind: "same_as", slot: "status", same_as_key: `upload:${ID(99)}` }]);
    expect(r.accounts.map(a => a.key).sort()).toEqual([U1, U2].sort()); // never joined
    expect(r.accounts.find(x => x.key === U1)).toMatchObject({ status: "unresolved", reason: "missing_link" });
    expect(statusOf(r, U1)["2026-05"]).toBe("gap");
    expect(r.questions.find(q => q.key === U1).kind).toBe("broken_link");
  });

  it("a loop between them leaves both unresolved and apart", () => {
    const r = cov([
      { account_key: U1, kind: "same_as", slot: "status", same_as_key: U2 },
      { account_key: U2, kind: "same_as", slot: "status", same_as_key: U1 },
    ]);
    expect(r.accounts.map(a => a.key).sort()).toEqual([U1, U2].sort());
    expect(r.accounts.every(a => a.status === "unresolved" && a.reason === "loop")).toBe(true);
    expect(bizStatus(r)["2026-05"]).toBe("gap");
  });
});

// ─── Partial months and today's results ─────────────────────────
describe("partial months, and months that run on as today", () => {
  it("a file whose first transaction is on 12 March: March is partial", () => {
    const r = accountCoverage({ batches: [cheque(1)], answers: [], today: TODAY,
      transactions: [tx(ID(1), "2026-03-12", 500), tx(ID(1), "2026-03-30", -100), ...month(ID(1), "2026-04", 900, 100)] });
    expect(statusOf(r, "cheque")).toEqual({ "2026-03": "partial", "2026-04": "complete" });
    expect(bizStatus(r)["2026-03"]).toBe("partial");
  });

  it("only June complete among April to June: the window holds", () => {
    // Data starts on 20 April (partial); no May rows (a gap); June complete.
    const r = accountCoverage({ batches: [cheque(1)], answers: [], today: TODAY,
      transactions: [tx(ID(1), "2026-04-20", 500), tx(ID(1), "2026-04-28", -100), ...month(ID(1), "2026-06", 900, 100)] });
    const w = judgementWindow(r);
    expect(w.months.map(m => m.status)).toEqual(["partial", "gap", "complete"]);
    expect(w.complete).toBe(false);
    expect(w.missing).toEqual(["2026-04", "2026-05"]);
  });

  it("fewer than 3 months of history: the window names the months before it", () => {
    const r = accountCoverage({ batches: [cheque(1)], answers: [], today: TODAY,
      transactions: [...month(ID(1), "2026-05", 900, 100), ...month(ID(1), "2026-06", 900, 100)] });
    const w = judgementWindow(r);
    expect(w.months.map(m => [m.key, m.status])).toEqual([["2026-04", "none"], ["2026-05", "complete"], ["2026-06", "complete"]]);
    expect(w.complete).toBe(false);
  });

  it("this month is never the window's end", () => {
    const r = accountCoverage({ batches: [cheque(1)], answers: [], today: "2026-06-29",
      transactions: ["2026-03", "2026-04", "2026-05", "2026-06"].flatMap(ym => month(ID(1), ym, 900, 100)) });
    expect(bizStatus(r)["2026-06"]).toBe("partial");
    expect(judgementWindow(r).end).toBe("2026-05");
  });

  it("consecutive months with transactions read exactly as today", () => {
    const transactions = [
      ...month(ID(1), "2026-02", 1000.1, 300.3), ...month(ID(1), "2026-03", 2000, 999.99),
      tx(ID(1), "2026-04-05", 50), tx(ID(1), "2026-04-10", -20), // stops 20 days before the end: partial
    ];
    const today = aggregateTransactionsByMonth(transactions, { today: TODAY });
    const r = accountCoverage({ batches: [cheque(1)], answers: [], transactions, today: TODAY });
    expect(r.months.map(m => [m.key, m.status === "partial"])).toEqual(today.map(m => [m.period_month.slice(0, 7), m.partial]));
    r.months.forEach((m, i) => {
      expect(m.totals.revenue).toBe(today[i].revenue);
      expect(m.totals.expenses).toBe(today[i].expenses);
    });
  });

  it("no month counts as zero from balance evidence alone, on any path", () => {
    // A verified file across May, and matching balances between files: May is
    // still a gap with no totals, and the window has no average.
    const one = { batches: [cheque(1, verified({ period_start: "2026-03-05", period_end: "2026-06-28" }))],
      transactions: ["2026-03", "2026-04", "2026-06"].flatMap(ym => month(ID(1), ym, 900, 100)) };
    const r = accountCoverage({ ...one, answers: [], today: TODAY });
    const may = r.months.find(m => m.key === "2026-05");
    expect(may.status).toBe("gap");
    expect(may.totals).toBeNull();
    expect(judgementWindow(r).average).toBeNull();
    expect(r.accounts[0].months.some(m => m.status === "quiet")).toBe(false);
  });
});

// ─── D1: the window ends at the latest month that has ended ─────────────
// Founder's decision, 14 November 2026: on 15 July the window is April, May
// and June, whatever the statements cover. A missing June stays a gap inside
// it; the window never moves back to March to May to step round the gap.
describe("D1: the window is the last 3 calendar months that have ended", () => {
  const savings = n => batch(n, { account_label: "Savings" });
  const chequeMonths = (b, list) => list.flatMap(ym => month(b, ym, 100000, 80000));
  const savingsMonths = (b, list) => list.flatMap(ym => [tx(b, `${ym}-02`, 250), tx(b, `${ym}-28`, 250)]);
  // Cheque: March to June. Savings: March to May; June's statement is not uploaded.
  const recentGap = {
    batches: [cheque(1), savings(2)],
    transactions: [...chequeMonths(ID(1), ["2026-03", "2026-04", "2026-05", "2026-06"]), ...savingsMonths(ID(2), ["2026-03", "2026-04", "2026-05"])],
  };

  [["unanswered", []], ["still open", [{ account_key: "savings", kind: "still_open", slot: "status" }]]].forEach(([name, answers]) => {
    it(`a missing June for one account (${name}) is a gap inside April to June, never a move back to March to May`, () => {
      const w = judgementWindow(accountCoverage({ ...recentGap, answers, today: TODAY }));
      expect(w.end).toBe("2026-06");
      expect(w.months.map(m => [m.key, m.status])).toEqual([["2026-04", "complete"], ["2026-05", "complete"], ["2026-06", "gap"]]);
      expect(w.months[2].gapAccounts).toEqual(["savings"]);
      expect(w.complete).toBe(false);
      expect(w.missing).toEqual(["2026-06"]);
      expect(w.average).toBeNull();
    });
  });

  it("June's statement uploaded: the window is complete", () => {
    const full = { ...recentGap, transactions: [...recentGap.transactions, ...savingsMonths(ID(2), ["2026-06"])] };
    const w = judgementWindow(accountCoverage({ ...full, answers: [], today: TODAY }));
    expect(w.months.map(m => m.key)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(w.complete).toBe(true);
    // Each month 100,500 in and 80,000 out: a profit of R20,500 a month.
    expect(w.average.burn).toBe(-20500);
  });

  it("with no data since April, May and June are gaps and the window holds", () => {
    const r = accountCoverage({ batches: [cheque(1)], answers: [], today: TODAY, transactions: chequeMonths(ID(1), ["2026-02", "2026-03", "2026-04"]) });
    const w = judgementWindow(r);
    expect(w.months.map(m => [m.key, m.status])).toEqual([["2026-04", "complete"], ["2026-05", "gap"], ["2026-06", "gap"]]);
    expect(w.months[2].gapAccounts).toEqual(["cheque"]);
    expect(w.complete).toBe(false);
  });

  it("an account closed before the window is not expected in it", () => {
    const r = accountCoverage({ batches: [cheque(1)], today: TODAY, transactions: chequeMonths(ID(1), ["2026-02", "2026-03", "2026-04"]),
      answers: [{ account_key: "cheque", kind: "closed", slot: "status", closed_on: "2026-04-30" }] });
    expect(judgementWindow(r).months.map(m => m.status)).toEqual(["complete", "none", "none"]);
    expect(judgementWindow(r).complete).toBe(false);
  });

  it("on the 1st of a month, the month just ended closes the window", () => {
    const r = accountCoverage({ ...recentGap, answers: [], today: "2026-06-01" });
    expect(judgementWindow(r).months.map(m => m.key)).toEqual(["2026-03", "2026-04", "2026-05"]);
    expect(judgementWindow(r).complete).toBe(true);
  });

  // Affordability gives an answer only when all three months are complete; the
  // run rate must then rest on exactly those three calendar months.
  it("a complete window uses exactly the months, and the burn, of today's run rate", () => {
    const cases = [
      { batches: [cheque(1)], transactions: chequeMonths(ID(1), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) },
      { ...recentGap, transactions: [...recentGap.transactions, ...savingsMonths(ID(2), ["2026-06"])] },
      { batches: [cheque(1), savings(2)], transactions: [...chequeMonths(ID(1), ["2026-04", "2026-05", "2026-06"]), tx(ID(1), "2026-07-03", 500), ...savingsMonths(ID(2), ["2026-04", "2026-05", "2026-06"])] },
    ];
    cases.forEach(c => {
      const sorted = [...c.transactions].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
      const w = judgementWindow(accountCoverage({ ...c, transactions: sorted, answers: [], today: TODAY }));
      const rows = aggregateTransactionsByMonth(sorted, { today: TODAY });
      const runMonths = rows.filter(r => !r.partial).slice(-3).map(r => r.period_month.slice(0, 7));
      expect(w.complete).toBe(true);
      expect(w.months.map(m => m.key)).toEqual(runMonths);
      expect(w.average.burn).toBe(currentRunRate(rows).burn);
    });
  });
});

// ─── The run rate counts a confirmed quiet month as zero ─────────────────
// Founder's decision, 14 November 2026. A month the founder confirmed had no
// transactions, with a verified balance unchanged across it (D10a), is a month
// of zero in the run rate, so affordability's window and runway's burn rest on
// the same three calendar months. Any other empty month stays a gap: never zero.
describe("the run rate counts a confirmed quiet month as zero, and only that", () => {
  // The plan's case A: one verified Cheque file, 5 March to 28 June, no May rows.
  // March and April: R90,000 in, R100,000 out. June: R60,000 in, R100,000 out.
  const verifiedFile = cheque(1, verified({ period_start: "2026-03-05", period_end: "2026-06-28" }));
  const rowsA = [...month(ID(1), "2026-03", 90000), ...month(ID(1), "2026-04", 90000), ...month(ID(1), "2026-06", 60000)];
  const quietMay = [{ account_key: "cheque", kind: "no_transactions_month", slot: "month:2026-05", month: "2026-05-01" }];
  const NO_MANUAL = { mRev: 0, mExp: 0, mCash: 0, mCac: 0, mLtv: 0, mLeads: 0, mClose: 0 };
  // What the run rate is given, as the dashboard builds it.
  const runRows = (c, answers) => {
    const rows = aggregateTransactionsByMonth(c.transactions, { today: TODAY });
    return runRateRowsWithQuietMonths(rows, accountCoverage({ ...c, answers, today: TODAY }));
  };
  const runMonths = rows => rows.filter(r => !r.partial).slice(-3).map(r => r.period_month.slice(0, 7));
  const metrics = (c, answers) => {
    const rows = aggregateTransactionsByMonth(c.transactions, { today: TODAY });
    return computeMetrics(rows, NO_MANUAL, "safe", { currency: "ZAR", today: TODAY, runRateRows: runRows(c, answers),
      cash: { amount: 200000, on: TODAY, recorded: 0, lastDataOn: "2026-06-28" } });
  };
  const caseA = { batches: [verifiedFile], transactions: rowsA };

  it("confirmed: May counts as zero, and the window and the run rate use April, May and June", () => {
    const rows = runRows(caseA, quietMay);
    const w = judgementWindow(accountCoverage({ ...caseA, answers: quietMay, today: TODAY }));
    expect(runMonths(rows)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(w.months.map(m => m.key)).toEqual(runMonths(rows));
    const r = currentRunRate(rows);
    // (10,000 + 0 + 40,000) / 3 = 16,666.67 of burn.
    expect(r.burn).toBe(16666.67);
    expect(r.months).toBe(3);
    expect(w.average.burn).toBe(r.burn);
    expect(w.average.revenue).toBe(cents(r.revenue));   // (90,000 + 0 + 60,000) / 3 = 50,000
    expect(w.average.expenses).toBe(cents(r.expenses)); // (100,000 + 0 + 100,000) / 3 = 66,666.67
  });

  it("confirmed: runway is 200,000 / 16,666.67 = 12.0 months, as the plan works it", () => {
    const m = metrics(caseA, quietMay);
    expect(m.runMonths).toBe(3);
    expect(cents(m.runExp + m.runFinOut - m.runRev)).toBe(16666.67);
    expect(m.burnMonths).toBeCloseTo(12.0, 1);
  });

  it("not confirmed: May is not zero; the run rate skips it as before, and the window holds", () => {
    const rows = runRows(caseA, []);
    expect(rows.map(r => r.period_month.slice(0, 7))).toEqual(["2026-03", "2026-04", "2026-06"]);
    expect(currentRunRate(rows).burn).toBe(20000); // (10,000 + 10,000 + 40,000) / 3, unchanged
    expect(metrics(caseA, []).burnMonths).toBeCloseTo(10.0, 1);
    expect(judgementWindow(accountCoverage({ ...caseA, answers: [], today: TODAY })).complete).toBe(false);
  });

  it("confirmed but no balance to check (case B): not zero", () => {
    const caseB = { batches: [cheque(1, { period_start: "2026-03-05", period_end: "2026-04-28" }), cheque(2, { period_start: "2026-06-05", period_end: "2026-06-28" })],
      transactions: [...month(ID(1), "2026-03", 90000), ...month(ID(1), "2026-04", 90000), ...month(ID(2), "2026-06", 60000)] };
    const rows = runRows(caseB, quietMay);
    expect(rows.some(r => r.period_month === "2026-05-01")).toBe(false);
    expect(currentRunRate(rows).burn).toBe(20000);
    expect(judgementWindow(accountCoverage({ ...caseB, answers: quietMay, today: TODAY })).complete).toBe(false);
  });

  it("confirmed but the balance moved (case C): not zero", () => {
    const caseC = {
      batches: [
        cheque(1, verified({ period_start: "2026-03-05", period_end: "2026-04-28", closing_balance: 50000, reconciliation_detail: { openingBalance: 70000, closingBalance: 50000 } })),
        cheque(2, verified({ period_start: "2026-06-05", period_end: "2026-06-28", reconciliation_detail: { openingBalance: 35000, closingBalance: -5000 } })),
      ],
      transactions: [...month(ID(1), "2026-03", 90000), ...month(ID(1), "2026-04", 90000), ...month(ID(2), "2026-06", 60000)],
    };
    const rows = runRows(caseC, quietMay);
    expect(rows.some(r => r.period_month === "2026-05-01")).toBe(false);
    expect(currentRunRate(rows).burn).toBe(20000);
    expect(judgementWindow(accountCoverage({ ...caseC, answers: quietMay, today: TODAY })).complete).toBe(false);
  });

  it("a balance unchanged but not confirmed by the founder: not zero", () => {
    // Case A's file proves the balance did not move across May, but no one said
    // the account had no transactions.
    expect(runRows(caseA, []).some(r => r.period_month === "2026-05-01")).toBe(false);
  });

  it("one account quiet while another traded: the month is counted once, from its transactions", () => {
    const savings = batch(2, { account_label: "Savings" });
    const c = { batches: [verifiedFile, savings],
      transactions: [...rowsA, ...["04", "05", "06"].flatMap(m => [tx(ID(2), `2026-${m}-02`, 250), tx(ID(2), `2026-${m}-28`, 250)])]
        .sort((a, b) => a.txn_date.localeCompare(b.txn_date)) };
    const rows = runRows(c, quietMay);
    const may = rows.filter(r => r.period_month === "2026-05-01");
    expect(may).toHaveLength(1);
    expect(may[0].revenue).toBe(500); // Savings' R500; Cheque's quiet May adds nothing
    const w = judgementWindow(accountCoverage({ ...c, answers: quietMay, today: TODAY }));
    expect(w.complete).toBe(true);
    expect(w.months.map(m => m.key)).toEqual(runMonths(rows));
    expect(w.average.burn).toBe(currentRunRate(rows).burn);
  });

  it("a quiet month never stands in for burn on its own", () => {
    // The data starts on 20 April and stops on 10 June, so April and June are
    // partial and no month with transactions is complete. A confirmed quiet May
    // would otherwise be the only month and read as no burn at all; the run
    // rate keeps its daily measure across the days the data covers.
    const c = { batches: [cheque(1, verified({ period_start: "2026-04-20", period_end: "2026-06-10" }))],
      transactions: [tx(ID(1), "2026-04-20", -30000), tx(ID(1), "2026-04-28", 10000), tx(ID(1), "2026-06-02", 10000), tx(ID(1), "2026-06-10", -30000)] };
    expect(statusOf(accountCoverage({ ...c, answers: quietMay, today: TODAY }), "cheque")["2026-05"]).toBe("quiet");
    const plain = aggregateTransactionsByMonth(c.transactions, { today: TODAY });
    const rows = runRows(c, quietMay);
    expect(rows).toEqual(plain);
    // 60,000 out less 20,000 in, over the 52 days from 20 April to 10 June, times 30.44.
    expect(currentRunRate(rows).burn).toBe(cents((40000 / 52) * 30.44));
  });

  it("adds nothing when there is no coverage reading", () => {
    const rows = aggregateTransactionsByMonth(rowsA, { today: TODAY });
    expect(runRateRowsWithQuietMonths(rows, null)).toEqual(rows);
  });
});

function cents(v) { return Math.round(v * 100) / 100; }

// ─── Linked accounts whose statements overlap ───────────────────────────
// Duplicates are matched per account name, so the same bank account uploaded
// under two names holds its overlapping rows twice. Once the founder says two
// names are one account, months both cover may be counted twice. Nothing
// guesses which rows are duplicates: those months are held.
describe("linked accounts with overlapping statements are held, never guessed", () => {
  const second = (n, label) => batch(n, { account_label: label });
  const months6 = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  const rowsFor = (b, list) => list.flatMap(ym => month(b, ym, 100000, 80000));
  const link = (from, to) => [{ account_key: from, kind: "same_as", slot: "status", same_as_key: to }];
  const cov = (c, answers) => accountCoverage({ ...c, transactions: [...c.transactions].sort((a, b) => a.txn_date.localeCompare(b.txn_date)), answers, today: TODAY });
  // Cheque: January to June. "Business cheque": the same April to June rows again.
  const twice = { batches: [cheque(1), second(2, "Business cheque")], transactions: [...rowsFor(ID(1), months6), ...rowsFor(ID(2), months6.slice(3))] };

  it("linked, both covering April to June: those months are held as possibly counted twice", () => {
    const r = cov(twice, link("business cheque", "cheque"));
    const a = r.accounts[0];
    expect(a.overlaps).toEqual([{ a: "cheque", b: "business cheque", from: "2026-04-05", to: "2026-06-28" }]);
    expect(statusOf(r, "cheque")).toEqual({ "2026-01": "complete", "2026-02": "complete", "2026-03": "complete", "2026-04": "overlap", "2026-05": "overlap", "2026-06": "overlap" });
    ["2026-04", "2026-05", "2026-06"].forEach(k => {
      const m = r.months.find(x => x.key === k);
      expect(m.status).toBe("overlap");
      expect(m.totals).toBeNull(); // not a figure: it may hold the same money twice
      expect(m.overlapAccounts).toEqual(["cheque"]);
    });
    const w = judgementWindow(r);
    expect(w.complete).toBe(false);
    expect(w.average).toBeNull();
    expect(w.missing).toEqual(["2026-04", "2026-05", "2026-06"]);
  });

  it("not linked: nothing says they are one account, so nothing is flagged", () => {
    const r = cov(twice, []);
    expect(r.accounts.every(a => a.overlaps.length === 0)).toBe(true);
    expect(bizStatus(r)["2026-05"]).toBe("complete");
  });

  it("linked with no dates in common: one clean history", () => {
    const apart = { batches: twice.batches, transactions: [...rowsFor(ID(1), months6.slice(0, 3)), ...rowsFor(ID(2), months6.slice(3))] };
    const r = cov(apart, link("business cheque", "cheque"));
    expect(r.accounts[0].overlaps).toEqual([]);
    expect(Object.values(statusOf(r, "cheque")).every(s => s === "complete")).toBe(true);
    expect(judgementWindow(r).complete).toBe(true);
  });

  it("only the months both cover are held", () => {
    // Cheque runs to 15 April; Business cheque starts on 1 April.
    const part = { batches: twice.batches, transactions: [...rowsFor(ID(1), months6.slice(0, 3)), tx(ID(1), "2026-04-05", 100000), tx(ID(1), "2026-04-15", -80000),
      tx(ID(2), "2026-04-01", 100000), tx(ID(2), "2026-04-28", -80000), ...rowsFor(ID(2), months6.slice(4))] };
    const r = cov(part, link("business cheque", "cheque"));
    expect(r.accounts[0].overlaps).toEqual([{ a: "cheque", b: "business cheque", from: "2026-04-01", to: "2026-04-15" }]);
    expect(statusOf(r, "cheque")).toMatchObject({ "2026-03": "complete", "2026-04": "overlap", "2026-05": "complete", "2026-06": "complete" });
  });

  it("two unnamed uploads linked: their rows were already matched against each other at upload, so nothing is held", () => {
    const c = { batches: [batch(1), batch(2)], transactions: [...rowsFor(ID(1), months6.slice(0, 4)), ...rowsFor(ID(2), months6.slice(3))] };
    const r = cov(c, link(`upload:${ID(1)}`, `upload:${ID(2)}`));
    expect(r.accounts[0].overlaps).toEqual([]);
    expect(statusOf(r, `upload:${ID(2)}`)["2026-04"]).toBe("complete");
  });

  it("an unnamed upload linked to a named account it overlaps: held", () => {
    const c = { batches: [cheque(1), batch(2)], transactions: [...rowsFor(ID(1), months6), ...rowsFor(ID(2), ["2026-03"])] };
    const r = cov(c, link(`upload:${ID(2)}`, "cheque"));
    expect(r.accounts[0].overlaps).toHaveLength(1);
    expect(statusOf(r, "cheque")).toMatchObject({ "2026-02": "complete", "2026-03": "overlap", "2026-04": "complete" });
  });
});
