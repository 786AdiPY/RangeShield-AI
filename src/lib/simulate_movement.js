require('dotenv').config();
const { Kafka } = require('kafkajs');
const turf = require('@turf/turf');

// --- CONFIGURATION ---
const TOPIC_NAME = 'vehicle_gps_stream';
const SPEED_KMH = 80; // Speed of the car
const UPDATE_INTERVAL_MS = 1000; // How often to send updates (1 sec)

// --- KAFKA SETUP ---
const kafka = new Kafka({
    clientId: 'vehicle-simulator-1',
    brokers: ['pkc-xrnwx.asia-south2.gcp.confluent.cloud:9092'],
    ssl: true,
    sasl: {
        mechanism: 'plain',
        username: process.env.CONFLUENT_API_KEY,
        password: process.env.CONFLUENT_API_SECRET,
    },
    connectionTimeout: 10000,
    retry: {
        initialRetryTime: 100,
        retries: 8
    }
});

const producer = kafka.producer();

// --- MOCK ROUTE (Bangalore to Mysore) ---
const routeCoords = [
    [77.5946, 12.9716],   // Bangalore
    [77.4500, 12.8500],
    [77.3000, 12.7000],
    [77.1500, 12.5500],
    [76.9000, 12.4000],
    [76.6500, 12.3098],   // Mysore
];

const routeLine = turf.lineString(routeCoords);
const routeLength = turf.length(routeLine, { units: 'kilometers' });

// --- STATE ---
let distanceTraveled = 0;
const stepDistance = (SPEED_KMH / 3600) * (UPDATE_INTERVAL_MS / 1000);

// --- MAIN FUNCTION ---
const runSimulation = async () => {
    await producer.connect();
    console.log('✅ Connected to Confluent Cloud. Starting Simulation...');
    console.log(`🚗 Route Length: ${routeLength.toFixed(2)} km`);

    setInterval(async () => {
        if (distanceTraveled >= routeLength) {
            distanceTraveled = 0;
            console.log('🔄 Route completed. Restarting...');
        }

        const currentPoint = turf.along(routeLine, distanceTraveled, { units: 'kilometers' });
        const coords = currentPoint.geometry.coordinates; // [lng, lat]

        // Calculate heading by looking ahead
        const nextDist = Math.min(distanceTraveled + 0.1, routeLength);
        const nextPoint = turf.along(routeLine, nextDist, { units: 'kilometers' });
        const heading = turf.bearing(currentPoint, nextPoint);

        // Payload format matching frontend expectations
        const payload = {
            lat: coords[1],
            lng: coords[0],
            heading: heading,
            speed: SPEED_KMH,
            battery_level: Math.max(10, 100 - (distanceTraveled * 0.5)),
            timestamp: Date.now()
        };

        try {
            await producer.send({
                topic: TOPIC_NAME,
                messages: [{ value: JSON.stringify(payload) }],
            });
            console.log(`📍 [${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}] Heading: ${heading.toFixed(0)}° | Battery: ${payload.battery_level.toFixed(1)}%`);
        } catch (err) {
            console.error('❌ Kafka Error:', err.message);
        }

        distanceTraveled += stepDistance;

    }, UPDATE_INTERVAL_MS);
};

runSimulation().catch(console.error);
