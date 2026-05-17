import { NextResponse } from 'next/server';
import { getVehicleState, resetVehicleState, setRoute, startSimulation } from '@/lib/vehicleSimulator';

export const dynamic = 'force-dynamic';

export async function GET() {
    startSimulation();
    return NextResponse.json(getVehicleState());
}

export async function POST(req: Request) {
    const body = await req.json().catch(() => ({}));

    resetVehicleState();
    startSimulation();

    if (body.encodedPolyline) {
        setRoute(body.encodedPolyline);
    }

    return NextResponse.json({ success: true, state: getVehicleState() });
}
