import { NextResponse } from 'next/server';
import { runSimulation } from '@/lib/simulator';

export const dynamic = 'force-dynamic';

export async function GET() {
    console.log("🚀 [API] /api/simulate Triggered (Internal Function)");

    try {
        const result = await runSimulation();
        return NextResponse.json({ success: true, message: "Simulation executed", data: result });
    } catch (error: any) {
        console.error("💥 [API] Simulation failed:", error);
        return NextResponse.json({ success: false, error: error.message || "Simulation failed" }, { status: 500 });
    }
}
