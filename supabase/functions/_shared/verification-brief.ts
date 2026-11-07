// What the AI advisor is told about how far the figures can be trusted, and the
// check on what it writes back. A rule in a prompt is a request, so the claim
// that matters is also removed in code: the advisor must never describe figures
// as verified when any file behind them is not reconciled.
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

// "bank-verified", "verified", "reconciled", but not "not verified",
// "not been reconciled" or "unreconciled", which are true.
const CLAIM = /(?<!\b(?:not|never|n't|cannot|can't)\s+(?:been\s+|be\s+|yet\s+|yet\s+been\s+)?)\b(?:bank[- ])?(?:verified|reconciled)\b/gi

export function guardVerificationClaims<T extends Record<string, unknown>>(recommendation: T, status: string | undefined | null): T {
  if (status === "verified") return recommendation
  const out: Record<string, unknown> = { ...recommendation }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string") out[key] = value.replace(CLAIM, "unreconciled")
  }
  const reason = typeof out.confidenceReason === "string" ? out.confidenceReason : ""
  out.confidenceReason = `${reason} Figures are not reconciled to a bank running balance.`.trim()
  return out as T
}
