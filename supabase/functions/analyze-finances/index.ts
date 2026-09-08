declare module "https://deno.land/std@0.168.0/http/server.ts" {
  export function serve(handler: (req: Request) => Response | Promise<Response>): void
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

declare const Deno: {
  env: {
    get(name: string): string | undefined
  }
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Coarse per-user rate limit. Scoped to this function instance only — it
// resets on cold start and doesn't coordinate across concurrent instances,
// so it's a first layer against casual abuse, not a durable limiter. A
// Postgres- or KV-backed counter would be needed for a real guarantee.
const RATE_LIMIT = 15 // requests
const RATE_WINDOW_MS = 60 * 60 * 1000 // per hour
const callLog = new Map<string, number[]>()

function isRateLimited(userId: string): boolean {
  const now = Date.now()
  const calls = (callLog.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS)
  calls.push(now)
  callLog.set(userId, calls)
  return calls.length > RATE_LIMIT
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Supabase secrets." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      )
    }

    // 1. Verify the caller is a real, authenticated user.
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 }
      )
    }

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userErr } = await supabaseClient.auth.getUser()
    if (userErr || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401 }
      )
    }

    // 2. Verify the caller actually has an active paid plan — this is a
    // costly, AI-backed feature, and the frontend paywall alone doesn't stop
    // someone calling this function directly with a free account.
    const { data: profile, error: profileErr } = await supabaseClient
      .from("profiles")
      .select("plan, status")
      .eq("id", user.id)
      .single()

    if (profileErr || !profile?.plan) {
      return new Response(
        JSON.stringify({ error: "Access denied. Active subscription required." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 403 }
      )
    }

    // 3. Basic abuse guard now that we know who's calling.
    if (isRateLimited(user.id)) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429 }
      )
    }

    const body = await req.json()

    const {
      monthlyRevenue, totalRevenue, totalExpenses, netProfit,
      profitMargin, velocity, conversionRate, sovereigntyScore,
      trueFreeCash, burnRunway, cashFlowPositive, ltvCacRatio, cogsRatio, marketingRatio,
      hireReady, breakEven, proj90,
      // Real payer-based concentration (replaces the retired single-month
      // maxRev/totRev metric). Only carries largestPct/top3Pct/hhi/etc. when
      // extraction confidence was moderate or high — otherwise it's just
      // { reason }, and no percentage must ever be narrated.
      revenueConcentration,
      plan, mode, dataMonths, dataConfidence,
      growthScore, growthLabel, riskScore, riskLabel, trends,
      // Per-metric confidence — { shown, level, reason } for each of
      // runway, breakEven, proj90, hireReady, ltvCac, growth. `shown:false`
      // means the metric's required inputs are absent (its raw value above
      // arrives as null) — that is a different failure than a thin history
      // and must be narrated differently.
      confidence,
      // Expense breakdown if available
      payroll, rent, marketing, software, cogs,
    } = body

    const fmt = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`
    const pct = (n) => `${Number(n || 0).toFixed(1)}%`

    // Narrates one confidence-gated metric for the prompt: a metric whose
    // value arrived as null is unavailable (never rendered as $0 or 0%),
    // and a shown-but-thin metric carries its confidence level and reason
    // inline so the model hedges on exactly the numbers that need it —
    // high-confidence metrics render plainly, same as the dashboard.
    const describeMetric = (rawValue, conf, formatFn) => {
      if (rawValue === null || rawValue === undefined || !conf?.shown) {
        return `Not available — ${conf?.reason || "insufficient data"}`
      }
      const value = formatFn(rawValue)
      if (conf.level === "high") return value
      return `${value} [${conf.level.toUpperCase()} CONFIDENCE — ${conf.reason}]`
    }
    const conf = confidence || {}

    // Real payer-based concentration is a richer shape than the other
    // confidence-gated metrics (several numbers plus named payers, not one
    // value), so it gets its own narration rather than reusing describeMetric.
    const rc = revenueConcentration || {}
    const concentrationSection = (rc.largestPct !== undefined && rc.largestPct !== null)
      ? [
          `- Largest Client: ${rc.largestPct}% of revenue${rc.confidenceLevel === "high" ? "" : ` [${String(rc.confidenceLevel).toUpperCase()} CONFIDENCE]`}`,
          `- Top 3 Clients Combined: ${rc.top3Pct}% of revenue`,
          `- Herfindahl Index: ${rc.hhi} (0 = perfectly diversified, 1 = a single client)`,
          `- Distinct Paying Clients: ${rc.distinctPayers}`,
          `- Concentration Severity: ${rc.severity === "critical" ? "Critical — largest client above 60%" : rc.severity === "warn" ? "Warn" : "None — split is healthy"}`,
          Number(rc.aggregatorPct) > 0.5 ? `- Note: ${rc.aggregatorPct}% of revenue arrives through a payment processor (Shopify/Stripe/PayPal) and is excluded above — it can't be attributed to one real client.` : null,
          rc.topPayers?.length ? `- Top payers by revenue share: ${rc.topPayers.map((p) => `${p.name} (${p.pct}%)`).join(", ")}` : null,
        ].filter(Boolean).join("\n")
      : `Not available — ${rc.reason || "payer names could not be reliably extracted from enough income transactions"}`

    // Build expense breakdown section if we have category data
    const expenseBreakdown = [
      payroll  ? `- Payroll: ${fmt(payroll)}`   : null,
      rent     ? `- Rent: ${fmt(rent)}`           : null,
      marketing? `- Marketing: ${fmt(marketing)}` : null,
      software ? `- Software: ${fmt(software)}`   : null,
      cogs     ? `- COGS: ${fmt(cogs)}`           : null,
    ].filter(Boolean).join("\n")

    const systemPrompt = `You are the fractional CFO of this business. You have full authority to speak directly. You are not a consultant. You are not an advisor giving options. You are the person responsible for this company's financial health and you will not soften your language or hedge your conclusions.

Return ONLY a valid JSON object — no markdown, no code fences, no text outside the JSON — with exactly these keys:
{
  "whatHappened": string,
  "whyItHappened": string,
  "businessImpact": string,
  "riskLevel": "Critical" | "Elevated" | "Watch" | "Low",
  "recommendedAction": string,
  "expectedOutcome": string,
  "confidenceScore": number,
  "confidenceReason": string
}

Rules:
- Speak in first person as the CFO in every field. "Your margin is." "You will run out." "Cut this."
- Never use phrases like "consider", "you might want to", "it may be worth", "potentially", "perhaps"
- Each field must reference a real number from the founder's actual data, not a generic statement
- "riskLevel" MUST match the computed Risk Score band given below (Critical/Elevated/Watch/Low) — you are narrating that score, not independently inventing a risk assessment
- "recommendedAction" is a single, specific, non-negotiable instruction — one sentence, one action
- "confidenceScore" (0-100) must be calibrated to DATA CONFIDENCE below: low data confidence caps around 50, medium around 60-75, high can go above that. "confidenceReason" states why in one short clause (e.g. "based on 1 manually-entered month" or "based on 6 months of uploaded transaction history")
- If TRENDS DETECTED are provided below, ground "whatHappened" and "whyItHappened" in those specific trends rather than restating raw current-period numbers
- Each field is 1-3 sentences. No bullet points, no headers, inside any field.
- If the numbers are bad, say they are bad. If they're good, say exactly what to do with that advantage right now.
- Any metric marked "Not available" below has no real value behind it — never state a number for it, never guess one, and never treat its absence as zero. Say plainly that you don't have enough data to assess it yet; "I cannot assess this yet" is the correct and expected thing to say about that specific metric, not a failure to answer.
- Any metric marked LOW CONFIDENCE or MODERATE CONFIDENCE below must be hedged explicitly wherever you reference it — say "early signal," "based on limited history," or "this could move once more data comes in" rather than stating it as settled fact. A HIGH CONFIDENCE metric (or one with no confidence marking at all) is stated as fact, same as always.
- REPORTING PERIOD of 1 month cannot support "riskLevel": "Critical" — a single bad month may be a fluke, not a fire. Cap at "Watch" in that case and say the call needs more history to confirm.
- If REVENUE CONCENTRATION below is "Not available," never state or imply a concentration percentage — say plainly that payer names couldn't be reliably read from the transaction data yet.
- If REVENUE CONCENTRATION is marked MODERATE CONFIDENCE, hedge that specific figure the same way as any other moderate-confidence metric.`

    const userPrompt = `Here is the complete financial position of this business. Analyze it and tell the founder exactly what is happening and what to do:

REPORTING PERIOD: ${dataMonths} month(s) of data
DATA CONFIDENCE: ${dataConfidence === "low" ? "Low — a single manually-entered snapshot, no transaction history" : dataConfidence === "medium" ? "Medium — real uploaded data, but under 3 months of history" : "High — real uploaded data with 3+ months of history"}
ALLOCATION MODE: ${mode === "growth" ? "Aggressive (Growth)" : "Conservative (Safe)"}
PLAN TIER: ${plan}

CORE METRICS:
- Current Monthly Revenue: ${fmt(monthlyRevenue)}
- Total Revenue (period): ${fmt(totalRevenue)}
- Total Expenses (period): ${fmt(totalExpenses)}
- Net Profit (period): ${fmt(netProfit)}
- Profit Margin: ${pct(profitMargin)}
- Revenue Velocity (month-on-month growth): ${pct(velocity)}
- Conversion Rate: ${pct(conversionRate)}
- Sovereignty Score: ${sovereigntyScore}/100

CASH POSITION:
- True Free Cash (after tax vault + safety buffer): ${fmt(trueFreeCash)}
- Burn Runway: ${cashFlowPositive ? "Cash flow positive — revenue currently exceeds expenses, so there is no cash burn to report" : describeMetric(burnRunway, conf.runway, (v) => `${v} months`)}
- Break-Even Revenue Required: ${describeMetric(breakEven, conf.breakEven, fmt)}
- 90-Day Revenue Projection: ${describeMetric(proj90, conf.proj90, fmt)}

UNIT ECONOMICS:
- LTV:CAC Ratio: ${describeMetric(ltvCacRatio, conf.ltvCac, (v) => `${v}x`)}
- COGS as % of Revenue: ${pct(cogsRatio)}
- Marketing Spend as % of Revenue: ${pct(marketingRatio)}

OPERATIONAL FLAGS:
- Hire Readiness: ${describeMetric(hireReady, conf.hireReady, (v) => v ? "Yes — free cash supports new headcount" : "No — insufficient free cash")}

REVENUE CONCENTRATION (by real paying client, extracted from transaction descriptions):
${concentrationSection}

COMPUTED SCORES (already calculated — narrate these, do not recompute or contradict them):
- Growth Score: ${describeMetric(growthScore, conf.growth, (v) => `${v}/100 (${growthLabel ?? "n/a"})`)}
- Risk Score: ${riskScore ?? "n/a"}/100 (${riskLabel ?? "n/a"}) — this is the value "riskLevel" in your response must match, subject to the single-month cap in the rules above

${trends?.length ? `TRENDS DETECTED (comparing the latest month to the prior months' average):\n${trends.map((t) => `- ${t.message}`).join("\n")}` : "TRENDS DETECTED: none — under 3 months of history, or nothing moved meaningfully."}

${expenseBreakdown ? `EXPENSE BREAKDOWN:\n${expenseBreakdown}` : ""}

Return the JSON object now.`

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1200,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || "Anthropic API failed." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: response.status }
      )
    }

    const text = data?.content?.[0]?.text || ""

    // The model is asked to return only JSON, but strip any stray
    // conversational wrapping defensively before parsing.
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    let recommendation: Record<string, unknown> | null = null
    try {
      recommendation = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text)
    } catch {
      recommendation = null
    }

    const REQUIRED_FIELDS = [
      "whatHappened", "whyItHappened", "businessImpact", "riskLevel",
      "recommendedAction", "expectedOutcome", "confidenceScore", "confidenceReason",
    ]
    const isValid = recommendation !== null && REQUIRED_FIELDS.every(k => k in recommendation!)

    if (!isValid) {
      // Don't hand the client malformed data dressed up as a real
      // recommendation — a missing field silently rendered as "undefined"
      // in a financial advisory panel is worse than a clear error.
      return new Response(
        JSON.stringify({ error: "The advisor's response could not be parsed into a structured recommendation. Try again." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 502 }
      )
    }

    // Directive gating, enforced in code rather than left to prompt
    // compliance: a single month of data cannot support a "Critical" call.
    // The prompt already instructs this, but a model is not a guarantee —
    // this is the same "verify, don't just ask nicely" pattern already
    // used above for the required-fields check.
    if (Number(dataMonths) <= 1 && recommendation!.riskLevel === "Critical") {
      recommendation!.riskLevel = "Watch"
      recommendation!.confidenceReason =
        `${recommendation!.confidenceReason} (Capped from Critical — only 1 month of data; more history is needed to confirm a call that severe.)`
    }

    return new Response(JSON.stringify({ recommendation }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"

    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    })
  }
})