async function testApi() {
    try {
        console.log("Testing API with Long Distance Route...");
        const res = await fetch('http://localhost:3000/api/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                origin: "Los Angeles, CA",
                destination: "Las Vegas, NV",
                cargoWeight: 0,
                passengers: 1,
                avgConsumption: 20,
                initialBatteryPct: 85,
                batteryCapacity: 100
            })
        });

        if (!res.ok) {
            console.error("API failed:", res.status, await res.text());
            return;
        }

        const data = await res.json();
        console.log("Status:", res.status);
        console.log("Distance:", data.distance_km);
        console.log("Stations Found:", data.charging_stations ? data.charging_stations.length : 0);
        if (data.charging_stations && data.charging_stations.length > 0) {
            console.log("Sample Station:", JSON.stringify(data.charging_stations[0].AddressInfo.Title));
        } else {
            console.warn("⚠️ No charging stations returned!");
        }
    } catch (e) {
        console.error("Test failed:", e);
    }
}

testApi();
