import { NextResponse } from 'next/server';

// SYSTEM PROMPT directly from User Requirement
const SYSTEM_PROMPT = `
ROLE:
You are "RangeShield Co-Pilot," an expert EV Race Strategist and Navigation Assistant.
Your goal is to guide the user safely from Start to Destination with optimal energy usage.

CORE BEHAVIORS:
1. **Analyze Physics First:** Always prioritize the "Safety Score" from the simulation. If Arrival SOC < 10%, you MUST recommend the "Eco" strategy.
2. **Charger Integration:** You have a list of real-time charging stations (provided in context). Recommendation logic:
   - If User needs a stop: Suggest the charger with the highest power (kW) closest to the midway point.
   - If User is safe: Suggest a charger only "for a quick coffee stop" if asked.
3. **Strict Boundaries:**
   - YOU DO NOT answer questions about politics, coding, cooking, or general knowledge.
   - If asked "Who is the president?" or "Write me a poem", reply EXACTLY:
     "I am tuned exclusively for EV telemetry and trip planning. Let's focus on your range anxiety."
4. **Tone:** Professional, Concise, slight "Race Engineer" personality.
`;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { messages, context } = body;
        // context contains: { telemetry, trip, user, chargers }

        // Construct the full prompt context if this is the first message or if context is updated
        let fullPrompt = "";

        if (context) {
            fullPrompt += `DATA CONTEXT (Variables to use):
- Current Range: ${context.telemetry.range_km} km
- Distance to Go: ${context.trip.distance_km} km
- Efficiency: ${context.telemetry.efficiency} kWh/km
- Passenger Count: ${context.user.passengers}
- Arrival SOC: ${context.telemetry.arrival_soc}%

YOUR KNOWLEDGE BASE (Real-time Chargers):
${JSON.stringify(context.chargers)}
`;
        }

        const userMessage = messages[messages.length - 1].content;

        // --- GEMINI / VERTEX AI INTEGRATION ---
        // For this implementation, we will try to use the Gemini API key if available, 
        // or fall back to a "Mock Race Engineer" for development stability if no key is set.

        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

        if (apiKey) {
            // Call Gemini API (Generative Language API)
            const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        { role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + fullPrompt + "\n\nUser: " + userMessage }] }
                    ]
                })
            });

            if (aiRes.ok) {
                const data = await aiRes.json();
                if (data.candidates && data.candidates.length > 0) {
                    const reply = data.candidates[0].content.parts[0].text;
                    return NextResponse.json({ reply });
                }
            } else {
                console.error("AI API Error:", await aiRes.text());
                // Fallthrough to mock
            }
        }

        // --- FALLBACK MOCK (If no key or API error) ---
        // This ensures the UI works for the user immediately.
        console.log("Using Mock AI (Race Engineer)");

        let mockReply = "";

        // Simple heuristic for the mock
        if (context && context.telemetry.arrival_soc < 10) {
            mockReply = "Copy that. Telemetry indicates critical Arrival SOC. Recommendation: Switch to ECO mode immediately. Maintain speed under 90km/h. I've flagged a high-power charger 45km ahead for a mandatory splash-and-dash.";
        } else {
            mockReply = "Telemetry looks nominal. You're clear to push. Arrival SOC is green. If you need a caffeine hit, there's a 150kW station near the halfway mark, but it's optional.";
        }

        // If it's a follow up chat
        if (!context && userMessage.length > 0) {
            mockReply = "Affirmative. I'm monitoring the data. Keep your eyes on the road.";
        }

        return NextResponse.json({ reply: mockReply });

    } catch (error) {
        console.error("Co-Pilot Error:", error);
        return NextResponse.json({ error: "Comms Link Failure" }, { status: 500 });
    }
}
