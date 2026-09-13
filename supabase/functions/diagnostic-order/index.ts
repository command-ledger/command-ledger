// One-time Financial Diagnostic checkout.
//
// PayPal subscriptions are priced on a PayPal plan; a one-time payment is a
// PayPal order that carries its own amount, so whoever creates the order sets
// the price. This function creates it, from DIAGNOSTIC in
// ../_shared/one-time-products.ts. The browser receives only an order id to
// hand to PayPal's buttons, and cannot change what the buyer is charged.
//
//   POST { action: "create" }           -> { orderId, amountUsd, currency }
//   POST { action: "capture", orderId } -> { state }
//
// state is "completed", "pending", "not_captured" (no money moved; the buyer can
// retry, with `issue` set when PayPal gave a reason) or "review" (money moved,
// but not on the terms sold — nothing is delivered until a person has looked).
//
// Every call must come from a signed-in user. An order can only be captured by
// the user it was created for. If the buyer's browser closes after paying but
// before capture returns, paypal-webhook reconciles the order from the
// PAYMENT.CAPTURE.COMPLETED event.
//
// Required secrets: PAYPAL_CLIENT_ID, PAYPAL_SECRET_ID, PAYPAL_API_BASE,
// SUPABASE_ANON_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected.

declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { DIAGNOSTIC, paypalAmount, verifyDiagnosticCapture } from "../_shared/one-time-products.ts"

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

// Each create opens a PayPal order and writes a row. Bounds how many one
// account can open per hour. Scoped to this instance only; it resets on cold
// start, so it limits casual abuse rather than guaranteeing a ceiling.
const CREATE_LIMIT = 10
const CREATE_WINDOW_MS = 60 * 60 * 1000
const createLog = new Map<string, number[]>()

function isRateLimited(userId: string): boolean {
  const now = Date.now()
  const calls = (createLog.get(userId) || []).filter(t => now - t < CREATE_WINDOW_MS)
  calls.push(now)
  createLog.set(userId, calls)
  return calls.length > CREATE_LIMIT
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status}`)
  return (await res.json()).access_token
}

// deno-lint-ignore no-explicit-any
function firstCapture(order: any) {
  return order?.purchase_units?.[0]?.payments?.captures?.[0]
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !SUPABASE_ANON_KEY) {
    console.error("diagnostic-order misconfigured: PayPal credentials or SUPABASE_ANON_KEY missing.")
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

  // deno-lint-ignore no-explicit-any
  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  try {
    if (body?.action === "create") {
      if (isRateLimited(user.id)) return json({ error: "rate_limited" }, 429)

      const token = await getAccessToken()
      const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: DIAGNOSTIC.key,
            description: DIAGNOSTIC.description,
            custom_id: user.id,
            amount: { currency_code: DIAGNOSTIC.currency, value: paypalAmount(DIAGNOSTIC.amountUsd) },
          }],
        }),
      })
      if (!res.ok) {
        console.error("PayPal order create failed.", { status: res.status, body: await res.text() })
        return json({ error: "paypal_create_failed" }, 502)
      }
      const order = await res.json()

      // Record the order before handing its id to the browser. If this insert
      // fails the buyer never sees a payment button, so no money can arrive
      // for an order we have no record of.
      const { error: insertErr } = await admin.from("diagnostic_orders").insert({
        user_id: user.id,
        paypal_order_id: order.id,
        amount_usd: DIAGNOSTIC.amountUsd,
        currency: DIAGNOSTIC.currency,
        status: "created",
      })
      if (insertErr) {
        console.error("diagnostic_orders insert failed.", insertErr.message)
        return json({ error: "record_failed" }, 500)
      }

      return json({ orderId: order.id, amountUsd: DIAGNOSTIC.amountUsd, currency: DIAGNOSTIC.currency })
    }

    if (body?.action === "capture") {
      const orderId = typeof body.orderId === "string" ? body.orderId : ""
      if (!orderId) return json({ error: "missing_order" }, 400)

      // Only the user an order was created for may capture it.
      const { data: row, error: rowErr } = await admin
        .from("diagnostic_orders")
        .select("id, status")
        .eq("paypal_order_id", orderId)
        .eq("user_id", user.id)
        .maybeSingle()
      if (rowErr) throw new Error(`diagnostic_orders lookup failed: ${rowErr.message}`)
      if (!row) return json({ error: "unknown_order" }, 404)
      if (row.status === "completed" || row.status === "review") return json({ state: row.status })

      const token = await getAccessToken()
      const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      })
      let order = await res.json().catch(() => null)

      if (!res.ok) {
        const issue = order?.details?.[0]?.issue ?? null
        if (issue === "ORDER_ALREADY_CAPTURED") {
          // Captured already (a retry, or the webhook got there first): read
          // the order to judge the capture that exists.
          const again = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
            headers: { "Authorization": `Bearer ${token}` },
          })
          if (!again.ok) throw new Error(`order ${orderId} already captured but could not be read: ${again.status}`)
          order = await again.json()
        } else if (res.status >= 400 && res.status < 500 && issue) {
          // PayPal refused with a named reason (ORDER_NOT_APPROVED,
          // INSTRUMENT_DECLINED, ...): the capture did not happen, no money moved.
          return json({ state: "not_captured", issue })
        } else {
          // A 5xx, or a refusal with no reason, does not tell us whether money
          // moved. Never report that as "not charged": a buyer told their
          // payment failed pays again, on a new order, and is charged twice.
          throw new Error(`capture outcome unknown for ${orderId}: HTTP ${res.status}`)
        }
      }

      const verdict = verifyDiagnosticCapture(firstCapture(order), user.id)

      if (verdict.ok) {
        const { error: updErr } = await admin.from("diagnostic_orders").update({
          status: verdict.state,
          paypal_capture_id: verdict.captureId,
          completed_at: verdict.state === "completed" ? new Date().toISOString() : null,
        }).eq("id", row.id)
        if (updErr) throw new Error(`diagnostic_orders update failed: ${updErr.message}`)
        return json({ state: verdict.state })
      }

      if (verdict.state === "review") {
        console.error("Diagnostic capture needs review.", { orderId, reason: verdict.reason })
        await admin.from("diagnostic_orders").update({
          status: "review",
          review_reason: verdict.reason,
          paypal_capture_id: verdict.captureId,
        }).eq("id", row.id)
        return json({ state: "review" })
      }

      // PayPal answered 2xx but the capture is neither completed, pending nor
      // reviewable. That is not proof no money moved, so it is not reported as
      // not_captured.
      throw new Error(`capture for ${orderId} returned an unrecognised state: ${verdict.reason}`)
    }

    return json({ error: "unknown_action" }, 400)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("diagnostic-order error:", message)
    return json({ error: "server_error" }, 500)
  }
})
