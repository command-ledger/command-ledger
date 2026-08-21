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
      hireReady, concentration, concentrationReliable, breakEven, proj90,
      plan, mode, dataMonths, dataConfidence,
      // Expense breakdown if available
      payroll, rent, marketing, software, cogs,
    } = body

    const fmt = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`
    const pct = (n) => `${Number(n || 0).toFixed(1)}%`

    // Build expense breakdown section if we have category data
    const expenseBreakdown = [
      payroll  ? `- Payroll: ${fmt(payroll)}`   : null,
      rent     ? `- Rent: ${fmt(rent)}`           : null,
      marketing? `- Marketing: ${fmt(marketing)}` : null,
      software ? `- Software: ${fmt(software)}`   : null,
      cogs     ? `- COGS: ${fmt(cogs)}`           : null,
    ].filter(Boolean).join("\n")

    const systemPrompt = `You are the fractional CFO of this business. You have full authority to speak directly. You are not a consultant. You are not an advisor giving options. You are the person responsible for this company's financial health and you will not soften your language or hedge your conclusions.

Your rules:
- Speak in first person as the CFO. "Your margin is." "You will run out." "Cut this."
- Never use phrases like "consider", "you might want to", "it may be worth", "potentially", "perhaps"
- Every paragraph must contain a number from the founder's actual data
- Your final directive must be a single, specific, non-negotiable instruction
- Maximum 4 paragraphs. No bullet points. No headers. Plain prose.
- If the numbers are bad, say they are bad. If the numbers are good, say exactly what to do with that advantage right now.
- Write like the founder's financial future depends on reading this. Because it does.
- DATA CONFIDENCE governs how much weight to put on the numbers, not how directive you are. If it is "low", open by stating plainly that this is a preliminary read from a single manually-entered snapshot — then give your directive anyway. If it is "medium", note briefly that the read will sharpen with more months of data. If it is "high", say nothing about confidence and proceed with full authority. Never let low confidence become hedging on the conclusion itself — be upfront about the data, then be exactly as direct as always about what it means.`

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
- Burn Runway: ${cashFlowPositive ? "Cash flow positive — revenue currently exceeds expenses, so there is no cash burn to report" : `${burnRunway} months`}
- Break-Even Revenue Required: ${fmt(breakEven)}
- 90-Day Revenue Projection: ${fmt(proj90)}

UNIT ECONOMICS:
- LTV:CAC Ratio: ${ltvCacRatio}x
- COGS as % of Revenue: ${pct(cogsRatio)}
- Marketing Spend as % of Revenue: ${pct(marketingRatio)}

OPERATIONAL FLAGS:
- Hire Readiness: ${hireReady ? "Yes — free cash supports new headcount" : "No — insufficient free cash"}
- Revenue Distribution: ${concentrationReliable ? `${pct(concentration)} of total revenue came from the single highest month — treat this as a real concentration signal only if it stays high as more months come in` : `${pct(concentration)} of total revenue came from the single highest month, but there's under 3 months of history — this is too little data to call it a concentration risk yet, don't treat it as one`}

${expenseBreakdown ? `EXPENSE BREAKDOWN:\n${expenseBreakdown}` : ""}

Write the CFO analysis now. Reference specific numbers. End with one non-negotiable directive.`

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 800,
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

    const text = data?.content?.[0]?.text || "Analysis unavailable."

    return new Response(JSON.stringify({ analysis: text }), {
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