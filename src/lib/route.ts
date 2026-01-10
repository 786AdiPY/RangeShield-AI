// src/app/api/stream/route.ts
import { Kafka } from 'kafkajs';

export const dynamic = 'force-dynamic'; // Prevents Next.js from caching this route

export async function GET(request: Request) {
    const stream = new ReadableStream({
        async start(controller) {
            // 1. Initialize Kafka Client
            const kafka = new Kafka({
                clientId: 'frontend-bridge',
                brokers: ['pkc-xrnwx.asia-south2.gcp.confluent.cloud:9092'],
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

            const consumer = kafka.consumer({ groupId: `frontend-group-${Date.now()}` }); // Unique ID prevents conflicts

            try {
                await consumer.connect();
                await consumer.subscribe({ topics: ['vehicle_gps_stream', 'vehicle_health_stream', 'vehicle_telementry'], fromBeginning: false });

                // 2. Run the Consumer
                await consumer.run({
                    eachMessage: async ({ topic, message }) => {
                        if (message.value) {
                            const rawData = message.value.toString();
                            let payload = {};
                            try {
                                payload = JSON.parse(rawData);
                            } catch (e) {
                                payload = { raw: rawData };
                            }

                            // Tag data with source type
                            const taggedData = {
                                type: topic === 'vehicle_gps_stream' ? 'gps' : 'health',
                                ...payload
                            };

                            // 3. Push data to the Browser (SSE Format)
                            // Format: "data: {JSON}\n\n"
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(taggedData)}\n\n`));
                        }
                    },
                });

                // 4. Handle Client Disconnect (Cleanup)
                request.signal.addEventListener('abort', async () => {
                    console.log('User closed tab. Disconnecting Kafka...');
                    try {
                        await consumer.disconnect();
                    } catch (e) {
                        console.error("Error disconnecting Kafka:", e);
                    }
                    try {
                        controller.close();
                    } catch (e) {
                        // Ignore if already closed
                    }
                });

            } catch (err) {
                console.error("Stream Error:", err);
                controller.close();
            }
        },
    });

    // 5. Return the Stream Headers
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}