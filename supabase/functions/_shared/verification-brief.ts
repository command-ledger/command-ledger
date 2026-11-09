// What the AI advisor is told about how far the figures can be trusted, and the
// check on what it writes back. A rule in a prompt is a request, so the claims
// that matter are also removed in code: the advisor must never describe figures
// as verified when any file behind them is not reconciled, never as confirmed by
// a bank (Command Ledger has no bank connection, so nothing ever is), and never
// call estimated cash verified, reconciled or confirmed. Passing a running-balance
// check means a file agrees with itself, which is all "reconciled" may say.
//
// No Deno APIs and no remote imports, so import-verification.test.js runs this
// exact code. Keep it that way.

export type DataVerification = { status?: string; notReconciledFiles?: number; totalFiles?: number } | null | undefined

export function verificationPromptLine(v: DataVerification): string {
  if (v?.status === "verified") {
    return "DATA VERIFICATION: Every source file passed its balance check against its own running balance. This is not confirmation from a bank, so never call the figures bank-verified."
  }
  if (v?.status === "not_reconciled") {
    return `DATA VERIFICATION: NOT RECONCILED. ${v.notReconciledFiles} of ${v.totalFiles} source file(s) have not been verified against a bank running balance. The figures are based on uploaded transaction data. Say so where it matters, and never call any figure or balance verified, reconciled or confirmed.`
  }
  return "DATA VERIFICATION: No file has been reconciled. Never call any figure or balance verified, reconciled or confirmed."
}

export const VERIFICATION_RULE = "Follow DATA VERIFICATION below. Figures that are not reconciled are never verified bank balances, whatever else this brief says."

// A claim just after "not", "never" and the like is a true statement and stays:
// "not verified", "has not been confirmed by the bank".
const NOT = String.raw`(?<!\b(?:not|never|n't|cannot|can't)\s+(?:been\s+|be\s+|yet\s+|yet\s+been\s+)?)`
// The tail of "not bank-verified" is not a claim of its own. Matching it alone
// once turned that true statement into "not bank-unreconciled".
const NOT_TAIL = String.raw`(?<!bank[- ])`
// Bank confirmation: never true, whatever the files' status.
const BANK_CLAIM = new RegExp(String.raw`${NOT}\b(?:bank[- ](?:verified|confirmed)|(?:verified|confirmed|validated|certified)\s+(?:by|with)\s+(?:the\s+|your\s+|a\s+)?bank)\b`, "gi")
// "verified", "reconciled", but not "unreconciled".
const CLAIM = new RegExp(String.raw`${NOT}${NOT_TAIL}\b(?:bank[- ])?(?:verified|reconciled)\b`, "gi")
// In a sentence about estimated cash, any claim that it was checked: an estimate
// is worked out, never reconciled or confirmed.
const ESTIMATE_CLAIM = new RegExp(String.raw`${NOT}${NOT_TAIL}\b(?:bank[- ])?(?:verified|reconciled|confirmed|validated)(?:\s+(?:by|with)\s+(?:the\s+|your\s+|a\s+)?bank)?\b`, "gi")
// A sentence ends at . ! or ? followed by a space or the end, so "R 1,234.56"
// stays in one piece.
const SENTENCE = /[\s\S]*?(?:[.!?](?=\s|$)|$)/g

const RECONCILED_NOTE = "Reconciled means each file's balances agree with its own transactions; no bank has confirmed them."
const UNRECONCILED_NOTE = "Figures are not reconciled to a bank running balance."
const ESTIMATE_NOTE = "Estimated cash today is worked out from the saved balance and recorded transactions: an estimate, not a bank balance."

export function guardVerificationClaims<T extends Record<string, unknown>>(recommendation: T, status: string | undefined | null): T {
  const reconciled = status === "verified"
  let bank = false, estimate = false
  const out: Record<string, unknown> = { ...recommendation }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string") continue
    let text = value.replace(SENTENCE, s => /\bestimat/i.test(s) ? s.replace(ESTIMATE_CLAIM, () => { estimate = true; return "estimated" }) : s)
    text = text.replace(BANK_CLAIM, () => { bank = true; return reconciled ? "reconciled" : "unreconciled" })
    if (!reconciled) text = text.replace(CLAIM, "unreconciled")
    out[key] = text
  }
  // Every file reconciled and nothing overstated: the reply stands as written.
  if (reconciled && !bank && !estimate) return recommendation
  const notes = [reconciled ? (bank ? RECONCILED_NOTE : "") : UNRECONCILED_NOTE, estimate ? ESTIMATE_NOTE : ""].filter(Boolean)
  const reason = typeof out.confidenceReason === "string" ? out.confidenceReason : ""
  out.confidenceReason = [reason, ...notes].join(" ").trim()
  return out as T
}
