import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  "https://rjecagelwzorklmnscrr.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Changed to 'inputData' so it can accept ANY format or URL, not just CSVs
    const { inputData, userId } = req.body;

    if (!inputData || !userId) {
      return res.status(400).json({ error: 'Missing document payload' });
    }

    // 1. Verify User Subscription State
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('plan, status')
      .eq('id', userId)
      .single();

    if (profileErr || !profile || profile.plan === 'free') {
      return res.status(403).json({ error: 'Access denied. Active subscription required.' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI Gateway offline. Master key missing.' });

    // 2. UNIVERSAL LINK PARSER: If the user pasted a Google/Excel URL, fetch the data automatically
    let processedData = inputData;
    if (typeof inputData === 'string' && inputData.startsWith('http')) {
      try {
        const fetchRes = await fetch(inputData);
        processedData = await fetchRes.text();
      } catch (e) {
        console.warn("Could not fetch URL directly, passing URL string to Claude for extraction.");
      }
    }

    // 3. PROMPT ENGINEERING: Forcing Dynamic Math instead of hard-coded text
    const systemPrompt = `You are an elite enterprise CFO AI. The user will provide raw financial data (can be CSV, unstructured text, ledger rows, or external links).
    Read it, categorize all inputs (not just revenue/expenses), calculate the real metrics, and return ONLY a valid JSON object. Do not use markdown. Do not include introductory text.

    Calculate these specific strategic models based on the numbers:
    - "Safe Mode": Requires setting aside exactly 6 months of average expenses as a cash reserve.
    - "Growth Mode": Requires setting aside only 2 months of average expenses as a reserve, allocating the rest to reinvestment capital.

    Return EXACTLY this JSON structure (with real calculated numbers, no placeholders):
    {
      "metrics": {
        "totalRevenue": number,
        "totalExpenses": number,
        "netProfit": number,
        "burnRate": number
      },
      "models": {
        "safe": { "cashReserve": number, "reinvestmentCapital": number },
        "growth": { "cashReserve": number, "reinvestmentCapital": number }
      },
      "aiAdvisor": "Provide 3-4 sentences of highly specific, aggressive strategic advice based on these exact numbers. Point out margin leaks if any exist."
    }`;

    // 4. Send to Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Here is the financial input to process: \n${processedData}` }]
      })
    });

    const aiData = await response.json();
    if (!response.ok) throw new Error(aiData.error?.message || 'Anthropic routing failure');

    // 5. Clean and parse Claude's JSON output
    const claudeText = aiData.content[0].text;
    const jsonMatch = claudeText.match(/\{[\s\S]*\}/); // Strips away any conversational text Claude might add
    const finalJson = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(claudeText);

    // Send the structured, calculated object back to the frontend
    return res.status(200).json({ success: true, analysis: finalJson });

  } catch (error) {
    console.error("Backend pipeline error:", error);
    return res.status(500).json({ error: 'System breakdown: ' + error.message });
  }
}

