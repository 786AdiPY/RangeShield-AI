require('dotenv').config({ path: '.env' });
const { Kafka } = require('kafkajs');

const kafka = new Kafka({
    clientId: 'hackathon-car',
    brokers: ['pkc-xrnwx.asia-south2.gcp.confluent.cloud:9092'], // ⚠️ REPLACE THIS
    ssl: true,
    sasl: {
        mechanism: 'plain',
        username: process.env.CONFLUENT_API_KEY,
        password: process.env.CONFLUENT_API_SECRET,
    },
});

const producer = kafka.producer();

const run = async () => {
    await producer.connect();

    const payload = {
        currentCharge: 88,
        soh: 95,
        temp: 24
    };

    await producer.send({
        topic: 'vehicle_telementry',
        messages: [
            { value: JSON.stringify(payload) },
        ],
    });

    console.log("✅ Data sent to Cloud:", payload);
    await producer.disconnect();
};

run().catch(console.error);