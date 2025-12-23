import { Kafka } from 'kafkajs';

// Initialize Kafka Client outside the function to reuse connection if desired, 
// OR keep it inside if we want fresh connections every time to emulate the script.
// Given the requirements of "running the script", fresh connection is safer to reset state,
// but reusing the producer is much more efficient.
// However, the previous script disconnected every time. I will stick to that pattern for now to ensure identical behavior.

export async function runSimulation() {
    console.log("🚗 [Simulator] Starting simulation...");

    const kafka = new Kafka({
        clientId: 'hackathon-car-api',
        brokers: ['pkc-xrnwx.asia-south2.gcp.confluent.cloud:9092'],
        ssl: {
            rejectUnauthorized: false
        },
        sasl: {
            mechanism: 'plain',
            username: process.env.CONFLUENT_API_KEY!,
            password: process.env.CONFLUENT_API_SECRET!,
        },
        connectionTimeout: 10000,
        authenticationTimeout: 10000,
        retry: {
            initialRetryTime: 1000,
            retries: 5,
            factor: 0.2,
            multiplier: 2
        }
    });

    const producer = kafka.producer();

    try {
        await producer.connect();
        console.log("✅ [Simulator] Connected to Confluent Cloud");

        // Generate single payload values
        const temp = 24 + (Math.random() * 2 - 1);
        const charge = Math.max(0, Math.min(100, 88 + Math.floor(Math.random() * 5 - 2)));
        const pressure = 35 + Math.floor(Math.random() * 3 - 1);
        const sohVal = 95 + (Math.random() > 0.8 ? (Math.random() > 0.5 ? -1 : 1) : 0);

        const payload = {
            soc: charge,          // State of Charge (%)
            soh: sohVal,          // State of Health (%)
            vehicle_temp: parseFloat(temp.toFixed(1)), // Vehicle Temperature (C)
            tire_pressure: pressure // Tire Pressure (PSI)
        };

        await producer.send({
            topic: 'vehicle_telementry',
            messages: [
                { value: JSON.stringify(payload) },
            ],
        });
        console.log("✅ [Simulator] Data sent successfully:", payload);

        return { success: true, payload };

    } catch (e) {
        console.error("❌ [Simulator] Error sending data", e);
        throw e;
    } finally {
        await producer.disconnect();
        console.log("🔌 [Simulator] Disconnected");
    }
}
