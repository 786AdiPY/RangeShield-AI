require('dotenv').config({ path: '.env' });
const { Kafka } = require('kafkajs');

const kafka = new Kafka({
    clientId: 'hackathon-car',
    brokers: ['pkc-xrnwx.asia-south2.gcp.confluent.cloud:9092'],
    ssl: {
        rejectUnauthorized: false
    }, // Confluent Cloud requires valid SSL
    sasl: {
        mechanism: 'plain',
        username: process.env.CONFLUENT_API_KEY,
        password: process.env.CONFLUENT_API_SECRET,
    },
    // Reliability settings
    connectionTimeout: 10000, // Lower initial timeout to fail fast if network is down, but retry handles wait
    authenticationTimeout: 10000,
    retry: {
        initialRetryTime: 1000,
        retries: 5,
        factor: 0.2, // Linear-ish backoff to retry quickly
        multiplier: 2
    }
});

const producer = kafka.producer();

const run = async () => {
    await producer.connect();
    console.log("✅ Connected to Confluent Cloud");

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

    try {
        await producer.send({
            topic: 'vehicle_telementry',
            messages: [
                { value: JSON.stringify(payload) },
            ],
        });
        console.log("✅ Data sent successfully:", payload);
    } catch (e) {
        console.error("Error sending data", e);
    } finally {
        await producer.disconnect();
        console.log("🔌 Disconnected");
        process.exit(0); // Force exit to prevent hanging handles
    }
};

run().catch(console.error);