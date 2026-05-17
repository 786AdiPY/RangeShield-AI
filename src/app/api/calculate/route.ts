import { NextResponse } from 'next/server';
import { decodePolyline } from '@/lib/polyline';

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function fetchChargingStations(lat: number, lng: number, radiusKM = 30, maxResults = 10) {
    const apiKey = process.env.OCM_API_KEY;
    if (!apiKey) return [];
    try {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 8000);
        const params = new URLSearchParams({
            output: 'json', latitude: lat.toString(), longitude: lng.toString(),
            distance: radiusKM.toString(), distanceunit: 'KM',
            maxresults: maxResults.toString(), compact: 'true', verbose: 'false', key: apiKey,
        });
        const response = await fetch(`https://api.openchargemap.io/v3/poi/?${params}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) return [];
        return await response.json();
    } catch { return []; }
}

function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nominatim geocoder — free, no key
async function geocodeAddress(query: string): Promise<{ lat: number; lng: number } | null> {
    try {
        const res  = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
            { headers: { 'User-Agent': 'RangeShield-App-API' } }
        );
        const data = await res.json();
        if (data?.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch { /* ignore */ }
    return null;
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { origin, destination, cargoWeight, passengers, avgConsumption, initialBatteryPct, batteryCapacity = 60 } = body;

        // 1. Geocode both addresses (Nominatim — free, no billing)
        const [originCoords, destCoords] = await Promise.all([
            geocodeAddress(origin),
            geocodeAddress(destination),
        ]);
        if (!originCoords || !destCoords) {
            return NextResponse.json({ error: 'Could not geocode one or both locations' }, { status: 400 });
        }

        // 2. OSRM routing (free, no key required)
        const osrmUrl =
            `http://router.project-osrm.org/route/v1/driving/` +
            `${originCoords.lng},${originCoords.lat};${destCoords.lng},${destCoords.lat}` +
            `?overview=full&geometries=polyline`;

        const osrmRes  = await fetch(osrmUrl);
        const osrmData = await osrmRes.json();

        if (osrmData.code !== 'Ok' || !osrmData.routes?.length) {
            console.error('OSRM error:', osrmData);
            return NextResponse.json({ error: 'OSRM routing failed' }, { status: 502 });
        }

        const osrmRoute       = osrmData.routes[0];
        const distanceMeters  = osrmRoute.distance  as number;
        const durationSeconds = osrmRoute.duration  as number;
        const encodedPolyline = osrmRoute.geometry  as string;
        const distanceKm      = distanceMeters / 1000;
        const durationMins    = Math.round(durationSeconds / 60);

        // 3. Elevation via Open-Topo-Data srtm30m (free, no key, max 100 pts/req)
        let totalAscent = 0;
        try {
            const points       = decodePolyline(encodedPolyline);
            const SAMPLE_COUNT = Math.min(100, points.length);
            const indices      = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
                Math.round(i * (points.length - 1) / (SAMPLE_COUNT - 1))
            );
            const locations = indices.map(i => `${points[i][0]},${points[i][1]}`).join('|');
            const elevRes   = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locations}`);
            const elevData  = await elevRes.json();

            if (elevData.status === 'OK') {
                const elevs: number[] = elevData.results.map((r: any) => r.elevation ?? 0);
                for (let i = 0; i < elevs.length - 1; i++) {
                    const diff = elevs[i + 1] - elevs[i];
                    if (diff > 0) totalAscent += diff;
                }
            } else {
                console.warn('Open-Topo-Data:', elevData.error ?? elevData.status);
            }
        } catch (error) {
            console.warn('Elevation fetch failed, continuing with 0:', error);
        }

        // 4. Charging stations along route (OCM)
        let chargingStations: any[] = [];
        if (encodedPolyline && process.env.OCM_API_KEY) {
            try {
                const points          = decodePolyline(encodedPolyline);
                let samplingInterval  = distanceKm > 100 ? distanceKm / 5 : 30;
                const samplePoints: [number, number][] = [];
                let accumulatedDist   = 0;

                for (let i = 1; i < points.length; i++) {
                    accumulatedDist += getDistanceFromLatLonInKm(
                        points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]
                    );
                    if (accumulatedDist > samplingInterval) {
                        samplePoints.push(points[i]);
                        accumulatedDist = 0;
                        if (samplePoints.length >= 30) break;
                    }
                }

                const uniqueStationsMap = new Map();
                const searchRadius      = Math.max(samplingInterval / 1.5, 20);

                for (const pt of samplePoints) {
                    const stations = await fetchChargingStations(pt[0], pt[1], searchRadius, 1);
                    if (stations.length > 0 && !uniqueStationsMap.has(stations[0].ID)) {
                        uniqueStationsMap.set(stations[0].ID, stations[0]);
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                chargingStations = Array.from(uniqueStationsMap.values());
            } catch (error) {
                console.error('Charging station fetch failed:', error);
            }
        }

        // 5. Weather via Open-Meteo (free, no key)
        let temp = 20, wind = 10;
        try {
            const weatherRes  = await fetch(
                `https://api.open-meteo.com/v1/forecast?latitude=${originCoords.lat}&longitude=${originCoords.lng}&current=temperature_2m,wind_speed_10m`
            );
            const weatherData = await weatherRes.json();
            if (weatherData.current) {
                temp = weatherData.current.temperature_2m;
                wind = weatherData.current.wind_speed_10m;
            }
        } catch { console.warn('Weather fetch failed, using defaults'); }

        // 6. Physics engine
        const physicsInput = {
            distance_km:       distanceKm,
            elevation_gain_m:  totalAscent,
            vehicle_temp_c:    body.vehicleTemp   || 25,
            external_temp_c:   temp,
            cargo_mass_kg:     parseFloat(cargoWeight),
            battery_capacity:  parseFloat(batteryCapacity),
            soh:               body.soh           || 100,
            soc:               parseFloat(initialBatteryPct),
            base_efficiency:   parseFloat(avgConsumption),
            tire_pressure_psi: body.tirePressure  || 35,
            wind_speed_kmh:    wind,
        };

        // Normalise efficiency to kWh/km
        if (physicsInput.base_efficiency > 2) physicsInput.base_efficiency /= 100;

        function calculateEnergyUsage(input: typeof physicsInput) {
            const { distance_km, elevation_gain_m, vehicle_temp_c, external_temp_c,
                    cargo_mass_kg, battery_capacity, soh, soc, base_efficiency,
                    tire_pressure_psi, wind_speed_kmh } = input;

            const GRAVITY = 9.81, VEHICLE_MASS = 2100, STANDARD_PRESSURE = 35;
            let energy_kwh = distance_km * base_efficiency;

            const total_mass           = VEHICLE_MASS + cargo_mass_kg;
            const potential_energy_kwh = (total_mass * GRAVITY * (elevation_gain_m || 0)) / 3_600_000;
            if (potential_energy_kwh > 0) energy_kwh += potential_energy_kwh;

            if (tire_pressure_psi < STANDARD_PRESSURE)
                energy_kwh *= 1 + ((STANDARD_PRESSURE - tire_pressure_psi) * 0.003);
            if (vehicle_temp_c < 15 || vehicle_temp_c > 35) energy_kwh *= 1.10;
            const temp_diff = Math.abs(external_temp_c - 20);
            if (temp_diff > 0) energy_kwh *= 1 + (temp_diff * 0.01);
            if (wind_speed_kmh > 0) energy_kwh *= 1 + (wind_speed_kmh * 0.005);

            const effective_capacity = battery_capacity * (soh / 100);
            const current_energy     = effective_capacity * (soc / 100);
            const real_efficiency    = distance_km > 0 ? energy_kwh / distance_km : 0;

            return {
                energy_needed_kwh:  parseFloat(energy_kwh.toFixed(2)),
                remaining_range_km: real_efficiency > 0
                    ? ((current_energy - energy_kwh) / real_efficiency).toFixed(1)
                    : '0',
                is_possible: current_energy > energy_kwh,
                arrival_soc: effective_capacity > 0
                    ? Math.max(0, Math.round(((current_energy - energy_kwh) / effective_capacity) * 100))
                    : 0,
            };
        }

        const mathResult = calculateEnergyUsage(physicsInput);

        const status = mathResult.arrival_soc < 10 ? 'CRITICAL' : 'SAFE';

        return NextResponse.json({
            distance_km:    parseFloat(distanceKm.toFixed(2)),
            duration_mins:  durationMins,
            total_ascent_m: Math.round(totalAscent),
            weather:        { temp, wind },
            consumption:    physicsInput.base_efficiency,
            standard_kwh:   parseFloat((distanceKm * physicsInput.base_efficiency).toFixed(2)),
            predicted_kwh:  mathResult.energy_needed_kwh,
            physics_correction: {
                math_kwh:          mathResult.energy_needed_kwh,
                correction_factor: 1.0,
                reasoning:         'Live Gemma correction active during trip',
                confidence:        'medium',
                source:            'math',
            },
            range_analysis: {
                arrival_soc_standard:  mathResult.arrival_soc,
                arrival_soc_predicted: mathResult.arrival_soc,
                remaining_range:       mathResult.remaining_range_km,
                status,
                details: {
                    base_consumption_kwh: (distanceKm * physicsInput.base_efficiency).toFixed(2),
                    math_energy_kwh:      mathResult.energy_needed_kwh,
                    total_energy_kwh:     mathResult.energy_needed_kwh,
                },
            },
            polyline:          encodedPolyline,
            charging_stations: chargingStations,
            origin_coords:     { lat: originCoords.lat, lng: originCoords.lng },
            dest_coords:       { lat: destCoords.lat,   lng: destCoords.lng   },
        });

    } catch (error) {
        console.error('Calculation API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
