import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function extractFirstJson(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

const ANOMALY_CONTEXT: Record<string, string> = {
    cold_snap:               'Sudden temperature drop to near-freezing. HVAC heating load spikes non-linearly. Battery internal resistance increases.',
    tyre_pressure_drop:      'Tyre pressure critically low (24 PSI vs 35 PSI standard). Rolling resistance increases beyond linear math model.',
    battery_degrade:         'Battery SoH dropped to 74%. Discharge curve steepens below 50% SoC. Effective range significantly less than math predicts.',
    RAPID_DRAIN:             'Energy drain rate sustained above 1.5× baseline for >3 seconds. Possible combined load from HVAC, degraded battery, and terrain. Physics engine underestimating consumption.',
    CHARGER_WINDOW_CLOSING:  'Last viable charging station within 8 km of current position. SOC trajectory indicates possible sub-threshold arrival if charger is skipped. Driver must accept detour or risk arrival below 10%.',
    POINT_OF_NO_RETURN:      'CRITICAL: Projected range (from live drain rate and remaining SoC) is now less than remaining distance plus 10% safety buffer. Immediate reroute to charger or reduced speed required.',
    periodic_health:         'Routine mid-trip health snapshot. No active anomaly. Evaluate whether current drain rate and SoC trajectory align with destination arrival above 20%.',
};

const FALLBACKS: Record<string, { factor: number; reasoning: string; suggestion: string }> = {
    cold_snap:              { factor: 1.22, reasoning: "It's gotten really cold outside, which means your heater is working overtime and using more battery than usual.", suggestion: 'Try turning the cabin heat down to 18°C and easing off to around 60 km/h — that should help stretch your range nicely.' },
    tyre_pressure_drop:     { factor: 1.14, reasoning: 'Your tyre pressure has dropped to 24 PSI, which makes the car work harder to roll and burns more energy.', suggestion: 'Pull over at the next garage or petrol station and pump the tyres back up to 35 PSI — you\'ll feel the difference immediately.' },
    battery_degrade:        { factor: 1.18, reasoning: "Your battery's health has dipped to 74%, so it doesn't hold as much charge as it used to — your real range is shorter than the display suggests.", suggestion: 'Plan a charging stop a bit earlier than you normally would, especially before the battery drops below 30%.' },
    RAPID_DRAIN:            { factor: 1.30, reasoning: "Your battery is draining about 1.5 times faster than expected — something's pulling a lot of extra power right now.", suggestion: 'Slow down to around 60 km/h, switch off the AC if it\'s on, and check nothing is running in the background.' },
    CHARGER_WINDOW_CLOSING: { factor: 1.15, reasoning: "There's a charging station just 8 km ahead — and it might be your last good opportunity to top up before the destination.", suggestion: "I'd recommend taking the short detour to charge now. Skipping it could leave you cutting it very close at the end." },
    POINT_OF_NO_RETURN:     { factor: 1.45, reasoning: "Based on your current drain rate, your projected range is now shorter than the distance you have left — this is critical.", suggestion: 'Reroute to the nearest charger right away and drop your speed to 50 km/h to conserve as much battery as possible.' },
    periodic_health:        { factor: 1.05, reasoning: 'Everything looks good — your battery and drain rate are both on track for your destination.', suggestion: 'Keep up your current pace and you should arrive with a comfortable buffer. Nice driving!' },
};

function fallbackResponse(anomalyType: string) {
    const fb = FALLBACKS[anomalyType] ?? { factor: 1.10, reasoning: 'Anomaly detected — conservative 10% correction applied.', suggestion: 'Monitor vehicle conditions and reduce speed if drain rate stays elevated.' };
    return NextResponse.json({ correction_factor: fb.factor, reasoning: fb.reasoning, suggestion: fb.suggestion, confidence: 'low', source: 'fallback', anomalyType });
}

export async function POST(req: Request) {
    let anomalyType = 'unknown';
    try {
        const body        = await req.json();
        anomalyType       = body?.anomalyType ?? 'unknown';

        // Fast-path: dev-mode warmup call just needs to trigger compilation
        if (anomalyType === 'warmup') {
            return NextResponse.json({ correction_factor: 1.0, reasoning: 'warmup', suggestion: '', confidence: 'low', source: 'fallback', anomalyType: 'warmup' });
        }
        const telemetry   = body?.telemetry ?? {};

        const apiKey = process.env.Model_key;
        if (!apiKey) return NextResponse.json({ error: 'Model_key not set' }, { status: 500 });

        const soc   = Number(telemetry.soc   ?? 50);
        const soh   = Number(telemetry.soh   ?? 82);
        const temp  = Number(telemetry.temp  ?? 22);
        const tyre  = Number(telemetry.tirePressure ?? 32);
        const drain = Number(telemetry.drainRate    ?? 0.2);
        const speed = Number(telemetry.speed        ?? 60);

        const anomalyCtx = ANOMALY_CONTEXT[anomalyType] ?? `Anomaly type: ${anomalyType}`;
        const prompt = `You are RangeShield Guardian, a friendly real-time EV driving assistant. An anomaly was just detected during a live trip.

Anomaly: ${anomalyType}
What happened: ${anomalyCtx}
Live telemetry: battery ${soc.toFixed(1)}%, health ${soh}%, temp ${temp}°C, tyres ${tyre} PSI, drain ${(drain * 1000).toFixed(0)} Wh/km, speed ${speed} km/h

Write a short, friendly alert for the driver — like a calm, knowledgeable friend warning them about something important.
- "reason": 1 sentence explaining what's happening in plain English (no jargon, no percentages unless helpful)
- "suggestion": 1 clear action the driver should take right now, warm and direct
- "severity": INFO, WARNING, or CRITICAL
- "factor": energy correction multiplier between 0.8 and 1.5

Respond with ONLY this JSON, no markdown, no extra text:
{"factor": 1.22, "reason": "It's gotten really cold outside, which means your heater is working overtime and draining the battery faster.", "suggestion": "Try turning the cabin heat down to 18°C and easing off to around 60 km/h — that'll help stretch your range.", "severity": "WARNING"}`;

        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 120000);

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
                }),
            }
        );
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`AI Studio ${res.status}`);

        const data    = await res.json();
        const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const jsonStr = extractFirstJson(text);
        if (!jsonStr) throw new Error('No JSON in response');

        const parsed = JSON.parse(jsonStr);
        return NextResponse.json({
            correction_factor: Number(parsed.factor) || 1.0,
            reasoning:         String(parsed.reason      || ''),
            suggestion:        String(parsed.suggestion  || ''),
            confidence:        parsed.severity ?? 'medium',
            source:            'cloud',
            anomalyType,
        });

    } catch (err) {
        console.warn('[Guardian] Gemma failed, using rule-based fallback:', err instanceof Error ? err.message : err);
        return fallbackResponse(anomalyType);
    }
}
