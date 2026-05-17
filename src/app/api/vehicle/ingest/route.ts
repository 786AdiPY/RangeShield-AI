import { NextResponse } from 'next/server';
import { setStateFromExternal } from '@/lib/vehicleSimulator';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const body = await req.json().catch(() => ({}));
    setStateFromExternal(body);
    return NextResponse.json({ ok: true });
}
