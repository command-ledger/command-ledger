// Which PayPal plan grants which entitlement — the single source of truth.
//
// Imported by paypal-webhook (to grant and revoke access) and plan-pricing (to
// confirm a plan's live price before checkout). Plan ids used to be hardcoded
// separately in the browser and in the webhook and kept in sync by hand; a
// plan edited in one and not the other either granted the wrong tier or
// granted nothing. The browser no longer holds plan ids at all.
//
// Prices are deliberately NOT recorded here. PayPal's copy of the price is the
// one that charges the customer, so plan-pricing reads it from PayPal at
// checkout time instead of trusting a number typed into this file.

export type PlanKey = "software" | "advisory"

// Plans currently sold.
export const CURRENT_PLAN_IDS: Record<PlanKey, string> = {
  software: "P-8CD25808KD889454JNKS7S7I",
  advisory: "P-7M170334YK027974RNITP7NY",
}

// Plans no longer sold. Kept so an existing subscriber's renewal still resolves
// to an entitlement, mapped by what they bought rather than what they paid.
// Remove an entry only once no live subscription remains on that plan.
//
// P-7M170334YK027974RNITP7NY is absent on purpose: it was sold as Command Pro
// under the retired pricing and was repriced in place to become Command
// Advisory, so it is a current plan and already maps to "advisory" above.
const RETIRED_PLAN_IDS: Record<string, PlanKey> = {
  "P-1NE00583S5561651HNITP2ZI": "software", // Command Essentials — software only
}

// Resolves a PayPal plan id to the entitlement it grants. Returns undefined for
// an unknown id; callers must treat that as "grant nothing", never as a
// default tier.
export function planKeyForId(planId: string | null | undefined): PlanKey | undefined {
  if (!planId) return undefined
  for (const [key, id] of Object.entries(CURRENT_PLAN_IDS)) {
    if (id === planId) return key as PlanKey
  }
  return RETIRED_PLAN_IDS[planId]
}
