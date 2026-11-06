// Reads a verified PayPal webhook event into what this app needs to act on it.
//
// PayPal's events do not share a shape: a subscription event carries the
// subscription, a sale event names it in billing_agreement_id, a refund may
// point at the original payment only through a link, and a dispute lists the
// transactions it concerns. Everything that depends on those shapes is here, so
// it can be tested with fixtures. A real event cannot be produced on demand.
//
// No imports and no Deno APIs, so src/lib/payment-events.test.js can import this
// exact file. Keep it that way.

export const isUuid = (s: unknown): boolean =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export const isSubscriptionId = (s: unknown): boolean =>
  typeof s === "string" && /^I-[A-Z0-9]{6,40}$/.test(s)

// PayPal webhook ids are short and upper case. PAYPAL_WEBHOOK_ID once held an
// 80-character value that was not a webhook id at all, so every real event
// would have failed its signature check with no sign of why.
export const looksLikeWebhookId = (s: unknown): boolean =>
  typeof s === "string" && /^[0-9A-Z]{10,30}$/.test(s)

export type EventAction =
  | "grant"              // access may start or continue
  | "end"                // the subscription is over
  | "suspend"            // PayPal paused it after failed payments
  | "payment_failed"     // a payment did not go through
  | "diagnostic_capture" // money received for a one-time order
  | "refund"
  | "reversal"           // money taken back through a bank or card chargeback
  | "dispute"
  | "dispute_resolved"
  | "record"             // kept for the record; nothing to do

export type ReadEvent = {
  action: EventAction
  // The id of the resource the event is about.
  resourceId: string | null
  subscriptionId: string | null
  // The original sale or capture a refund, reversal or dispute concerns.
  transactionId: string | null
  orderId: string | null
  userId: string | null
  amount: number | null
  currency: string | null
  // A verified payment event is itself proof that money arrived.
  paymentConfirmed: boolean
}

// deno-lint-ignore no-explicit-any
function money(resource: any): { amount: number | null; currency: string | null } {
  const m = resource?.amount ?? resource?.dispute_amount ?? null
  const raw = m?.total ?? m?.value
  const n = Math.abs(Number(raw))
  return {
    amount: raw !== undefined && raw !== null && Number.isFinite(n) ? n : null,
    currency: m?.currency ?? m?.currency_code ?? null,
  }
}

// The last path segment of the first link with one of these rels.
// deno-lint-ignore no-explicit-any
function linkedId(resource: any, rels: string[]): string | null {
  const links = Array.isArray(resource?.links) ? resource.links : []
  for (const rel of rels) {
    // deno-lint-ignore no-explicit-any
    const link = links.find((l: any) => l?.rel === rel && typeof l?.href === "string")
    if (link) {
      const seg = link.href.split("?")[0].split("/").filter(Boolean).pop()
      if (seg) return seg
    }
  }
  return null
}

const ACTIONS: Record<string, EventAction> = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "grant",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED": "grant",
  "BILLING.SUBSCRIPTION.CANCELLED": "end",
  "BILLING.SUBSCRIPTION.EXPIRED": "end",
  "BILLING.SUBSCRIPTION.SUSPENDED": "suspend",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "payment_failed",
  "PAYMENT.SALE.DENIED": "payment_failed",
  "PAYMENT.CAPTURE.DENIED": "payment_failed",
  "PAYMENT.SALE.REFUNDED": "refund",
  "PAYMENT.CAPTURE.REFUNDED": "refund",
  "PAYMENT.SALE.REVERSED": "reversal",
  "PAYMENT.CAPTURE.REVERSED": "reversal",
  "CUSTOMER.DISPUTE.CREATED": "dispute",
  "CUSTOMER.DISPUTE.UPDATED": "dispute",
  "CUSTOMER.DISPUTE.RESOLVED": "dispute_resolved",
}

// deno-lint-ignore no-explicit-any
export function readEvent(event: any): ReadEvent {
  const type = String(event?.event_type || "")
  const r = event?.resource ?? {}
  const related = r?.supplementary_data?.related_ids ?? {}
  const { amount, currency } = money(r)
  const customId = r?.custom_id ?? r?.custom ?? null
  const out: ReadEvent = {
    action: ACTIONS[type] ?? "record",
    resourceId: r?.id ?? r?.dispute_id ?? null,
    subscriptionId: r?.billing_agreement_id ?? related?.subscription_id ?? null,
    transactionId: null,
    orderId: related?.order_id ?? null,
    userId: isUuid(customId) ? customId : null,
    amount,
    currency,
    paymentConfirmed: false,
  }

  if (type.startsWith("BILLING.SUBSCRIPTION.")) {
    out.subscriptionId = r?.id ?? null
    return out
  }

  if (type === "PAYMENT.SALE.COMPLETED" || type === "PAYMENT.CAPTURE.COMPLETED") {
    out.transactionId = r?.id ?? null
    if (out.subscriptionId) {
      out.action = "grant"
      out.paymentConfirmed = true
    } else if (type === "PAYMENT.CAPTURE.COMPLETED" && out.orderId) {
      out.action = "diagnostic_capture"
    }
    return out
  }

  if (out.action === "refund" || out.action === "reversal") {
    out.transactionId = r?.sale_id ?? r?.capture_id ?? linkedId(r, ["sale", "up", "capture"])
    return out
  }

  if (out.action === "dispute" || out.action === "dispute_resolved") {
    const tx = Array.isArray(r?.disputed_transactions) ? r.disputed_transactions[0] : null
    out.transactionId = tx?.seller_transaction_id ?? null
    const custom = tx?.custom ?? null
    if (!out.userId && isUuid(custom)) out.userId = custom
    return out
  }

  if (out.action === "payment_failed") out.transactionId = r?.id ?? null
  return out
}

// A dispute only counts as a chargeback once it comes from the bank or card
// network. A buyer's own inquiry inside PayPal does not take access away.
// deno-lint-ignore no-explicit-any
export function isChargeback(resource: any): boolean {
  return resource?.dispute_life_cycle_stage === "CHARGEBACK" || resource?.dispute_channel === "EXTERNAL"
}

// deno-lint-ignore no-explicit-any
export function disputeWonBySeller(resource: any): boolean {
  const code = resource?.dispute_outcome?.outcome_code
  return code === "RESOLVED_SELLER_FAVOUR" || code === "CANCELED_BY_BUYER" || code === "DENIED"
}

// A one-time order is marked refunded only when the whole amount came back. A
// part refund changes nothing automatically; a person decides what it means.
export function refundCoversOrder(refundAmount: number | null, orderAmount: number): boolean {
  return refundAmount !== null && Number.isFinite(refundAmount) && refundAmount >= orderAmount
}
