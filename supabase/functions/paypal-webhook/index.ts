// PayPal webhook.
//
// Checks that an event really came from PayPal, then hands it to
// ../_shared/paypal-events.ts, which records it and applies it: renewals,
// cancellations, failed payments, refunds, chargebacks, and first payments when
// the buyer's browser never came back. confirm-subscription grants access at
// checkout as well, so a paying customer no longer depends on this function
// alone. The rules for both are in ../_shared/paypal-access.ts.
//
// Required Supabase Edge Function secrets (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// are injected automatically and do not need to be set):
//   PAYPAL_CLIENT_ID       PayPal REST app client ID. Must be the same app the
//                          browser's buttons use: PayPal delivers subscription
//                          events to the webhooks of the app that created them.
//   PAYPAL_SECRET_ID       PayPal REST app secret
//   PAYPAL_WEBHOOK_ID      The id of that app's webhook, 17 upper-case characters.
//                          Not a client id. A wrong value fails every signature
//                          check, which is why it is checked below.
//   PAYPAL_API_BASE        optional, defaults to the PayPal sandbox API.
//                          Set to https://api-m.paypal.com in production.

declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { looksLikeWebhookId } from "../_shared/payment-events.ts"
import { createAccess } from "../_shared/paypal-access.ts"
import { createEventProcessor } from "../_shared/paypal-events.ts"

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const access = createAccess(supabase, { apiBase: PAYPAL_API_BASE, clientId: PAYPAL_CLIENT_ID ?? "", clientSecret: PAYPAL_CLIENT_SECRET ?? "" })
const events = createEventProcessor(supabase, access)

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

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !looksLikeWebhookId(PAYPAL_WEBHOOK_ID)) {
    // 500, not 401: this is our fault, and PayPal keeps retrying while it is fixed.
    console.error("PayPal webhook misconfigured: PAYPAL_CLIENT_ID, PAYPAL_SECRET_ID or a valid PAYPAL_WEBHOOK_ID is missing.")
    return new Response("Webhook not configured", { status: 500 })
  }

  // deno-lint-ignore no-explicit-any
  let event: any
  try {
    event = await req.json()
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  try {
    const accessToken = await access.getAccessToken()
    const verified = await verifyWebhookSignature(req.headers, event, accessToken)
    if (!verified) {
      console.error("PayPal webhook signature verification failed.", { event_type: event?.event_type, id: event?.id })
      return new Response("Signature verification failed", { status: 401 })
    }
    if (typeof event?.id !== "string" || !event.id) return new Response("Event has no id", { status: 400 })

    const outcome = await events.processEvent(event, accessToken)
    return ok({ received: true, duplicate: outcome.duplicate })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("PayPal webhook processing error:", message)
    return new Response(JSON.stringify({ error: "processing_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})
