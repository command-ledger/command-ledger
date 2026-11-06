// What happens to a verified PayPal event. paypal-webhook checks the signature
// and hands the event here.
//
// Every event is stored in payment_events before it is acted on, keyed by
// PayPal's event id. A duplicate is recognised and skipped. A failure is
// recorded and thrown, so the webhook answers 500 and PayPal redelivers it.
// Nothing an event says about a subscription is trusted on its own: access is
// decided from PayPal's current record, which also makes late and out-of-order
// events safe.
//
// No Deno APIs and no remote imports, so src/lib/payment-webhook.test.js can run
// this exact code against a simulated PayPal and database. Keep it that way, or
// the payment acceptance tests stop testing what ships.

import { verifyDiagnosticCapture } from "./one-time-products.ts"
import { decideEnd } from "./subscription-entitlement.ts"
import { disputeWonBySeller, isChargeback, readEvent, refundCoversOrder, type ReadEvent } from "./payment-events.ts"

// What became of an event. An unexpected failure is thrown instead.
type Result = { status: "processed" | "ignored" | "needs_review"; detail?: string; userId?: string | null; subscriptionId?: string | null }

// deno-lint-ignore no-explicit-any
export function createEventProcessor(supabase: any, access: any) {
  // Records the event, or recognises it. Returns false when it has already been
  // dealt with, so a redelivery changes nothing. A failure here throws: an event
  // we cannot record is answered with 500 and PayPal sends it again.
  // deno-lint-ignore no-explicit-any
  async function beginEvent(event: any, read: ReadEvent): Promise<boolean> {
    const { data: created, error } = await supabase
      .from("payment_events")
      .upsert({
        provider: "paypal",
        event_id: event.id,
        event_type: event.event_type,
        resource_id: read.resourceId,
        subscription_id: read.subscriptionId,
        transaction_id: read.transactionId,
        user_id: read.userId,
        amount: read.amount,
        currency: read.currency,
      }, { onConflict: "provider,event_id", ignoreDuplicates: true })
      .select("id")
    if (error) throw new Error(`payment_events insert failed: ${error.message}`)
    if (created && created.length > 0) return true

    const { data: seen, error: readErr } = await supabase
      .from("payment_events")
      .select("id, status, attempts")
      .eq("provider", "paypal")
      .eq("event_id", event.id)
      .single()
    if (readErr) throw new Error(`payment_events read failed: ${readErr.message}`)
    if (seen.status === "failed" || seen.status === "received") {
      const { error: updErr } = await supabase.from("payment_events").update({ attempts: (seen.attempts ?? 1) + 1 }).eq("id", seen.id)
      if (updErr) console.error("payment_events attempt count failed.", { message: updErr.message })
      return true
    }
    return false
  }

  async function finishEvent(eventId: string, fields: Record<string, unknown>) {
    const { error } = await supabase
      .from("payment_events")
      .update({ ...fields, processed_at: new Date().toISOString() })
      .eq("provider", "paypal")
      .eq("event_id", eventId)
    if (error) console.error("payment_events update failed.", { eventId, message: error.message })
  }

  // Finds what a refund, reversal or dispute concerns: a one-time order, or a
  // subscription payment seen earlier.
  async function findPayment(read: ReadEvent) {
    if (read.transactionId) {
      const { data: order, error } = await supabase
        .from("diagnostic_orders")
        .select("id, user_id, amount_usd, status")
        .eq("paypal_capture_id", read.transactionId)
        .maybeSingle()
      if (error) throw new Error(`diagnostic_orders lookup failed: ${error.message}`)
      if (order) return { order, subscriptionId: null, userId: order.user_id as string | null }

      const { data: paid, error: paidErr } = await supabase
        .from("payment_events")
        .select("subscription_id, user_id")
        .eq("provider", "paypal")
        .eq("transaction_id", read.transactionId)
        .in("event_type", ["PAYMENT.SALE.COMPLETED", "PAYMENT.CAPTURE.COMPLETED"])
        .limit(1)
        .maybeSingle()
      if (paidErr) throw new Error(`payment_events lookup failed: ${paidErr.message}`)
      if (paid?.subscription_id) return { order: null, subscriptionId: paid.subscription_id as string, userId: (paid.user_id ?? read.userId) as string | null }
    }
    return { order: null, subscriptionId: read.subscriptionId, userId: read.userId }
  }

  // Records a one-time Financial Diagnostic payment from its capture event. The
  // buyer's browser normally records it through diagnostic-order, but a browser
  // closed between paying and that call returning would otherwise leave money
  // received with no record. Idempotent: an order already completed or under
  // review is left alone. A database failure throws, so PayPal redelivers.
  // deno-lint-ignore no-explicit-any
  async function reconcileDiagnosticCapture(orderId: string, capture: any): Promise<Result> {
    const { data: row, error } = await supabase
      .from("diagnostic_orders")
      .select("id, status, user_id")
      .eq("paypal_order_id", orderId)
      .maybeSingle()
    if (error) throw new Error(`diagnostic_orders lookup failed: ${error.message}`)
    if (!row) return { status: "needs_review", detail: "Money captured for an order this app did not create." }
    if (row.status === "completed" || row.status === "review") return { status: "ignored", detail: "Order already recorded.", userId: row.user_id }

    const verdict = verifyDiagnosticCapture(capture, row.user_id ?? undefined)
    if (verdict.ok) {
      const { error: updErr } = await supabase.from("diagnostic_orders").update({
        status: verdict.state,
        paypal_capture_id: verdict.captureId,
        completed_at: verdict.state === "completed" ? new Date().toISOString() : null,
      }).eq("id", row.id)
      if (updErr) throw new Error(`diagnostic_orders update failed: ${updErr.message}`)
      return { status: "processed", detail: `Diagnostic ${verdict.state}.`, userId: row.user_id }
    }
    if (verdict.state === "review") {
      console.error("Diagnostic capture needs review.", { orderId, reason: verdict.reason })
      const { error: revErr } = await supabase.from("diagnostic_orders").update({
        status: "review",
        review_reason: verdict.reason,
        paypal_capture_id: verdict.captureId,
      }).eq("id", row.id)
      if (revErr) throw new Error(`diagnostic_orders review update failed: ${revErr.message}`)
      return { status: "needs_review", detail: `Diagnostic needs review: ${verdict.reason}`, userId: row.user_id }
    }
    return { status: "ignored", detail: `Capture not recorded: ${verdict.reason}`, userId: row.user_id }
  }

  // A verified payment or activation. Access is decided from PayPal's current
  // record of the subscription, not from the event.
  async function handleGrant(read: ReadEvent, accessToken: string): Promise<Result> {
    if (!read.subscriptionId) return { status: "needs_review", detail: "Payment event names no subscription." }
    const sub = await access.fetchSubscription(read.subscriptionId, accessToken)
    if (!sub) throw new Error(`Subscription ${read.subscriptionId} could not be found at PayPal; retry.`)
    const out = await access.applyGrant(sub, accessToken, { paymentConfirmed: read.paymentConfirmed })
    const ids = { subscriptionId: read.subscriptionId, userId: sub.custom_id ?? null }
    if (out.kind === "granted") return { status: "processed", detail: `Access granted: ${out.planKey}.`, ...ids }
    if (out.kind === "waiting") {
      // Money arrived but PayPal has not caught up: retry. Otherwise the payment
      // event that follows will do it.
      if (read.paymentConfirmed) throw new Error(`Paid, but ${out.reason}; retry.`)
      return { status: "ignored", detail: `Waiting: ${out.reason}.`, ...ids }
    }
    if (out.kind === "refused") {
      // An ended subscription is the expected case: a late event after a cancel.
      const ended = /subscription is (CANCELLED|EXPIRED|SUSPENDED)/.test(out.reason)
      return { status: ended ? "ignored" : "needs_review", detail: out.reason, ...ids }
    }
    return { status: "ignored", detail: out.reason, ...ids }
  }

  // deno-lint-ignore no-explicit-any
  async function handleEnd(event: any, read: ReadEvent, kind: "revoke" | "suspend"): Promise<Result> {
    const userId = read.userId
    if (!userId) return { status: "needs_review", detail: "Subscription ended but names no user.", subscriptionId: read.subscriptionId }
    // Only the subscription on file can end or suspend access; a superseded
    // subscription ending must not remove access another one is paying for.
    const profile = await access.readProfile(userId)
    const decision = decideEnd(kind, read.subscriptionId, profile?.paypal_subscription_id ?? null)
    const ids = { userId, subscriptionId: read.subscriptionId }
    if (decision.kind === "ignore") return { status: "ignored", detail: decision.reason, ...ids }
    if (kind === "suspend") {
      // A grace period: recorded, but the plan stays. A later payment or
      // RE-ACTIVATED event restores "active".
      await access.setProfile(userId, { status: "suspended" })
      return { status: "processed", detail: "Subscription suspended; access kept while PayPal retries.", ...ids }
    }
    const status = event.event_type === "BILLING.SUBSCRIPTION.EXPIRED" ? "expired" : "canceled"
    await access.setProfile(userId, { plan: null, status })
    if (read.subscriptionId) await access.markCheckout(read.subscriptionId, { status: "failed", detail: `Subscription ${status}.` })
    return { status: "processed", detail: `Access ended: ${status}.`, ...ids }
  }

  // A chargeback takes access away at once. The order or subscription stays on
  // record for a person to deal with, and winning the dispute restores access.
  async function holdForChargeback(read: ReadEvent): Promise<Result> {
    const found = await findPayment(read)
    if (found.order) {
      const { error } = await supabase.from("diagnostic_orders").update({
        status: "review",
        review_reason: "Chargeback or reversal. Do not deliver until this is resolved.",
      }).eq("id", found.order.id)
      if (error) throw new Error(`diagnostic_orders update failed: ${error.message}`)
      return { status: "needs_review", detail: "Chargeback on a Diagnostic; order moved to review.", userId: found.userId }
    }
    if (!found.userId) return { status: "needs_review", detail: "Chargeback on a payment this app cannot match to a customer." }
    const profile = await access.readProfile(found.userId)
    const decision = decideEnd("suspend", found.subscriptionId, profile?.paypal_subscription_id ?? null)
    const ids = { userId: found.userId, subscriptionId: found.subscriptionId }
    if (decision.kind === "ignore") return { status: "needs_review", detail: "Chargeback on a subscription that no longer grants access.", ...ids }
    await access.setProfile(found.userId, { plan: null, status: "disputed" })
    return { status: "needs_review", detail: "Chargeback: access put on hold. PayPal keeps billing until the subscription is cancelled.", ...ids }
  }

  async function handleRefund(read: ReadEvent): Promise<Result> {
    const found = await findPayment(read)
    if (found.order) {
      if (!refundCoversOrder(read.amount, Number(found.order.amount_usd))) {
        return { status: "needs_review", detail: `Part refund of ${read.amount ?? "?"} on a Diagnostic; order unchanged.`, userId: found.userId }
      }
      const { error } = await supabase.from("diagnostic_orders").update({
        status: "refunded",
        refunded_at: new Date().toISOString(),
      }).eq("id", found.order.id)
      if (error) throw new Error(`diagnostic_orders update failed: ${error.message}`)
      return { status: "processed", detail: "Diagnostic refunded.", userId: found.userId }
    }
    // A subscription refund is a person's decision: it may be goodwill, a part
    // refund, or the end of the customer. Access stays until the subscription is
    // cancelled, and it is flagged so that decision gets made.
    return {
      status: "needs_review",
      detail: found.userId
        ? "Subscription payment refunded. Access is unchanged; cancel the subscription if it should end."
        : "Refund on a payment this app cannot match to a customer.",
      userId: found.userId,
      subscriptionId: found.subscriptionId,
    }
  }

  // deno-lint-ignore no-explicit-any
  async function handleDisputeResolved(event: any, read: ReadEvent, accessToken: string): Promise<Result> {
    const found = await findPayment(read)
    const ids = { userId: found.userId, subscriptionId: found.subscriptionId }
    if (!disputeWonBySeller(event.resource)) {
      return { status: "needs_review", detail: "Dispute lost or settled. Access stays on hold; decide what happens next.", ...ids }
    }
    if (found.order) return { status: "needs_review", detail: "Dispute won on a Diagnostic; move the order out of review.", ...ids }
    if (!found.subscriptionId) return { status: "needs_review", detail: "Dispute won on a payment this app cannot match.", ...ids }
    const sub = await access.fetchSubscription(found.subscriptionId, accessToken)
    if (!sub) throw new Error(`Subscription ${found.subscriptionId} could not be found at PayPal; retry.`)
    const out = await access.applyGrant(sub, accessToken, { allowDisputed: true })
    if (out.kind === "granted") return { status: "processed", detail: "Dispute won; access restored.", ...ids }
    return { status: "needs_review", detail: `Dispute won, access not restored: ${out.reason}.`, ...ids }
  }

  // deno-lint-ignore no-explicit-any
  async function handleEvent(event: any, read: ReadEvent, accessToken: string): Promise<Result> {
    switch (read.action) {
      case "grant": return await handleGrant(read, accessToken)
      case "end": return await handleEnd(event, read, "revoke")
      case "suspend": return await handleEnd(event, read, "suspend")
      case "diagnostic_capture": return await reconcileDiagnosticCapture(read.orderId!, event.resource)
      case "refund": return await handleRefund(read)
      case "reversal": return await holdForChargeback(read)
      case "dispute": {
        if (isChargeback(event.resource)) return await holdForChargeback(read)
        const found = await findPayment(read)
        return { status: "needs_review", detail: "Buyer opened a dispute in PayPal. Access is unchanged; respond in PayPal.", userId: found.userId, subscriptionId: found.subscriptionId }
      }
      case "dispute_resolved": return await handleDisputeResolved(event, read, accessToken)
      case "payment_failed":
        // PayPal retries a failed renewal and suspends it after repeated
        // failures, which arrives as its own event. Access is untouched here.
        return { status: "processed", detail: "Payment failed; PayPal will retry.", userId: read.userId, subscriptionId: read.subscriptionId }
      default:
        return { status: "ignored", detail: "Recorded; no action needed." }
    }
  }

  // Applies a verified event once. Throws when it could not be applied, so the
  // webhook answers 500 and PayPal tries again.
  // deno-lint-ignore no-explicit-any
  async function processEvent(event: any, accessToken: string): Promise<{ duplicate: boolean; status?: string }> {
    const read = readEvent(event)
    if (!(await beginEvent(event, read))) return { duplicate: true }
    try {
      const result = await handleEvent(event, read, accessToken)
      if (result.status === "needs_review") console.error("Payment needs review.", { event: event.event_type, detail: result.detail })
      await finishEvent(event.id, {
        status: result.status,
        detail: result.detail ?? null,
        ...(result.userId ? { user_id: result.userId } : {}),
        ...(result.subscriptionId ? { subscription_id: result.subscriptionId } : {}),
      })
      return { duplicate: false, status: result.status }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      await finishEvent(event.id, { status: "failed", detail: message })
      throw error
    }
  }

  return { processEvent }
}
