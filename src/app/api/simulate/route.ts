import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const scriptPath = path.resolve(process.cwd(), 'simulate_car.js');

        // Execute the script
        // We don't await the full execution because we just want to trigger it. 
        // However, since it runs once and exits quickly, we can await it to capture any immediate errors.
        await new Promise((resolve, reject) => {
            exec(`node "${scriptPath}"`, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Execution error: ${error}`);
                    // We settle even on error to avoid hanging the request, but log it.
                    // If we reject here, the API returns 500.
                }
                if (stdout) console.log(`Simulator output: ${stdout}`);
                if (stderr) console.error(`Simulator stderr: ${stderr}`);
                resolve(true);
            });
        });

        return NextResponse.json({ success: true, message: "Simulator triggered" });

    } catch (error) {
        console.error("Failed to trigger simulator:", error);
        return NextResponse.json({ success: false, error: "Failed to run simulator" }, { status: 500 });
    }
}
