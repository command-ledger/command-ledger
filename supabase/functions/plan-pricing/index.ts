// Live PayPal plan pricing, read before checkout opens.
//
// The checkout page shows a price, but the PayPal plan is what charges the
// customer. This function returns what PayPal will actually bill for a plan —
// amount, currency, billing interval, and whether a trial or setup fee is
// attached — so the browser can refuse to open checkout when that disagrees
// with the price on the page. See checkoutBlockReason() in src/lib/financials.js.
//
// Plan ids are resolved server-side from a plan key. The browser never supplies
// a plan id, so it cannot ask this function to vouch for an arbitrary plan.
//
// Required secrets: PAYPAL_CLIENT_ID, PAYPAL_SECRET_ID, and PAYPAL_API_BASE
// (defaults to sandbox; must be https://api-m.paypal.com for a live app).

declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { CURRENT_PLAN_IDS, type PlanKey } from "../_shared/paypal-plans.ts"

declare const Deno: {
  env: {
    get(name: string): string | undefined
  }
}

const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID")
const PAYPAL_CLIENT_SECRET = Deno.env.get("PAYPAL_SECRET_ID")
const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Each lookup costs a PayPal OAuth call and a plan read. Caching a plan's
// summary for five minutes bounds PayPal API traffic per instance regardless
// of how often checkout is opened, while a price change made in the PayPal
// dashboard still reaches checkout within minutes. Scoped to this instance
// only; it resets on cold start.
const CACHE_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; body: Record<string, unknown> }>()

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
  const data = await res.json()
  return data.access_token
}

// Reduces PayPal's plan resource to the terms that decide what a subscriber is
// charged. Only the REGULAR billing cycle carries the recurring price; a TRIAL
// cycle or a setup fee means the first charge differs from that price.
// deno-lint-ignore no-explicit-any
function summarise(plan: any) {
  const cycles = Array.isArray(plan?.billing_cycles) ? plan.billing_cycles : []
  // deno-lint-ignore no-explicit-any
  const regular = cycles.find((c: any) => c?.tenure_type === "REGULAR")
  const price = regular?.pricing_scheme?.fixed_price
  const setup = plan?.payment_preferences?.setup_fee
  const amount = price ? Number(price.value) : null
  const setupFee = setup ? Number(setup.value) : 0
  // A TRIAL cycle with no pricing_scheme is free; one with a fixed_price bills
  // that amount for each of its total_cycles before the REGULAR price starts.
  const trials = cycles
    // deno-lint-ignore no-explicit-any
    .filter((c: any) => c?.tenure_type === "TRIAL")
    // deno-lint-ignore no-explicit-any
    .sort((a: any, b: any) => (a?.sequence ?? 0) - (b?.sequence ?? 0))
    // deno-lint-ignore no-explicit-any
    .map((c: any) => {
      const tp = c?.pricing_scheme?.fixed_price
      const tAmount = tp ? Number(tp.value) : 0
      return {
        amount: Number.isFinite(tAmount) ? tAmount : null,
        currency: tp?.currency_code ?? null,
        intervalUnit: c?.frequency?.interval_unit ?? null,
        intervalCount: c?.frequency?.interval_count ?? null,
        totalCycles: c?.total_cycles ?? null,
      }
    })
  return {
    name: plan?.name ?? null,
    status: plan?.status ?? null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: price?.currency_code ?? null,
    intervalUnit: regular?.frequency?.interval_unit ?? null,
    intervalCount: regular?.frequency?.interval_count ?? null,
    hasTrial: trials.length > 0,
    trials,
    setupFee: Number.isFinite(setupFee) ? setupFee : null,
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  let planKey: string | undefined
  try {
    planKey = (await req.json())?.planKey
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  const planId = planKey ? CURRENT_PLAN_IDS[planKey as PlanKey] : undefined
  if (!planId) return json({ error: "unknown_plan" }, 404)

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    console.error("plan-pricing misconfigured: PAYPAL_CLIENT_ID / PAYPAL_SECRET_ID missing.")
    return json({ error: "not_configured" }, 500)
  }

  const hit = cache.get(planId)
  if (hit && Date.now() - hit.at < CACHE_MS) return json(hit.body)

  try {
    const token = await getAccessToken()
    const res = await fetch(`${PAYPAL_API_BASE}/v1/billing/plans/${planId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    })
    if (!res.ok) {
      console.error("PayPal plan lookup failed.", { planId, status: res.status })
      return json({ error: "paypal_lookup_failed", paypalStatus: res.status }, 502)
    }
    const body = { planKey, planId, ...summarise(await res.json()) }
    cache.set(planId, { at: Date.now(), body })
    return json(body)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("plan-pricing error:", message)
    return json({ error: "paypal_unreachable" }, 502)
  }
})
