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
            });

            const consumer = kafka.consumer({ groupId: `frontend-group-${Date.now()}` }); // Unique ID prevents conflicts

            try {
                await consumer.connect();
                await consumer.subscribe({ topic: 'vehicle_telementry', fromBeginning: false });

                // 2. Run the Consumer
                await consumer.run({
                    eachMessage: async ({ message }) => {
                        if (message.value) {
                            const data = message.value.toString();
                            // 3. Push data to the Browser (SSE Format)
                            // Format: "data: {JSON}\n\n"
                            controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
                        }
                    },
                });

                // 4. Handle Client Disconnect (Cleanup)
                request.signal.addEventListener('abort', async () => {
                    console.log('User closed tab. Disconnecting Kafka...');
                    await consumer.disconnect();
                    controller.close();
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