// Turns a PayPal subscription into access. The one place that does.
//
// paypal-webhook, confirm-subscription and payment-admin all run this, so a
// verified event, a buyer returning from checkout and a repair all follow the
// same rules. Access is granted only from PayPal's own record of the
// subscription, read from the server. Nothing the browser says is trusted.

import { planKeyForId } from "./paypal-plans.ts"
import { decideGrant, grantBlock, type EntitlementDecision } from "./subscription-entitlement.ts"
import { isUuid } from "./payment-events.ts"

export type GrantOutcome =
  | { kind: "granted"; planKey: string; subscriptionId: string }
  | { kind: "waiting"; reason: string } // not paid yet, but it may still be
  | { kind: "refused"; reason: string } // will not become paid access
  | { kind: "ignored"; reason: string } // correct to do nothing

type PayPalConfig = { apiBase: string; clientId: string; clientSecret: string }

// deno-lint-ignore no-explicit-any
export function createAccess(supabase: any, cfg: PayPalConfig) {
  async function getAccessToken(): Promise<string> {
    const res = await fetch(`${cfg.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    })
    if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`)
    return (await res.json()).access_token
  }

  // null means PayPal has no such subscription. Anything else that goes wrong
  // throws, because "could not check" must never be read as "does not exist".
  async function fetchSubscription(subscriptionId: string, accessToken: string) {
    const res = await fetch(`${cfg.apiBase}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`PayPal subscription read failed: ${res.status}`)
    return await res.json()
  }

  // Cancels a superseded subscription so the customer stops paying for a plan
  // they replaced. Already-paid periods are not refunded here; that stays a
  // human decision. A failure is logged rather than thrown: the access change
  // has already been applied, and a redelivered event would find the new
  // subscription on file and never retry the cancel, so the log line is the
  // record a person acts on.
  async function cancelSuperseded(userId: string, subscriptionId: string, replacedBy: string, accessToken: string) {
    const res = await fetch(`${cfg.apiBase}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Replaced by a newer Command Ledger subscription on the same account." }),
    })
    // 204 is success; 422 SUBSCRIPTION_STATUS_INVALID means it is already cancelled.
    if (res.ok || res.status === 422) {
      console.log("Superseded subscription cancelled.", { userId, cancelled: subscriptionId, keep: replacedBy, status: res.status })
      return
    }
    console.error("Could not cancel superseded subscription; cancel it in PayPal by hand.", {
      userId, cancel: subscriptionId, keep: replacedBy, status: res.status, body: await res.text(),
    })
  }

  // requireRow is set for writes that grant access. An update that matches no
  // row returns no error, so without this check a paying subscriber whose
  // profile row does not exist yet would be acknowledged and PayPal would stop
  // retrying: charged, and never granted access. Throwing makes the caller
  // answer 500, and PayPal redelivers until the row exists (the app creates it
  // at sign-in). Revocations do not set it: with no row there is nothing to
  // revoke, and retrying would only add noise.
  async function setProfile(
    userId: string,
    fields: { plan?: string | null; status: string; paypal_subscription_id?: string },
    { requireRow = false }: { requireRow?: boolean } = {},
  ) {
    const { data, error } = await supabase
      .from("profiles")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", userId)
      .select("id")
    if (error) throw new Error(`Supabase profile update failed: ${error.message}`)
    if (!data || data.length === 0) {
      const msg = `No profile row for user ${userId}; ${fields.status} not applied.`
      if (requireRow) throw new Error(msg)
      console.warn(msg)
    }
  }

  async function readProfile(userId: string): Promise<{ paypal_subscription_id: string | null; status: string | null } | null> {
    const { data, error } = await supabase
      .from("profiles")
      .select("paypal_subscription_id, status")
      .eq("id", userId)
      .maybeSingle()
    if (error) throw new Error(`Supabase profile read failed: ${error.message}`)
    return data ?? null
  }

  // Bookkeeping only. Access does not depend on it, so a failure is logged and
  // does not undo a grant that already succeeded.
  async function markCheckout(subscriptionId: string, fields: Record<string, unknown>) {
    const { error } = await supabase
      .from("subscription_checkouts")
      .update({ ...fields, last_checked_at: new Date().toISOString() })
      .eq("provider", "paypal")
      .eq("subscription_id", subscriptionId)
    if (error) console.error("subscription_checkouts update failed.", { subscriptionId, message: error.message })
  }

  // Applies PayPal's current record of a subscription to its owner's profile.
  // `sub` must have just been read from PayPal, never taken from an event body
  // or the browser. Owner and plan come from that record.
  // deno-lint-ignore no-explicit-any
  async function applyGrant(sub: any, accessToken: string, { paymentConfirmed = false, allowDisputed = false }: { paymentConfirmed?: boolean; allowDisputed?: boolean } = {}): Promise<GrantOutcome> {
    const userId = sub?.custom_id
    if (!isUuid(userId)) return { kind: "refused", reason: "subscription does not name a user" }
    const planKey = planKeyForId(sub?.plan_id)
    if (!planKey) return { kind: "refused", reason: `unmapped plan ${sub?.plan_id ?? "?"}` }

    const block = grantBlock(sub, { paymentConfirmed })
    if (block) return block.kind === "wait" ? { kind: "waiting", reason: block.reason } : { kind: "refused", reason: block.reason }

    const profile = await readProfile(userId)
    if (profile?.status === "disputed" && !allowDisputed) {
      return { kind: "ignored", reason: "access is on hold for a chargeback" }
    }

    const onFile = profile?.paypal_subscription_id ?? null
    const event = { id: sub.id, planKey, createTime: sub.create_time, status: sub.status, customId: userId }
    let stored = null
    if (onFile && onFile !== sub.id) {
      const s = await fetchSubscription(onFile, accessToken)
      stored = s ? { id: onFile, status: s.status, createTime: s.create_time, customId: s.custom_id } : null
    }
    const decision: EntitlementDecision = decideGrant(event, onFile, stored)
    const keep = decision.kind === "grant" ? sub.id : onFile
    if ("duplicateOf" in decision && decision.duplicateOf) {
      console.error("Customer has two live subscriptions; cancel the older one in PayPal.", { userId, keep, cancel: decision.duplicateOf })
    }
    if (decision.kind === "grant") {
      // The profile moves to the new subscription before the old one is
      // cancelled, so the CANCELLED event that follows is not the one on file
      // and cannot revoke access.
      await setProfile(userId, { plan: decision.planKey, status: "active", paypal_subscription_id: decision.subscriptionId }, { requireRow: true })
      await markCheckout(sub.id, { status: "active", activated_at: new Date().toISOString(), detail: null })
    }
    if ("cancel" in decision && decision.cancel && keep) {
      await cancelSuperseded(userId, decision.cancel, keep, accessToken)
    }
    if (decision.kind === "grant") return { kind: "granted", planKey: decision.planKey, subscriptionId: decision.subscriptionId }
    const reason = decision.kind === "ignore" ? decision.reason : "not a grant"
    console.warn("Grant not applied.", { userId, subscription: sub.id, reason })
    return { kind: "ignored", reason }
  }

  return { getAccessToken, fetchSubscription, setProfile, readProfile, markCheckout, applyGrant }
}
