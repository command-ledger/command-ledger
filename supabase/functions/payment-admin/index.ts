// Investigate and repair payments, for the people listed in app_admins.
//
//   POST { action: "list" }
//        payments that need a person: events flagged or failed, and checkouts
//        that were approved but never became access
//   POST { action: "reconcile", subscriptionId }
//        read one subscription from PayPal and apply it under the normal rules
//   POST { action: "resolve", eventId }
//        mark a flagged event as dealt with
//
// reconcile grants nothing the webhook would not: the owner and plan come from
// PayPal's record, and paypal-access.ts decides. It takes no user id, so nobody
// can use it to hand access to an account a payment does not belong to.
//
// Every call checks app_admins on the server. The panel being hidden is only a
// convenience.
//
// Required secrets: PAYPAL_CLIENT_ID, PAYPAL_SECRET_ID, PAYPAL_API_BASE,
// SUPABASE_ANON_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected.

declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { isSubscriptionId, isUuid } from "../_shared/payment-events.ts"
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

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const access = createAccess(admin, { apiBase: PAYPAL_API_BASE, clientId: PAYPAL_CLIENT_ID ?? "", clientSecret: PAYPAL_CLIENT_SECRET ?? "" })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return json({ error: "unauthenticated" }, 401)
  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userErr } = await asCaller.auth.getUser()
  if (userErr || !user) return json({ error: "unauthenticated" }, 401)

  const { data: isAdmin, error: adminErr } = await admin.from("app_admins").select("user_id").eq("user_id", user.id).maybeSingle()
  if (adminErr) {
    console.error("app_admins read failed.", adminErr.message)
    return json({ error: "server_error" }, 500)
  }
  if (!isAdmin) return json({ error: "forbidden" }, 403)

  // deno-lint-ignore no-explicit-any
  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  try {
    if (body?.action === "list") {
      const { data: events, error } = await admin.from("payment_events")
        .select("id, event_type, status, detail, amount, currency, subscription_id, user_id, attempts, received_at")
        .in("status", ["failed", "needs_review"])
        .is("reviewed_at", null)
        .order("received_at", { ascending: false })
        .limit(50)
      if (error) throw new Error(`payment_events read failed: ${error.message}`)

      const { data: checkouts, error: coErr } = await admin.from("subscription_checkouts")
        .select("subscription_id, plan_key, status, detail, user_id, created_at, approved_at, last_checked_at")
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(50)
      if (coErr) throw new Error(`subscription_checkouts read failed: ${coErr.message}`)

      // The email is what lets a person recognise who to contact.
      const ids = [...new Set([...(events ?? []), ...(checkouts ?? [])].map(r => r.user_id).filter(Boolean))]
      const emails: Record<string, string> = {}
      if (ids.length) {
        const { data: people, error: peopleErr } = await admin.from("profiles").select("id, email").in("id", ids)
        if (peopleErr) throw new Error(`profiles read failed: ${peopleErr.message}`)
        for (const p of people ?? []) emails[p.id] = p.email
      }
      // deno-lint-ignore no-explicit-any
      const withEmail = (r: any) => ({ ...r, email: r.user_id ? emails[r.user_id] ?? null : null })
      return json({ events: (events ?? []).map(withEmail), checkouts: (checkouts ?? []).map(withEmail) })
    }

    if (body?.action === "reconcile") {
      if (!isSubscriptionId(body.subscriptionId)) return json({ error: "invalid_subscription" }, 400)
      const token = await access.getAccessToken()
      const sub = await access.fetchSubscription(body.subscriptionId, token)
      if (!sub) return json({ result: "not_found" })
      const out = await access.applyGrant(sub, token)
      console.log("Payment reconciled by hand.", { by: user.id, subscription: body.subscriptionId, outcome: out.kind })
      return json({ result: out.kind, reason: "reason" in out ? out.reason : null, plan: planKeyForId(sub.plan_id) ?? null, paypalStatus: sub.status })
    }

    if (body?.action === "resolve") {
      if (!isUuid(body.eventId)) return json({ error: "invalid_event" }, 400)
      const { error } = await admin.from("payment_events").update({ reviewed_at: new Date().toISOString() }).eq("id", body.eventId)
      if (error) throw new Error(`payment_events update failed: ${error.message}`)
      return json({ result: "resolved" })
    }

    return json({ error: "unknown_action" }, 400)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error("payment-admin error:", message)
    return json({ error: "server_error" }, 500)
  }
})
