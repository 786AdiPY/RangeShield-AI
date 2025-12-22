import { NextResponse } from 'next/server';

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

        // 2. Open-Meteo API
        // First Geocode Origin to get Lat/Lng for Weather
        // We can use the Nominatim logic here again or assume simple geocode.
        // The prompt says "Use the nominatim or Google Geocoding result to get the lat/lng of the Origin."
        // Since we are server side, we can call Nominatim.

        let lat = 37.7749; // Default SF
        let lon = -122.4194;

        try {
            // Quick geocode for origin city name
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

        // Get Weather
        let temp = 20; // Default C
        let wind = 10; // Default km/h

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

        // 3. Calculation Logic

        // Convert avgConsumption from kWh/100km to kWh/km
        // Input avgConsumption is expected to be kWh/100km according to prompt requirements "The car's baseline energy usage in kWh/100km"
        // But let's handle if the user passes a small number < 1 which implies kWh/km.
        let baseConsumptionPerKm = avgConsumption;
        if (avgConsumption > 2) {
            // Assume input is kWh/100km (e.g. 18 kWh/100km)
            baseConsumptionPerKm = avgConsumption / 100;
        }
        // If input is 0.2, it remains 0.2 (kWh/km)

        // Ideal Energy
        const idealEnergyKwh = distanceKm * baseConsumptionPerKm;

        // Apply Penalties
        let penaltyFactor = 1.0;

        // Load Penalty: +2% for every 50kg > 100kg
        const totalPayload = (passengers * 75) + cargoWeight;
        if (totalPayload > 100) {
            const extraWeight = totalPayload - 100;
            const penaltyUnits = Math.floor(extraWeight / 50);
            penaltyFactor += (penaltyUnits * 0.02);
        }

        // Temp Penalty: If temp < 10°C, +15%
        if (temp < 10) {
            penaltyFactor += 0.15;
        }

        // Wind Penalty: If wind > 20 km/h, +10%
        if (wind > 20) {
            penaltyFactor += 0.10;
        }

        // Traffic Penalty: Speed < 30km/h -> +10%
        const avgSpeedKmH = distanceKm / (durationMins / 60);
        if (avgSpeedKmH < 30) {
            penaltyFactor += 0.10;
        }

        const predictedEnergyKwh = idealEnergyKwh * penaltyFactor;

        // Range Analysis
        const currentBatteryKwh = batteryCapacity * (initialBatteryPct / 100);

        const remainingKwhStandard = currentBatteryKwh - idealEnergyKwh;
        const remainingKwhPredicted = currentBatteryKwh - predictedEnergyKwh;

        const arrivalSocStandard = Math.max(0, Math.round((remainingKwhStandard / batteryCapacity) * 100));
        const arrivalSocPredicted = Math.max(0, Math.round((remainingKwhPredicted / batteryCapacity) * 100));

        const status = arrivalSocPredicted < 10 ? 'CRITICAL' : 'SAFE';

        return NextResponse.json({
            distance_km: parseFloat(distanceKm.toFixed(2)),
            duration_mins: durationMins,
            weather: { temp, wind },
            consumption: avgConsumption,
            standard_kwh: parseFloat(idealEnergyKwh.toFixed(2)),
            predicted_kwh: parseFloat(predictedEnergyKwh.toFixed(2)),
            range_analysis: {
                arrival_soc_standard: arrivalSocStandard,
                arrival_soc_predicted: arrivalSocPredicted,
                status,
            },
            polyline: encodedPolyline
        });

    } catch (error) {
        console.error("Calculation API Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
