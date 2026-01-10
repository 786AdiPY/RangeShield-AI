import { Kafka, Producer } from 'kafkajs';
import * as turf from '@turf/turf';

// --- CONFIG ---
const KAFKA_BROKERS = ['pkc-xrnwx.asia-south2.gcp.confluent.cloud:9092'];
const TELEMETRY_TOPIC_STATIC = 'vehicle_health_stream'; // Reuse existing topic if new one missing
const TELEMETRY_TOPIC_DYNAMIC = 'vehicle_health_stream'; // For /trip stream
const MOVEMENT_TOPIC = 'vehicle_gps_stream';

let producer: Producer | null = null;
let telemetryInterval: NodeJS.Timeout | null = null;
let movementInterval: NodeJS.Timeout | null = null;

// Ensure Kafka Producer is ready
async function getProducer() {
    if (producer) return producer;

    const kafka = new Kafka({
        clientId: 'range-shield-simulator',
        brokers: KAFKA_BROKERS,
        ssl: true,
        sasl: {
            mechanism: 'plain',
            username: process.env.CONFLUENT_API_KEY!,
            password: process.env.CONFLUENT_API_SECRET!,
        },
        retry: {
            initialRetryTime: 100,
            retries: 8
        }
    });

    producer = kafka.producer();
    await producer.connect();
    console.log("✅ [Simulator] Kafka Connected");
    return producer;
}

// --- 1. STATIC SNAPSHOT (For /plan) ---
// Sends ONE update to 'vehicle_telemetry'
export async function sendTelemetrySnapshot() {
    const producer = await getProducer();
    console.log("📸 [Simulator] Sending Static Telemetry Snapshot...");

    const staticState = {
        soc: 85.0, // Fixed initial state
        soh: 98.0,
        efficiency: 200,
        tire_pressure: 35.0,
        temp: 22.0,
        total_weight_kg: 350 // As requested
    };

    try {
        await producer.send({
            topic: TELEMETRY_TOPIC_STATIC,
            messages: [{
                value: JSON.stringify({
                    ...staticState,
                    soc: staticState.soc.toFixed(1),
                    currentCharge: staticState.soc.toFixed(1),
                    vehicle_temp: staticState.temp.toFixed(1),
                    tire_pressure: staticState.tire_pressure.toFixed(1)
                })
            }]
        });
    } catch (e) {
        console.error("❌ [Simulator] Snapshot Send Error:", e);
    }
}


// --- 2. DYNAMIC STREAM (For /trip) ---
// Streams to 'vehicle_health_stream'
export async function startTelemetrySimulation() {
    if (telemetryInterval) {
        console.log("⚠️ [Simulator] Telemetry already running");
        return;
    }

    const producer = await getProducer();
    console.log("🚀 [Simulator] Starting Dynamic Telemetry Stream...");

    // Start with some logical initial values
    let vehicleState = {
        soc: 80.5,
        soh: 96.0,
        efficiency: 200, // Static 0.2 kWh/km
        tire_pressure: 36.0,
        temp: 24,
        total_weight_kg: 350 // Static as requested
    };

    telemetryInterval = setInterval(async () => {
        // Mock Physics - Dynamic changes
        vehicleState.soc = Math.max(0, vehicleState.soc - 0.05); // Drain
        // vehicleState.efficiency = 200; // Locked
        vehicleState.tire_pressure = 36 + (Math.sin(Date.now() / 10000) * 0.5); // Oscillate slightly
        vehicleState.temp = 24 + (Math.sin(Date.now() / 20000) * 1.5); // Oscillate temp

        try {
            // 1. Send Health
            await producer.send({
                topic: TELEMETRY_TOPIC_DYNAMIC,
                messages: [{
                    value: JSON.stringify({
                        ...vehicleState,
                        soc: vehicleState.soc.toFixed(2),
                        vehicle_temp: vehicleState.temp.toFixed(1),
                        temp: vehicleState.temp.toFixed(1),
                        currentCharge: vehicleState.soc.toFixed(2),
                        tire_pressure: vehicleState.tire_pressure.toFixed(1),
                        total_weight_kg: vehicleState.total_weight_kg
                    })
                }]
            });

            // 2. Send Idle GPS (only if not navigating/moving)
            if (!movementInterval) {
                await producer.send({
                    topic: MOVEMENT_TOPIC,
                    messages: [{
                        value: JSON.stringify({
                            lat: 12.9716, // Bangalore
                            lng: 77.5946,
                            heading: 0,
                            speed: 0,
                            timestamp: Date.now()
                        })
                    }]
                });
            }

        } catch (e) {
            console.error("❌ [Simulator] Telemetry Send Error:", e);
        }

    }, 2000); // Every 2 seconds
}

// --- 3. MOVEMENT (GPS) SIMULATION ---
export async function startMovementSimulation(encodedPolyline: string) {
    // Clear existing movement if any
    if (movementInterval) {
        clearInterval(movementInterval);
        movementInterval = null;
    }

    const producer = await getProducer();
    console.log("🚗 [Simulator] Starting Movement Stream along new route...");

    // Decode polyline to GeoJSON LineString
    const coordinates = decodePolyline(encodedPolyline);
    if (!coordinates || coordinates.length < 2) {
        console.error("❌ [Simulator] Invalid Polyline");
        return;
    }

    // Turf handles coordinates, but decoding requires a library or helper.
    // Actually, for simplicity, let's inject a simple decoder here since importing 'google.maps' isn't easy in Node.

    const line = turf.lineString(coordinates.map(c => [c.lng, c.lat])); // Turf expects [lng, lat]
    const totalDistKm = turf.length(line, { units: 'kilometers' });

    // speed
    const SPEED_KMH = 120; // Fast simulation 120km/h
    const UPDATE_RATE_MS = 1000;
    const distancePerTick = (SPEED_KMH / 3600) * (UPDATE_RATE_MS / 1000); // km per tick

    let currentDistance = 0;

    movementInterval = setInterval(async () => {
        currentDistance += distancePerTick;

        let shouldStop = false;
        if (currentDistance >= totalDistKm) {
            currentDistance = totalDistKm; // Arrived
            shouldStop = true;
        }

        const point = turf.along(line, currentDistance, { units: 'kilometers' });
        const coords = point.geometry.coordinates; // [lng, lat]

        // Calculate Bearing
        // Look ahead a bit
        const nextDist = Math.min(currentDistance + 0.1, totalDistKm);
        const nextPoint = turf.along(line, nextDist, { units: 'kilometers' });
        const bearing = turf.bearing(point, nextPoint);

        try {
            await producer.send({
                topic: MOVEMENT_TOPIC,
                messages: [{
                    value: JSON.stringify({
                        lat: coords[1],
                        lng: coords[0],
                        heading: bearing,
                        speed: SPEED_KMH,
                        timestamp: Date.now()
                    })
                }]
            });
            // console.log(`[GPS] Moving: ${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}`);
        } catch (e) {
            console.error("❌ [Simulator] GPS Send Error:", e);
        }

        if (shouldStop) {
            clearInterval(movementInterval!);
            movementInterval = null;
            console.log("🏁 [Simulator] Destination Reached");
        }

    }, UPDATE_RATE_MS);
}


// --- HELPER: Polyline Decoder (Google) ---
function decodePolyline(encoded: string) {
    let points = [];
    let index = 0, len = encoded.length;
    let lat = 0, lng = 0;

    while (index < len) {
        let b, shift = 0, result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lat += dlat;

        shift = 0;
        result = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
        lng += dlng;

        points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
}
