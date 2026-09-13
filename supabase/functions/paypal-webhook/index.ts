// PayPal subscription webhook.
//
// This is the only place that grants or revokes paid access after checkout —
// src/App.jsx's PayModal only updates local UI state on approval, it never
// writes to the database. If this function silently no-ops, a customer can
// be charged by PayPal and never receive access.
//
// Required Supabase Edge Function secrets (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// are injected automatically and do not need to be set):
//   PAYPAL_CLIENT_ID       — PayPal REST app client ID (server-side, can match the
//                             public VITE_PAYPAL_CLIENT_ID or be a dedicated app)
//   PAYPAL_SECRET_ID       — PayPal REST app secret
//   PAYPAL_WEBHOOK_ID      — ID of the webhook configured in the PayPal dashboard
//                             to point at this function's URL
//   PAYPAL_API_BASE        — optional, defaults to the PayPal sandbox API.
//                             Set to https://api-m.paypal.com in production.

declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { planKeyForId } from "../_shared/paypal-plans.ts"

declare const Deno: {
  env: {
    get(name: string): string | undefined
  }
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID")
const PAYPAL_CLIENT_SECRET = Deno.env.get("PAYPAL_SECRET_ID")
const PAYPAL_WEBHOOK_ID = Deno.env.get("PAYPAL_WEBHOOK_ID")
// Sandbox by default so a misconfigured deploy can't silently start trusting
// requests verified against the wrong PayPal environment.
const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com"

// Plan id -> entitlement lives in ../_shared/paypal-plans.ts, shared with
// plan-pricing. An unmapped plan_id grants nothing, which is the correct
// failure: a subscription whose tier cannot be identified must not silently
// confer access.

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

// Verifies the event actually came from PayPal via PayPal's own verification
// API, rather than reimplementing the certificate-chain crypto by hand.
async function verifyWebhookSignature(headers: Headers, event: unknown, accessToken: string): Promise<boolean> {
  const transmission_id = headers.get("paypal-transmission-id")
  const transmission_time = headers.get("paypal-transmission-time")
  const cert_url = headers.get("paypal-cert-url")
  const auth_algo = headers.get("paypal-auth-algo")
  const transmission_sig = headers.get("paypal-transmission-sig")

  if (!transmission_id || !transmission_time || !cert_url || !auth_algo || !transmission_sig) {
    return false
  }

  const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transmission_id, transmission_time, cert_url, auth_algo, transmission_sig,
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    }),
  })

  if (!res.ok) return false
  const result = await res.json()
  return result.verification_status === "SUCCESS"
}

async function fetchSubscription(subscriptionId: string, accessToken: string) {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  return await res.json()
}

// requireRow is set for events that grant access. An update that matches no
// row returns no error, so without this check a paying subscriber whose profile
// row does not exist yet would be acknowledged with 200 and PayPal would stop
// retrying — charged, and never granted access. Throwing instead returns 500,
// and PayPal redelivers the event until the row exists (the app creates it on
// the subscriber's next sign-in). Revocations do not set it: with no row there
// is nothing to revoke, and retrying would only add noise.
async function setProfile(
  userId: string,
  fields: { plan?: string | null; status: string },
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

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_WEBHOOK_ID) {
    console.error("PayPal webhook misconfigured: PAYPAL_CLIENT_ID / PAYPAL_SECRET_ID / PAYPAL_WEBHOOK_ID secret missing.")
    return new Response("Webhook not configured", { status: 500 })
  }

  let event: any
  try {
    event = await req.json()
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  try {
    const accessToken = await getAccessToken()
    const verified = await verifyWebhookSignature(req.headers, event, accessToken)
    if (!verified) {
      console.error("PayPal webhook signature verification failed.", { event_type: event?.event_type, id: event?.id })
      return new Response("Signature verification failed", { status: 401 })
    }

    const resource = event.resource || {}

    switch (event.event_type) {
      // Fires once PayPal has captured the first payment and the
      // subscription is actually live — the correct signal to grant access.
      case "BILLING.SUBSCRIPTION.ACTIVATED": {
        const userId = resource.custom_id
        const planKey = planKeyForId(resource.plan_id)
        if (!userId || !planKey) {
          console.error("Activation event missing userId/planKey mapping.", { plan_id: resource.plan_id, custom_id: resource.custom_id })
          break
        }
        await setProfile(userId, { plan: planKey, status: "active" }, { requireRow: true })
        break
      }

      // Recurring renewal payments. The payment resource itself doesn't
      // reliably carry custom_id, so resolve it via the subscription record —
      // this also re-activates a profile whose subscription had lapsed.
      case "PAYMENT.SALE.COMPLETED":
      case "PAYMENT.CAPTURE.COMPLETED": {
        const subscriptionId = resource.billing_agreement_id || resource.supplementary_data?.related_ids?.subscription_id
        if (!subscriptionId) break
        const sub = await fetchSubscription(subscriptionId, accessToken)
        const userId = sub?.custom_id
        const planKey = planKeyForId(sub?.plan_id)
        if (userId && planKey) await setProfile(userId, { plan: planKey, status: "active" }, { requireRow: true })
        break
      }

      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED": {
        const userId = resource.custom_id
        if (userId) {
          await setProfile(userId, {
            plan: null,
            status: event.event_type === "BILLING.SUBSCRIPTION.EXPIRED" ? "expired" : "canceled",
          })
        }
        break
      }

      // Suspension (e.g. a failed renewal charge) is a grace-period state —
      // record it but don't strip the plan; ACTIVATED/PAYMENT.*.COMPLETED
      // will restore "active" status if the subscription recovers.
      case "BILLING.SUBSCRIPTION.SUSPENDED": {
        const userId = resource.custom_id
        if (userId) await setProfile(userId, { status: "suspended" })
        break
      }

      default:
        // Unhandled event types are still acknowledged with 200 so PayPal
        // doesn't keep retrying deliveries we intentionally ignore.
        break
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("PayPal webhook processing error:", message)
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})
