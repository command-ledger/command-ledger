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
  advisory: "P-2X763934UU660913BNLUSB7Q", // US$1,500/month, created 2026-11-03
}

// Plans no longer sold. Kept so an existing subscriber's renewal still resolves
// to an entitlement, mapped by what they bought rather than what they paid.
// Remove an entry only once no live subscription remains on that plan.
//
const RETIRED_PLAN_IDS: Record<string, PlanKey> = {
  "P-1NE00583S5561651HNITP2ZI": "software", // Command Essentials — software only
  // Sold as Command Pro, then repriced in place to Command Advisory at
  // US$1,950 for the first month and US$3,000 after. Replaced on 2026-11-03.
  "P-7M170334YK027974RNITP7NY": "advisory",
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
