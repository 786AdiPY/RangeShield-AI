import { getVehicleState, consumePendingAnomalies, startSimulation } from '@/lib/vehicleSimulator';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    startSimulation();

    const stream = new ReadableStream({
        start(controller) {
            const encode = (data: object) =>
                new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);

            const send = () => {
                try {
                    const vehicleState = getVehicleState();
                    const anomalies = consumePendingAnomalies();

                    const packet = {
                        ...vehicleState,
                        // Expose latest queued anomaly for Guardian to catch
                        anomaly_type: anomalies.length > 0 ? anomalies[anomalies.length - 1] : null,
                    };

                    controller.enqueue(encode(packet));
                } catch {
                    clearInterval(interval);
                }
            };

            send();
            const interval = setInterval(send, 500);

            request.signal.addEventListener('abort', () => {
                clearInterval(interval);
                try { controller.close(); } catch { /* already closed */ }
            });
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
