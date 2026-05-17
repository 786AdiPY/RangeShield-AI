import { NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

export const dynamic = 'force-dynamic';

// Module-level process handle — persists for the lifetime of the Next.js server
let simProcess: ChildProcess | null = null;

function killExisting() {
    if (simProcess && !simProcess.killed) {
        simProcess.kill('SIGTERM');
        simProcess = null;
    }
}

export async function POST(req: Request) {
    const body = await req.json().catch(() => ({}));
    const {
        origin      = 'Bangalore, India',
        destination = 'Chennai, India',
        soc         = 85,
        speed       = 80,
    } = body;

    killExisting();

    // Warm up /api/vehicle/analyze so Next.js compiles it before the sim needs it.
    // Without this, the first callGemma() hits the route mid-compile and gets HTML.
    try {
        await fetch('http://localhost:3000/api/vehicle/analyze', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ anomalyType: 'warmup', telemetry: {} }),
        });
    } catch { /* ignore — warmup best-effort */ }

    const scriptPath = path.join(process.cwd(), 'scripts', 'simulate.mjs');

    simProcess = spawn('node', [scriptPath], {
        env: {
            ...process.env,
            NEXT_URL:   'http://localhost:3000',
            SIM_ORIGIN: String(origin),
            SIM_DEST:   String(destination),
            SIM_SOC:    String(soc),
            SIM_SPEED:  String(speed),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    simProcess.stdout?.on('data', (d: Buffer) => process.stdout.write(`[sim] ${d}`));
    simProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(`[sim:err] ${d}`));
    simProcess.on('exit', (code: number | null) => {
        console.log(`[sim] process exited — code ${code}`);
        simProcess = null;
    });

    console.log(`[sim] started PID ${simProcess.pid} | ${origin} → ${destination} | SOC ${soc}%`);
    return NextResponse.json({ started: true, pid: simProcess.pid });
}

export async function DELETE() {
    killExisting();
    return NextResponse.json({ stopped: true });
}
