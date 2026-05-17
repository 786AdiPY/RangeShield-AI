export interface PhysicsBaseline {
    energy_needed_kwh: number;
    remaining_range_km: string;
    arrival_soc: number;
}

export interface PhysicsContext {
    distance_km: number;
    elevation_gain_m: number;
    vehicle_temp_c: number;
    external_temp_c: number;
    wind_speed_kmh: number;
    tire_pressure_psi: number;
    soc: number;
    soh: number;
    base_efficiency: number; // kWh/km
    cargo_mass_kg: number;
}

export interface CorrectionResult {
    correction_factor: number;
    reasoning: string;
    confidence: 'low' | 'medium' | 'high';
    source: 'cloud' | 'local' | 'fallback';
}

function buildPrompt(baseline: PhysicsBaseline, ctx: PhysicsContext): string {
    return `You are an EV range correction AI. Given the inputs below, respond with ONLY a JSON object — no explanation, no markdown, no extra text.

dist=${ctx.distance_km.toFixed(1)}km temp=${ctx.external_temp_c}°C wind=${ctx.wind_speed_kmh}km/h tyre=${ctx.tire_pressure_psi}PSI elev=${ctx.elevation_gain_m.toFixed(0)}m SoC=${ctx.soc}% SoH=${ctx.soh}%

Respond with ONLY this JSON — no explanation, no markdown, no extra text:
{"factor": 1.12, "reason": "cold temps increase HVAC load", "severity": "WARNING"}`;
}

async function callCloudGemma(prompt: string, signal?: AbortSignal): Promise<CorrectionResult> {
    const apiKey = process.env.Model_key;
    if (!apiKey) throw new Error('Model_key not set');

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 60 },
            }),
        }
    );

    if (!res.ok) {
        const err = await res.text();
        console.error(`[PhysicsCorrection] AI Studio HTTP ${res.status} — model: gemma-4-26b-a4b-it — body: ${err.slice(0, 400)}`);
        throw new Error(`AI Studio ${res.status}: ${err}`);
    }

    const data = await res.json();
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const jsonStr = extractJson(text);
    if (!jsonStr) throw new Error('No JSON in AI Studio response');

    const parsed = JSON.parse(jsonStr);
    return {
        correction_factor: Number(parsed.factor) || 1.0,
        reasoning: String(parsed.reason || ''),
        confidence: parsed.severity ?? 'medium',
        source: 'cloud',
    };
}

async function callLocalGemma(prompt: string): Promise<CorrectionResult> {
    const base = process.env.OLLAMA_URL || 'http://localhost:11434';

    const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gemma4:4b',
            prompt,
            stream: false,
            options: { temperature: 0.1 },
        }),
    });

    if (!res.ok) throw new Error(`Ollama ${res.status}`);

    const data = await res.json();
    const text: string = data.response ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Ollama response');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
        correction_factor: Number(parsed.factor) || 1.0,
        reasoning: String(parsed.reason || ''),
        confidence: parsed.severity ?? 'medium',
        source: 'local',
    };
}

function extractJson(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
        ),
    ]);
}

export async function getGemmaCorrection(
    baseline: PhysicsBaseline,
    ctx: PhysicsContext
): Promise<CorrectionResult> {
    const prompt = buildPrompt(baseline, ctx);

    try {
        const ac = new AbortController();
        const id = setTimeout(() => ac.abort(), 30000);
        const result = await callCloudGemma(prompt, ac.signal);
        clearTimeout(id);
        return result;
    } catch (cloudErr) {
        console.warn('[PhysicsCorrection] Cloud Gemma failed:', cloudErr instanceof Error ? cloudErr.message : cloudErr);
    }

    try {
        return await withTimeout(callLocalGemma(prompt), 5000);
    } catch (localErr) {
        console.warn('[PhysicsCorrection] Local Gemma failed:', localErr instanceof Error ? localErr.message : localErr);
    }

    return {
        correction_factor: 1.0,
        reasoning: 'AI correction unavailable — math baseline used',
        confidence: 'low',
        source: 'fallback',
    };
}