import { NextResponse } from 'next/server';
import { startTelemetrySimulation, startMovementSimulation } from '@/lib/kafkaSimulator';
import { runSimulation } from '@/lib/simulator';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode');

    // /plan uses snapshot mode -> sends to vehicle_telemetry once
    if (mode === 'snapshot') {
        try {
            const result = await runSimulation();
            return NextResponse.json({ success: true, data: result });
        } catch (error: any) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 });
        }
    }

    // /trip uses dynamic mode -> continuous stream to vehicle_health_stream
    try {
        startTelemetrySimulation();
        return NextResponse.json({ success: true, message: "Dynamic stream started" });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    console.log("🚀 [API] Starting Movement Simulation...");
    try {
        const body = await req.json();
        const { encodedPolyline } = body;

        if (!encodedPolyline) {
            return NextResponse.json({ success: false, error: "Missing encodedPolyline" }, { status: 400 });
        }

        startMovementSimulation(encodedPolyline); // Fire and forget
        return NextResponse.json({ success: true, message: "Movement Simulation Started along route" });

    } catch (error: any) {
        console.error("💥 [API] Movement Start Failed:", error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
