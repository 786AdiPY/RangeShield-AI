import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SYSTEM_INSTRUCTION = `You are RangeShield Co-Pilot, powered by Gemma 4 (gemma-4-26b-a4b-it) — a 26-billion parameter AI model by Google.
You are in PLANNING MODE, helping the driver optimise their trip before they leave.

Your job: look at the route data, charging stations, and vehicle settings and give one clear, friendly recommendation.

RECOMMENDATION PRIORITY (follow this order strictly):
1. Route optimisation — is there a shorter, flatter, or more efficient path?
2. Charging stops — recommend the best station along the route.
3. Battery / vehicle adjustments — tyre pressure, pre-conditioning, efficiency mode.
4. Reduce cargo — only if the trip is truly marginal and options 1–3 are exhausted.
5. Reduce passengers — almost never. Only absolute last resort.

If asked what model/AI you are: say "I'm powered by Gemma 4 (26B parameters) by Google, running via Google AI Studio."

Style: friendly, 2–4 sentences, one clear recommendation. Never mention passengers or cargo unprompted.
Only discuss EV driving, range, charging, and trip planning.`;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
    try {
        const res  = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
            { headers: { 'User-Agent': 'RangeShield-CoPilot' } }
        );
        const data = await res.json();
        if (data?.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch { /* ignore */ }
    return null;
}

async function fetchOSRM(origin: string, dest: string) {
    try {
        const [o, d] = await Promise.all([geocode(origin), geocode(dest)]);
        if (!o || !d) return null;
        const res  = await fetch(
            `http://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=false`
        );
        const data = await res.json();
        if (data.code !== 'Ok') return null;
        return {
            distance_km: Math.round(data.routes[0].distance / 1000),
            duration_min: Math.round(data.routes[0].duration / 60),
            midLat: (o.lat + d.lat) / 2,
            midLng: (o.lng + d.lng) / 2,
        };
    } catch { return null; }
}

async function fetchOCM(lat: number, lng: number, radius = 40): Promise<any[]> {
    const apiKey = process.env.OCM_API_KEY;
    if (!apiKey) return [];
    try {
        const params = new URLSearchParams({
            output: 'json', latitude: lat.toString(), longitude: lng.toString(),
            distance: radius.toString(), distanceunit: 'KM',
            maxresults: '5', compact: 'true', verbose: 'false', key: apiKey,
        });
        const res  = await fetch(`https://api.openchargemap.io/v3/poi/?${params}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    let body: any = {};
    try {
        body = await req.json();
        const { messages, context } = body;

        const apiKey = process.env.Model_key;
        if (!apiKey) return NextResponse.json({ error: 'Model_key not set' }, { status: 500 });

        const userMessage: string = messages?.[messages.length - 1]?.content ?? '';
        const trip = context?.trip ?? {};
        const t    = context?.telemetry ?? {};

        // Fetch OSRM + OCM on first USER message (not counting any initial assistant greeting)
        let routeInfo: Awaited<ReturnType<typeof fetchOSRM>> = null;
        let chargers: any[] = context?.chargers ?? [];

        const userMessageCount = (messages ?? []).filter((m: any) => m.role === 'user').length;
        const isFirstMessage   = userMessageCount === 1;
        if (isFirstMessage && trip.origin && trip.destination) {
            const [osrmResult, ocmResult] = await Promise.all([
                fetchOSRM(trip.origin, trip.destination),
                (async () => {
                    // OCM: search near midpoint if we have chargers, else fetch now
                    if (chargers.length > 0) return chargers;
                    const o = await geocode(trip.origin);
                    const d = trip.destination ? await geocode(trip.destination) : null;
                    if (!o) return [];
                    const midLat = d ? (o.lat + d.lat) / 2 : o.lat;
                    const midLng = d ? (o.lng + d.lng) / 2 : o.lng;
                    return fetchOCM(midLat, midLng);
                })(),
            ]);
            routeInfo = osrmResult;
            chargers  = ocmResult;
        }

        // Build rich context note
        const passengers  = trip.passengers  ?? 1;
        const cargoKg     = trip.cargo_kg    ?? 0;
        const avgPaxKg    = 75;
        const vehicleKg   = 2100;
        const totalWeight = vehicleKg + passengers * avgPaxKg + cargoKg;

        const lines: (string | null)[] = [
            '=== PLANNING MODE ===',
            trip.origin      ? `Route: ${trip.origin} → ${trip.destination ?? 'unknown destination'}` : null,
            routeInfo        ? `OSRM route distance: ${routeInfo.distance_km} km, ~${routeInfo.duration_min} min driving` : null,
            trip.battery_pct != null ? `Current battery: ${trip.battery_pct}% of ${trip.battery_kwh ?? '?'} kWh` : null,
            t.efficiency     != null ? `Efficiency: ${t.efficiency} kWh/km` : null,
            trip.tire_psi    != null ? `Tyre pressure: ${trip.tire_psi} PSI (optimal: 35 PSI)` : null,
            `Passengers: ${passengers}`,
            `Cargo: ${cargoKg} kg`,
            `Total vehicle weight: ${totalWeight} kg (vehicle ${vehicleKg} kg + ${passengers} pax × ${avgPaxKg} kg + ${cargoKg} kg cargo)`,
            t.arrival_soc    != null ? `Predicted arrival battery: ${t.arrival_soc}%` : 'Arrival battery: not yet calculated (user has not run range analysis)',
            chargers.length > 0
                ? `Charging stations along route: ${chargers.length} (nearest: ${chargers[0]?.AddressInfo?.Title ?? 'unknown'})`
                : 'No charging stations found on this route yet.',
        ].filter(Boolean);

        const contextNote = lines.join('\n');

        // Conversation history
        const history = (messages ?? []).slice(0, -1).map((m: any) => ({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

        // Seed as model turn so Gemma treats it as known data
        if (contextNote) {
            history.push({
                role:  'model',
                parts: [{ text: `I have your trip data loaded:\n${contextNote}\n\nReady to help optimise your journey!` }],
            });
        }

        history.push({ role: 'user', parts: [{ text: userMessage }] });

        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 120000);

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                    contents: history,
                    generationConfig: { temperature: 0.5, maxOutputTokens: 300 },
                }),
            }
        );
        clearTimeout(timeoutId);

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`AI Studio ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
        const reply = parts
            .filter((p: any) => !p.thought)
            .map((p: any) => p.text ?? '')
            .join('')
            .trim();
        if (!reply) throw new Error('Empty response');

        return NextResponse.json({ reply, chargerCount: chargers.length, routeInfo });

    } catch (err) {
        console.warn('[CoPilot] Gemma failed:', err instanceof Error ? err.message : err);

        const context = body?.context;
        const msg     = (body?.messages?.[body.messages.length - 1]?.content ?? '').toLowerCase();
        const trip    = context?.trip    ?? {};
        const t       = context?.telemetry ?? {};
        const soc     = t.arrival_soc ?? null;
        const nChg    = context?.chargers?.length ?? 0;

        let reply = '';
        if (!trip.origin) {
            reply = "Enter your origin and destination above, then I can give you a personalised range and route analysis!";
        } else if (soc !== null && soc < 10) {
            reply = `Heads up — with your current settings I'm predicting only ${soc}% battery on arrival. Try charging before you leave or look for a fast charger about halfway through.`;
        } else if (msg.includes('charge') || msg.includes('station')) {
            reply = nChg > 0
                ? `There are ${nChg} charging stations along your route. Even with a comfortable buffer, a quick top-up halfway is always good practice.`
                : `I haven't found charging stations on this route yet. Make sure your battery is as full as possible before you leave.`;
        } else if (msg.includes('route') || msg.includes('faster') || msg.includes('shorter')) {
            reply = `I'll check the OSRM routing for the most efficient path. A flatter route can save 10–15% energy compared to a hilly one — worth the extra few minutes.`;
        } else {
            reply = soc !== null
                ? `Planning looks ${soc >= 20 ? 'solid' : 'a bit tight'} — ${soc}% predicted on arrival. ${soc >= 20 ? 'Your route and battery settings are in good shape.' : 'Consider inflating tyres to 35 PSI and pre-cooling the cabin to recover a few extra kilometres.'}`
                : `Enter your route details and I'll analyse the best way to reach your destination efficiently!`;
        }

        return NextResponse.json({ reply });
    }
}
