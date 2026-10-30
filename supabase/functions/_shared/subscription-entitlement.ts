// Which PayPal subscription a profile's access belongs to, and what an event
// about some subscription may do to it.
//
// A customer can hold more than one subscription: upgrading from Command
// Ledger to Command Advisory creates a second one, and PayPal keeps billing
// the first until someone cancels it. Before profiles recorded which
// subscription granted their plan, every event applied to the profile
// regardless of which subscription it came from — so the old $99
// subscription's monthly renewal set an Advisory customer back to "software",
// and cancelling it removed access the Advisory subscription was paying for.
//
// No imports and no Deno APIs, so src/lib/subscription-entitlement.test.js can
// import this exact file. Keep it that way.

export type EventSub = {
  id: string
  planKey: string | undefined
  // ISO timestamp from PayPal's subscription create_time.
  createTime: string | null | undefined
}

// The subscription currently on file for the profile, as PayPal reports it
// now. null when the profile has none on file.
export type StoredSub = {
  id: string
  status: string | null | undefined // PayPal status: ACTIVE, SUSPENDED, CANCELLED, EXPIRED, ...
  createTime: string | null | undefined
} | null

export type EntitlementDecision =
  | { kind: "grant"; planKey: string; subscriptionId: string; duplicateOf?: string }
  | { kind: "revoke" }
  | { kind: "suspend" }
  | { kind: "ignore"; reason: string; duplicateOf?: string }

const ENDED = new Set(["CANCELLED", "EXPIRED"])

// A grant event: ACTIVATED, or a completed renewal payment.
// `onFileId` is profiles.paypal_subscription_id. `stored` must be supplied
// whenever onFileId is set and differs from the event's subscription.
export function decideGrant(event: EventSub, onFileId: string | null | undefined, stored: StoredSub): EntitlementDecision {
  if (!event.planKey) return { kind: "ignore", reason: "unmapped plan id" }

  // Nothing on file (a new subscriber, or a profile from before this column
  // existed), or the subscription already on file: it is the one that counts.
  if (!onFileId || onFileId === event.id) {
    return { kind: "grant", planKey: event.planKey, subscriptionId: event.id }
  }

  // A different subscription is on file. If it has ended, this one replaces it.
  if (!stored) throw new Error(`Subscription ${onFileId} on file could not be read; retry.`)
  if (stored.status && ENDED.has(stored.status.toUpperCase())) {
    return { kind: "grant", planKey: event.planKey, subscriptionId: event.id }
  }

  // Both are live: the customer is paying twice. The newer subscription is
  // what they chose last, so it decides access; the older one must be
  // cancelled by hand (and refunded if appropriate) — this code does not
  // cancel a customer's subscription on its own.
  const eventTime = Date.parse(event.createTime ?? "")
  const storedTime = Date.parse(stored.createTime ?? "")
  if (Number.isFinite(eventTime) && Number.isFinite(storedTime) && eventTime > storedTime) {
    return { kind: "grant", planKey: event.planKey, subscriptionId: event.id, duplicateOf: stored.id }
  }
  return { kind: "ignore", reason: "older than the live subscription on file", duplicateOf: event.id }
}

// A CANCELLED / EXPIRED / SUSPENDED event for subscription `eventId`. Only the
// subscription on file can take access away. A profile with nothing on file
// predates this column; the event is applied to it, as it always was.
export function decideEnd(kind: "revoke" | "suspend", eventId: string | null | undefined, onFileId: string | null | undefined): EntitlementDecision {
  if (!onFileId || onFileId === eventId) return { kind }
  return { kind: "ignore", reason: "not the subscription that grants this profile's plan" }
}
