'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Play, Navigation, Battery, Zap, MapPin } from 'lucide-react';
import { useRouter } from 'next/navigation';
import MicrophoneWithWaves from '@/components/CoPilot/MicrophoneWithWaves';

// Dynamic import for Google Map to avoid SSR issues
const GoogleMap = dynamic(() => import('@/components/Map/GoogleMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center bg-zinc-900">
            <div className="animate-spin h-8 w-8 border-4 border-emerald-500 border-t-transparent rounded-full" />
        </div>
    )
});

export default function TripCockpit() {
    const router = useRouter();
    const [tripData, setTripData] = useState<any>(null);
    const [manualStart, setManualStart] = useState('');
    const [manualEnd, setManualEnd] = useState('');
    const [loading, setLoading] = useState(true);


    // Load persisted trip data on mount
    useEffect(() => {
        const savedTrip = localStorage.getItem('rangeShield_activeTrip');
        if (savedTrip) {
            try {
                setTripData(JSON.parse(savedTrip));
            } catch (e) {
                console.error("Failed to parse trip data", e);
            }
        }
        setLoading(false);
    }, []);

    const handleManualPlan = () => {
        // For manual entry, redirect to /plan with query params (simplest integration)
        // OR trigger a calc here. Let's redirect to Plan for now to reuse that robust logic, 
        // as the user said "move directly from /plan... all data goes in". 
        // Navigating BACK to plan for calculation allows them to tweak settings before commiting to "Start Nav".
        if (manualStart && manualEnd) {
            // Encode params is tricky without a proper geocoder implementation here.
            // Let's simpler: Just save to generic local storage or pass as query?
            // Since /plan inputs are state-based, query params are best.
            // Assume /plan can read query params? (It currently doesn't seem to).
            // Let's just alert the user or try to redirect.
            alert("Please use the Mission Planning Planner to calculate complex routes first.");
            router.push('/plan');
        }
    };

    if (loading) return <div className="min-h-screen bg-black text-emerald-500 flex items-center justify-center">INITIALIZING COCKPIT...</div>;

    return (
        <div className="relative min-h-screen bg-black text-zinc-100 overflow-hidden font-sans">
            {/* Background Map Layer */}
            <div className="absolute inset-0 z-0">
                <GoogleMap
                    encodedPolyline={tripData?.route?.encodedPolyline || ""}
                    startPos={tripData?.start || undefined}
                    endPos={tripData?.end || undefined}
                    chargingStations={tripData?.route?.chargingStations || []}
                />
            </div>



            {/* HUD Overlay: Active Trip / Manual Input */}
            <div className="absolute top-20 left-4 z-20 w-80">
                {!tripData ? (
                    // Manual Entry Card
                    <div className="bg-zinc-900/90 backdrop-blur-md border border-zinc-800 p-6 rounded-xl shadow-2xl">
                        <h2 className="text-lg font-bold text-white mb-4 flex items-center">
                            <Navigation className="w-5 h-5 mr-2 text-emerald-400" />
                            SET COURSE
                        </h2>
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-mono text-zinc-500 uppercase">Origin</label>
                                <div className="relative">
                                    <MapPin className="absolute left-3 top-3 w-4 h-4 text-zinc-400" />
                                    <input
                                        type="text"
                                        value={manualStart}
                                        onChange={(e) => setManualStart(e.target.value)}
                                        placeholder="Enter Start Location"
                                        className="w-full bg-black/50 border border-zinc-700 rounded-lg py-2 pl-9 pr-3 text-sm text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-xs font-mono text-zinc-500 uppercase">Target</label>
                                <div className="relative">
                                    <MapPin className="absolute left-3 top-3 w-4 h-4 text-zinc-400" />
                                    <input
                                        type="text"
                                        value={manualEnd}
                                        onChange={(e) => setManualEnd(e.target.value)}
                                        placeholder="Enter Destination"
                                        className="w-full bg-black/50 border border-zinc-700 rounded-lg py-2 pl-9 pr-3 text-sm text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                                    />
                                </div>
                            </div>
                            <button
                                onClick={handleManualPlan}
                                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2"
                            >
                                <Play className="w-4 h-4 fill-current" />
                                CALCULATE TRAJECTORY
                            </button>
                        </div>
                    </div>
                ) : (
                    // Active Trip Stats HUD
                    <div className="space-y-3">
                        <div className="bg-black/80 backdrop-blur border-l-4 border-emerald-500 p-4 rounded-r-lg shadow-lg">
                            <div className="text-xs font-mono text-zinc-400 uppercase mb-1">Target Range</div>
                            <div className="text-3xl font-black text-white tracking-tight">
                                {tripData.result.distance_km} <span className="text-lg font-normal text-zinc-500">km</span>
                            </div>
                        </div>
                        <div className="bg-black/80 backdrop-blur border-l-4 border-blue-500 p-4 rounded-r-lg shadow-lg">
                            <div className="text-xs font-mono text-zinc-400 uppercase mb-1">Est. Arrival SOC</div>
                            <div className={`text-3xl font-black tracking-tight ${tripData.result.range_analysis.arrival_soc_predicted < 15 ? 'text-red-500' : 'text-blue-400'}`}>
                                {tripData.result.range_analysis.arrival_soc_predicted}%
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Co-Pilot Integration (Bottom Layer) */}
            <div className="absolute bottom-6 left-4 right-4 z-20 flex justify-center pointer-events-none">
                <div className="pointer-events-auto flex justify-center">
                    <MicrophoneWithWaves />
                </div>
            </div>


        </div>
    );
}
