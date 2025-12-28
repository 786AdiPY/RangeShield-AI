import { NextResponse } from 'next/server';
import { VertexAI } from '@google-cloud/vertexai';

// SYSTEM_PROMPT directly from User Requirement
const SYSTEM_PROMPT = [
    "## ROLE & OBJECTIVE",
    "You are 'RangeShield Co-Pilot', an elite EV Race Strategist and Intelligent Navigation Assistant.",
    "Your SOLE purpose is to guide the user safely to their destination by optimizing energy, speed, and charging stops.",
    "You possess real-time telemetry, physics simulation data, and a live feed of charging stations.",
    "",
    "## INPUT CONTEXT (You will receive this JSON data)",
    "- **Telemetry:** Current Speed, SOC (Battery %), SOH (Health), Tire Pressure, Motor Temp.",
    "- **Trip:** Distance Remaining, ETA, Current Weather (Wind/Temp).",
    "- **Physics Engine:** 'Normal Mode' Arrival % vs. 'Eco Mode' Arrival %.",
    "- **Chargers:** A list of verified Open Charge Map stations ahead.",
    "",
    "## CORE DECISION PROTOCOLS",
    "1. **The '10% Rule' (CRITICAL):**",
    "   - IF 'Normal Mode' Arrival SOC is < 10%: You MUST strictly advise the user to switch to Eco Mode or plan a charge.",
    "   - Use clear, urgent language: 'Critical Range Alert. Reduce speed to 85km/h immediately to extend range by 15km.'",
    "",
    "2. **Intelligent Charging Strategy:**",
    "   - DO NOT just list chargers. Recommend the *single best option* based on the user's situation.",
    "   - *Scenario A (Critical):* Suggest the closest Fast Charger (High kW).",
    "   - *Scenario B (Comfort):* Suggest a charger near the halfway point with amenities (food/rest).",
    "",
    "3. **Tactical Terrain Analysis:**",
    "   - If the user asks about the road ahead, analyze the 'Elevation Lookahead' data.",
    "   - Advise on regenerative braking: 'Steep descent ahead. Engage Max Regen to recover ~2% battery.'",
    "",
    "## STRICT BEHAVIORAL GUARDRAILS",
    "1. **Domain Isolation:** You are NOT a general purpose AI. You DO NOT know about politics, history, cooking, or code.",
    "   - *Trigger:* If asked 'Who won the election?' or 'How do I make pasta?'",
    "   - *Response:* 'I am tuned exclusively for real-time EV telemetry and trip optimization. Let's focus on your battery levels.'",
    "2. **Conciseness:** Keep responses under 40 words unless explaining a complex strategy. Drivers cannot read long essays.",
    "3. **Tone:** Professional, Calm, Authoritative (like an F1 Race Engineer).",
    "",
    "## OUTPUT FORMAT",
    "Provide plain text responses formatted for a Heads-Up Display (short paragraphs, bullet points for lists)."
].join("\n");

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { messages, context } = body;
        // context contains: { telemetry, trip, user, chargers }

        // Construct the full prompt context
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

        // --- VERTEX AI SDK INTEGRATION ---
        console.log("Attempting Vertex AI SDK Call...");
        let lastError = null;
        try {
            // Initialize Vertex AI
            const vertex_ai = new VertexAI({
                project: 'rangeai',
                location: 'us-central1'
            });

            // Instantiate the model
            const generativeModel = vertex_ai.getGenerativeModel({
                model: 'gemini-2.5-pro'
            });

            const req = {
                contents: [{
                    role: 'user',
                    parts: [{ text: SYSTEM_PROMPT + "\n\n" + fullPrompt + "\n\nUser: " + userMessage }]
                }]
            };

            const streamingResp = await generativeModel.generateContent(req);
            const response = await streamingResp.response;

            if (response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts) {
                const reply = response.candidates[0].content.parts[0].text;
                if (reply) {
                    return NextResponse.json({ reply });
                }
            }
            throw new Error("No candidates returned from Vertex AI");

        } catch (vertexError: any) {
            console.error("Vertex AI Error:", vertexError);
            console.log("Falling back to Rule-Based Co-Pilot.");
            lastError = vertexError;
            // Fallthrough to mock logic below
        }

        // --- FALLBACK MOCK (Rule-Based "Smart" Reply) ---
        console.log("Using Smart Mock AI");

        let mockReply = "";

        if (context) {
            const soc = context.telemetry.arrival_soc;
            const range = context.telemetry.range_km;
            const diet = userMessage.toLowerCase();
            const chargers = context.chargers || [];

            // Dynamic Rule Engine
            if (diet.includes("cargo") || diet.includes("weight") || diet.includes("passenger")) {
                mockReply = `Payload Analysis: You are currently carrying ${context.user.passengers} pax. Adding more weight will increase rolling resistance and drag. Arrival SOC is currently ${soc}%. Keep it light if possible. [Offline Mode]`;
            }
            else if (diet.includes("speed") || diet.includes("fast") || diet.includes("slow")) {
                mockReply = `Velocity Advisory: Aerodynamic drag increases quadratically with speed. Using "Eco" speeds (under 100km/h) is the most effective way to boost your buffer. Current prediction: ${soc}% Arrival SOC. [Offline Mode]`;
            }
            else if (diet.includes("charge") || diet.includes("station") || diet.includes("stop")) {
                if (chargers.length > 0) {
                    const best = chargers[0]; // Assuming sorted or just taking first
                    mockReply = `Charging Strategy: I've identified ${chargers.length} viable stations. The best option is ${best.AddressInfo?.Title || "Station"} (${best.AddressInfo?.Distance?.toFixed(1) || "?"}km away). It fits your route perfectly. [Offline Mode]`;
                } else {
                    mockReply = `Charging Update: I am not detecting high-confidence chargers on this immediate vector. However, with ${soc}% arrival charge, you don't strictly *need* a stop, but keep an eye on the gauge. [Offline Mode]`;
                }
            }
            else if (diet.includes("weather") || diet.includes("rain") || diet.includes("temp")) {
                mockReply = `Environmental Factors: Cabin heating/cooling can consume 1-3kW. If range is tight (${range}km remaining), consider using seat warmers instead of cabin air. [Offline Mode]`;
            }
            else if (diet.includes("hello") || diet.includes("hi") || diet.includes("hey")) {
                mockReply = `Connected. RangeShield Co-Pilot online. Tracking your telemetry. I'm reading ${range}km of range. How can I assist? [Offline Mode]`;
            }
            else {
                // Default Status Report
                if (soc < 15) {
                    mockReply = `CRITICAL ALERT: Arrival SOC is ${soc}%. This is below safety margins. Recommendation: REDUCE SPEED and plan a charging stop immediately. [Offline Mode]`;
                } else {
                    mockReply = `Status Nominal. Arrival SOC predicted at ${soc}%. You have a ${range}km buffer. You are clear to proceed so long as conditions remain stable. [Offline Mode]`;
                }
            }
        } else {
            mockReply = "System initializing... Telemetry link established. Ready for input. [Offline Mode]";
        }

        if (lastError) {
            mockReply += ` (Error: ${lastError.message || JSON.stringify(lastError)})`;
        }

        return NextResponse.json({ reply: mockReply });

    } catch (error) {
        console.error("Co-Pilot Error:", error);
        return NextResponse.json({ error: "Comms Link Failure" }, { status: 500 });
    }
}
