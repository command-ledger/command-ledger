// Grants access at checkout, without waiting for a webhook.
//
// A real payment once produced no access because PayPal's events were not
// reaching paypal-webhook. Now the browser hands this function the subscription
// id PayPal gave it, and the server reads that subscription from PayPal itself.
// The browser's word counts for nothing: access needs PayPal to report the
// subscription ACTIVE and paid, on a plan we sell, bought for the signed-in user.
//
//   POST { action: "register", subscriptionId } records the id as soon as it
//        exists, before the buyer approves, so a closed browser loses nothing
//   POST { action: "confirm",  subscriptionId } the buyer approved: check PayPal
//   POST { action: "recheck" }                  check this user's open checkouts
//
// Answers { state }, one of:
//   active   access is granted
//   pending  approved; PayPal has not confirmed payment yet, keep waiting
//   created  the buyer has not approved it
//   failed   PayPal says this will not become paid access
//   none     nothing is open
//
// Required secrets: PAYPAL_CLIENT_ID, PAYPAL_SECRET_ID, PAYPAL_API_BASE,
// SUPABASE_ANON_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected.

declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { isSubscriptionId } from "../_shared/payment-events.ts"
import { planKeyForId } from "../_shared/paypal-plans.ts"
import { createAccess } from "../_shared/paypal-access.ts"

declare const Deno: {
  env: {
    get(name: string): string | undefined
  }
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID")
const PAYPAL_CLIENT_SECRET = Deno.env.get("PAYPAL_SECRET_ID")
const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// The browser polls this while a payment activates. Bounds how often one
// account can make PayPal calls through it. Scoped to this instance only, so it
// limits casual abuse rather than guaranteeing a ceiling.
const CALL_LIMIT = 60
const CALL_WINDOW_MS = 10 * 60 * 1000
const callLog = new Map<string, number[]>()

function isRateLimited(userId: string): boolean {
  const now = Date.now()
  const calls = (callLog.get(userId) || []).filter(t => now - t < CALL_WINDOW_MS)
  calls.push(now)
  callLog.set(userId, calls)
  return calls.length > CALL_LIMIT
}

const OPEN_FOR_DAYS = 14
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const access = createAccess(admin, { apiBase: PAYPAL_API_BASE, clientId: PAYPAL_CLIENT_ID ?? "", clientSecret: PAYPAL_CLIENT_SECRET ?? "" })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// Creates the checkout row, or moves it forward. Never moves one backward, so a
// late "register" cannot undo an activation.
async function recordCheckout(subscriptionId: string, userId: string, planKey: string, approved: boolean) {
  const { error } = await admin.from("subscription_checkouts").upsert({
    provider: "paypal",
    subscription_id: subscriptionId,
    user_id: userId,
    plan_key: planKey,
    status: approved ? "approved" : "created",
    approved_at: approved ? new Date().toISOString() : null,
  }, { onConflict: "provider,subscription_id", ignoreDuplicates: true })
  if (error) throw new Error(`subscription_checkouts insert failed: ${error.message}`)
  if (approved) {
    const { error: updErr } = await admin.from("subscription_checkouts")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("provider", "paypal")
      .eq("subscription_id", subscriptionId)
      .eq("status", "created")
    if (updErr) throw new Error(`subscription_checkouts update failed: ${updErr.message}`)
  }
}

// Reads the outcome of one subscription from PayPal and applies it.
// deno-lint-ignore no-explicit-any
async function settle(sub: any, accessToken: string, createdAt?: string | null) {
  const out = await access.applyGrant(sub, accessToken)
  if (out.kind === "granted") return { state: "active", planKey: out.planKey }
  if (out.kind === "waiting") {
    await access.markCheckout(sub.id, { detail: out.reason })
    if (sub.status !== "APPROVAL_PENDING") return { state: "pending" }
    const age = createdAt ? Date.now() - Date.parse(createdAt) : 0
    if (age > ABANDON_AFTER_MS) await access.markCheckout(sub.id, { status: "abandoned" })
    return { state: "created" }
  }
  await access.markCheckout(sub.id, { status: "failed", detail: out.reason })
  return { state: "failed", reason: out.reason }
}

const STATE_ORDER = ["none", "created", "failed", "pending", "active"]

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !SUPABASE_ANON_KEY) {
    console.error("confirm-subscription misconfigured: PayPal credentials or SUPABASE_ANON_KEY missing.")
    return json({ error: "not_configured" }, 500)
  }

  // A real signed-in user, not merely a valid project key.
  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "unauthenticated" }, 401)
  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userErr } = await asCaller.auth.getUser()
  if (userErr || !user) return json({ error: "unauthenticated" }, 401)

  if (isRateLimited(user.id)) return json({ error: "rate_limited" }, 429)

  // deno-lint-ignore no-explicit-any
  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  try {
    const accessToken = await access.getAccessToken()

    if (body?.action === "register" || body?.action === "confirm") {
      const subscriptionId = body.subscriptionId
      if (!isSubscriptionId(subscriptionId)) return json({ error: "invalid_subscription" }, 400)

      const sub = await access.fetchSubscription(subscriptionId, accessToken)
      if (!sub) return json({ error: "unknown_subscription" }, 404)
      // Someone else's subscription id gets nothing, not even a record.
      if (sub.custom_id !== user.id) {
        console.error("Subscription presented by a user it does not belong to.", { subscription: subscriptionId, caller: user.id })
        return json({ error: "not_yours" }, 403)
      }
      const planKey = planKeyForId(sub.plan_id)
      if (!planKey) {
        console.error("Subscription on a plan we do not sell.", { subscription: subscriptionId, plan: sub.plan_id })
        return json({ state: "failed", reason: "unmapped plan" })
      }

      const approved = body.action === "confirm"
      await recordCheckout(subscriptionId, user.id, planKey, approved)
      if (!approved) return json({ state: "created" })
      return json(await settle(sub, accessToken))
    }

    if (body?.action === "recheck") {
      const since = new Date(Date.now() - OPEN_FOR_DAYS * 86400000).toISOString()
      const { data: open, error } = await admin.from("subscription_checkouts")
        .select("subscription_id, status, created_at")
        .eq("user_id", user.id)
        .in("status", ["created", "approved"])
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5)
      if (error) throw new Error(`subscription_checkouts read failed: ${error.message}`)

      let best: { state: string; planKey?: string; reason?: string } = { state: "none" }
      for (const row of open ?? []) {
        const sub = await access.fetchSubscription(row.subscription_id, accessToken)
        if (!sub) {
          await access.markCheckout(row.subscription_id, { status: "failed", detail: "PayPal has no such subscription." })
          continue
        }
        const result = await settle(sub, accessToken, row.created_at)
        if (STATE_ORDER.indexOf(result.state) > STATE_ORDER.indexOf(best.state)) best = result
      }
      return json(best)
    }

    return json({ error: "unknown_action" }, 400)
  } catch (error: unknown) {
    // Never reported as a failed payment: this only means we could not check.
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("confirm-subscription error:", message)
    return json({ error: "server_error" }, 500)
  }
})
