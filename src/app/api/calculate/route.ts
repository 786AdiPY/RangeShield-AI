import { NextResponse } from 'next/server';
import { decodePolyline } from '@/lib/polyline';

// Helper to fetch stations from OCM
async function fetchChargingStations(lat: number, lng: number, radiusKM: number = 30, maxResults: number = 10) {
    const apiKey = process.env.OCM_API_KEY;
    if (!apiKey) return [];

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout to prevent OCM Timeouts

        const params = new URLSearchParams({
            output: 'json',
            latitude: lat.toString(),
            longitude: lng.toString(),
            distance: radiusKM.toString(), // Look for chargers within radius
            distanceunit: 'KM',
            maxresults: maxResults.toString(), // Limit results per stop
            compact: 'true',
            verbose: 'false',
            key: apiKey
        });

        // console.log(`Fetching OCM: Lat ${lat.toFixed(2)}, Lng ${lng.toFixed(2)}, Radius ${radiusKM}km`);

        const response = await fetch(`https://api.openchargemap.io/v3/poi/?${params}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`OCM API failed: ${response.statusText}`);
            return [];
        }

        const stations = await response.json();
        // console.log(`OCM: Found ${stations.length} stations`);
        return stations;
    } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
            console.warn("OCM API Timeout");
        } else {
            console.error("Error fetching OCM stations:", e);
        }
        return [];
    }
}

// Simple haversine distance for sampling
function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c; // Distance in km
    return d;
}

function deg2rad(deg: number) {
    return deg * (Math.PI / 180);
}


export async function POST(req: Request) {
    try {
        const body = await req.json();
        const {
            origin,
            destination,
            cargoWeight,
            passengers,
            avgConsumption, // kWh/100km (as per typical user input) or kWh/km? User prompt says "Accept from user input", calculation logic says "Convert avgConsumption from kWh/100km to kWh/km".
            // However, in page.tsx we implemented it as 0.1-0.5 kWh/km.
            // Let's assume the input from page.tsx is already kWh/km if we connect them, but the prompt says 
            // "Convert avgConsumption from kWh/100km to kWh/km". 
            // I will assume the API expects kWh/100km to follow the prompt strict logic, or handle 0.2 as kWh/km if valid.
            // actually the prompt says "Convert avgConsumption from kWh/100km to kWh/km". 
            // If I look at page.tsx, default is 0.2 kWh/km. -> 20 kWh/100km.
            // I will adhere to the prompt's logic for the API: Input is consumption. 
            // Let's check the prompt "avgConsumption (Number): The car's baseline energy usage in kWh/100km."
            // So I will convert the page.tsx inputs to kWh/100km before sending, OR 
            // I will strictly follow the API prompt and assume the input is kWh/100km.

            initialBatteryPct,
            batteryCapacity = 60
        } = body;

        // 1. Google Routes API
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
            console.warn("GOOGLE_MAPS_API_KEY is missing. Using mock data for demonstration.");
            // Fallback for demo/dev without key
            // return NextResponse.json({ error: "Configuration Error: GOOGLE_MAPS_API_KEY missing" }, { status: 500 });
        }

        let distanceMeters = 0;
        let durationSeconds = 0;
        let encodedPolyline = "";

        if (apiKey) {
            const routesRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': apiKey,
                    'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
                },
                body: JSON.stringify({
                    origin: { address: origin },
                    destination: { address: destination },
                    travelMode: 'DRIVE',
                    routingPreference: 'TRAFFIC_AWARE'
                })
            });

            if (!routesRes.ok) {
                const err = await routesRes.text();
                console.error("Google Routes Error:", err);
                return NextResponse.json({ error: `Google Routes API Failed: ${err}` }, { status: routesRes.status });
            } else {
                const routesData = await routesRes.json();
                if (routesData.routes && routesData.routes.length > 0) {
                    distanceMeters = parseInt(routesData.routes[0].distanceMeters);
                    durationSeconds = parseInt(routesData.routes[0].duration.replace('s', ''));
                    encodedPolyline = routesData.routes[0].polyline.encodedPolyline;
                }
            }
        }

        // Mock if API failed or no key (For stability during dev)
        // Mock removed to ensure real data or error
        if (distanceMeters === 0) {
            return NextResponse.json({ error: "No route found or API failed" }, { status: 404 });
        }

        const distanceKm = distanceMeters / 1000;
        const durationMins = Math.round(durationSeconds / 60);

        // 1.5 Calculate Elevation Gain (Total Ascent)
        // User requested logic: Sample 256 points, sum positive climbs.
        let totalAscent = 0;
        if (apiKey && encodedPolyline) {
            try {
                // Use the encoded polyline directly with the path parameter for Elevation API
                // https://developers.google.com/maps/documentation/elevation/start#path_requests
                const elevationRes = await fetch(`https://maps.googleapis.com/maps/api/elevation/json?path=enc:${encodedPolyline}&samples=256&key=${apiKey}`);

                if (elevationRes.ok) {
                    const elevationData = await elevationRes.json();
                    if (elevationData.results) {
                        const elevations = elevationData.results;
                        // Sum up only the positive climbs
                        for (let i = 0; i < elevations.length - 1; i++) {
                            const diff = elevations[i + 1].elevation - elevations[i].elevation;
                            if (diff > 0) {
                                totalAscent += diff;
                            }
                        }
                    }
                } else {
                    console.error("Elevation API Error:", await elevationRes.text());
                }
            } catch (error) {
                console.error("Elevation Logic Failed:", error);
            }
        }

        // --- FETCH CHARGING STATIONS ALONG ROUTE ---
        let chargingStations: any[] = [];
        if (encodedPolyline && process.env.OCM_API_KEY) {
            try {
                // Decode route
                const points = decodePolyline(encodedPolyline);

                // Dynamic Sampling: "TotalDistance / 5" (User Request)
                // If distance > 100km, make sure we sample exactly ~5 times evenly.
                // If distance is short (< 100km), fallback to a reasonable default like 30km.
                let samplingInterval = 30;
                if (distanceKm > 100) {
                    samplingInterval = distanceKm / 5;
                }

                console.log(`Route Distance: ${distanceKm.toFixed(1)} km`);
                console.log(`Sampling interval calculated as ${samplingInterval.toFixed(2)} km.`);

                const samplePoints: [number, number][] = [];
                // Start empty, we only want points AFTER intervals start (User: "first one after 24 km from source")
                // Previously we pushed start point, causing confusion.

                let accumulatedDist = 0;

                for (let i = 1; i < points.length; i++) {
                    // Correct Segment Distance Logic:
                    // dist(P[i-1], P[i]) adds to the tally.
                    const d = getDistanceFromLatLonInKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
                    accumulatedDist += d;

                    // Sample every calculated interval
                    if (accumulatedDist > samplingInterval) {
                        samplePoints.push(points[i]);
                        accumulatedDist = 0; // Reset counter for next interval

                        // Strict Cap: Cap at 30 points max
                        if (samplePoints.length >= 30) break;
                    }
                }

                // Ensure we don't miss the end if it's significant
                // With dist/5 logic, we might end up with 5 or 6 points depending on rounding.
                // Just let the loop do its job.

                console.log(`Sampling ${samplePoints.length} points for charging stations along route.`);

                // Sequential Fetching to avoid "Too Many Requests" (429)
                const uniqueStationsMap = new Map();

                for (const pt of samplePoints) {
                    // Fetch stations near this point
                    // Dynamic Search Radius: Half the interval ensures we cover the segments without too much overlap
                    // But allow at least 20km to find something in rural areas
                    const searchRadius = Math.max(samplingInterval / 1.5, 20);

                    // STRICT LIMIT: Show only ONE charging station per interval
                    const stations = await fetchChargingStations(pt[0], pt[1], searchRadius, 1);

                    if (stations.length > 0) {
                        const st = stations[0]; // Take only the first one
                        if (!uniqueStationsMap.has(st.ID)) {
                            uniqueStationsMap.set(st.ID, st);
                        }
                    }

                    // Simple throttle to respect API rate limits
                    await new Promise(resolve => setTimeout(resolve, 200));
                }

                chargingStations = Array.from(uniqueStationsMap.values());
                console.log(`Found ${chargingStations.length} unique charging stations after filtering.`);

            } catch (error) {
                console.error("Failed to fetch charging stations:", error);
            }
        }
        // -------------------------------------------



        let lat = 37.7749;
        let lon = -122.4194;

        try {

            const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(origin)}`, {
                headers: { 'User-Agent': 'RangeShield-App-API' }
            });
            const geoData = await geoRes.json();
            if (geoData && geoData.length > 0) {
                lat = parseFloat(geoData[0].lat);
                lon = parseFloat(geoData[0].lon);
            }
        } catch (e) {
            console.error("Geocoding failed, utilizing defaults");
        }


        let temp = 20;
        let wind = 10;

        try {
            const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m`);
            const weatherData = await weatherRes.json();
            if (weatherData.current) {
                temp = weatherData.current.temperature_2m;
                wind = weatherData.current.wind_speed_10m;
            }
        } catch (e) {
            console.error("Weather API failed, using defaults");
        }

        // 3. Calculation Logic (New Physics Engine)

        // Map inputs to the user's function signature
        const physicsInput = {
            distance_km: distanceKm,
            elevation_gain_m: totalAscent, // From 1.5
            vehicle_temp_c: body.vehicleTemp || 25, // Default if not passed (though we updated frontend)
            external_temp_c: temp, // From Open-Meteo
            cargo_mass_kg: parseFloat(cargoWeight),
            battery_capacity: parseFloat(batteryCapacity),
            soh: body.soh || 100, // Default 100 if missing
            soc: parseFloat(initialBatteryPct),
            base_efficiency: parseFloat(avgConsumption), // kWh/km or kWh/100km? User logic simply multiplies: distance * base. 
            // If distance is KM, base must be kWh/km. 
            // Frontend input is 0.2 (kWh/km). 
            // Prompt was "baseline in kWh/100km", but if user inputs 0.2, it's km.
            // Let's normalize: if > 5, it's probably 100km.
            // Actually, let's keep the user's literal function logic below.

            tire_pressure_psi: body.tirePressure || 35,
            wind_speed_kmh: wind // From Open-Meteo
        };

        // Normalize efficiency for the function: The function does `distance_km * base_efficiency`.
        // So base_efficiency MUST be kWh/km.
        if (physicsInput.base_efficiency > 2) {
            physicsInput.base_efficiency = physicsInput.base_efficiency / 100;
        }

        // --- User's Physics Function ---
        function calculateEnergyUsage(input: any) {
            const {
                distance_km,
                elevation_gain_m,
                vehicle_temp_c,
                external_temp_c,
                cargo_mass_kg,
                battery_capacity,
                soh,
                soc,
                base_efficiency,
                tire_pressure_psi,
                wind_speed_kmh
            } = input;

            const GRAVITY = 9.81;
            const VEHICLE_MASS = 2100;
            const STANDARD_PRESSURE = 35;

            let energy_kwh = distance_km * base_efficiency;

            const total_mass = VEHICLE_MASS + cargo_mass_kg;

            // Fix: handle potential undefined elevation
            const safe_elevation = elevation_gain_m || 0;

            const potential_energy_joules = total_mass * GRAVITY * safe_elevation;
            const potential_energy_kwh = potential_energy_joules / 3600000;

            if (potential_energy_kwh > 0) {
                energy_kwh += potential_energy_kwh;
            }

            if (tire_pressure_psi < STANDARD_PRESSURE) {
                const pressure_diff = STANDARD_PRESSURE - tire_pressure_psi;
                const pressure_penalty = 1 + (pressure_diff * 0.003);
                energy_kwh *= pressure_penalty;
            }

            if (vehicle_temp_c < 15 || vehicle_temp_c > 35) {
                energy_kwh *= 1.10;
            }

            const temp_diff = Math.abs(external_temp_c - 20);
            if (temp_diff > 0) {
                energy_kwh *= (1 + (temp_diff * 0.01));
            }

            if (wind_speed_kmh > 0) {
                energy_kwh *= (1 + (wind_speed_kmh * 0.005));
            }

            const effective_capacity = battery_capacity * (soh / 100);
            const current_energy = effective_capacity * (soc / 100);

            const real_efficiency = distance_km > 0 ? energy_kwh / distance_km : 0;

            return {
                energy_needed_kwh: parseFloat(energy_kwh.toFixed(2)),
                remaining_range_km: real_efficiency > 0 ? ((current_energy - energy_kwh) / real_efficiency).toFixed(1) : "0",
                is_possible: current_energy > energy_kwh,
                arrival_soc: effective_capacity > 0 ? Math.max(0, Math.round(((current_energy - energy_kwh) / effective_capacity) * 100)) : 0
            };
        }
        // -------------------------------

        const result = calculateEnergyUsage(physicsInput);

        const status = result.arrival_soc < 10 ? 'CRITICAL' : 'SAFE';

        return NextResponse.json({
            distance_km: parseFloat(distanceKm.toFixed(2)),
            duration_mins: durationMins,
            total_ascent_m: Math.round(totalAscent), // Explicitly return this now
            weather: { temp, wind },
            consumption: physicsInput.base_efficiency,

            // Map new result to old structure key names for compatibility
            standard_kwh: parseFloat((distanceKm * physicsInput.base_efficiency).toFixed(2)), // Base ideal
            predicted_kwh: result.energy_needed_kwh,

            range_analysis: {
                arrival_soc_standard: 0, // Deprecated or re-calc if needed
                arrival_soc_predicted: result.arrival_soc,
                status: status,
                details: {
                    base_consumption_kwh: (distanceKm * physicsInput.base_efficiency).toFixed(2),
                    total_energy_kwh: result.energy_needed_kwh
                }
            },
            polyline: encodedPolyline,
            charging_stations: chargingStations // Include stations in response
        });

    } catch (error) {
        console.error("Calculation API Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
