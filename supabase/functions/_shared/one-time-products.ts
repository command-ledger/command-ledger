// One-time purchases, and the checks that decide whether money received for
// one is what we expected.
//
// PayPal subscriptions are priced on a PayPal plan. One-time payments have no
// plan: each purchase is a PayPal order carrying its own amount. Whoever
// creates the order sets the price, so orders are created only on the server
// (diagnostic-order) from the amount below. A browser-created order would let
// a buyer edit the amount before paying.
//
// This module has no imports and no Deno APIs, so the same code runs in the
// Edge Functions and under Vitest (src/lib/one-time-products.test.js).

export const DIAGNOSTIC = {
  key: "diagnostic",
  amountUsd: 750,
  currency: "USD",
  description: "Command Ledger Financial Diagnostic",
} as const

// PayPal expects a decimal string with two places.
export function paypalAmount(amountUsd: number): string {
  return amountUsd.toFixed(2)
}

export type CaptureVerdict =
  | { ok: true; state: "completed" | "pending"; captureId: string }
  | { ok: false; state: "not_captured" | "review"; reason: string; captureId: string | null }

// Judges a PayPal capture: the capture object from an order-capture response
// (purchase_units[].payments.captures[]) or the resource of a
// PAYMENT.CAPTURE.COMPLETED webhook event.
//
//   completed    — money received, and it matches what we sold
//   pending      — PayPal accepted it but has not released the funds yet
//                  (e.g. an eCheck); a later webhook completes it
//   not_captured — no money moved; the buyer can try again
//   review       — money DID move, but not on the terms we sold. Never grant
//                  anything for it: a human must look.
//
// expectedUserId is optional because a webhook resource does not always echo
// custom_id; when it is supplied, a mismatch is a review.
// deno-lint-ignore no-explicit-any
export function verifyDiagnosticCapture(capture: any, expectedUserId?: string): CaptureVerdict {
  const captureId = typeof capture?.id === "string" ? capture.id : null
  const status = capture?.status

  if (!captureId || (status !== "COMPLETED" && status !== "PENDING")) {
    return { ok: false, state: "not_captured", reason: `capture status ${status ?? "missing"}`, captureId }
  }

  const value = Number(capture?.amount?.value)
  const currency = capture?.amount?.currency_code
  if (currency !== DIAGNOSTIC.currency || !Number.isFinite(value) || value !== DIAGNOSTIC.amountUsd) {
    return { ok: false, state: "review", reason: `captured ${capture?.amount?.value ?? "?"} ${currency ?? "?"}, expected ${paypalAmount(DIAGNOSTIC.amountUsd)} ${DIAGNOSTIC.currency}`, captureId }
  }

  if (expectedUserId && capture?.custom_id && capture.custom_id !== expectedUserId) {
    return { ok: false, state: "review", reason: "capture belongs to a different user", captureId }
  }

  return { ok: true, state: status === "COMPLETED" ? "completed" : "pending", captureId }
}
