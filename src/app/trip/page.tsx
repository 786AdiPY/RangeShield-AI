'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Play, Navigation, Battery, Zap, MapPin, ArrowUp, CornerUpRight, X, Search } from 'lucide-react';
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
    const [calculating, setCalculating] = useState(false);
    const [navigationActive, setNavigationActive] = useState(false);

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

    const handleManualPlan = async () => {
        if (!manualStart || !manualEnd) return;
        setCalculating(true);

        try {
            // Default params for quick calc
            const payload = {
                origin: manualStart,
                destination: manualEnd,
                cargoWeight: "0",
                passengers: "1",
                avgConsumption: "0.2", // kWh/km defaults
                initialBatteryPct: "80", // Assumed current SOC
                batteryCapacity: "60",
                vehicleTemp: 25,
                soh: 100,
                tirePressure: 35
            };

            const res = await fetch('/api/calculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error("Calculation Failed");
            const data = await res.json();

            // Construct tripData structure matching /plan output
            const newTripData = {
                start: null, // Will be inferred by Map from polyline
                end: null,
                route: {
                    encodedPolyline: data.polyline,
                    chargingStations: data.charging_stations || []
                },
                result: data
            };

            setTripData(newTripData);
            // Optionally save to local storage so it persists on reload
            localStorage.setItem('rangeShield_activeTrip', JSON.stringify(newTripData));

        } catch (error) {
            console.error(error);
            alert("Failed to calculate route. Please try again.");
        } finally {
            setCalculating(false);
        }
    };

    const startNavigation = () => {
        setNavigationActive(true);
    };

    const stopNavigation = () => {
        setNavigationActive(false);
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

            {/* STAGE 2: NAVIGATION UI (Turn-by-Turn) */}
            {navigationActive && (
                <>
                    {/* Top Green Banner */}
                    <div className="absolute top-4 left-4 right-4 z-30 flex flex-col items-center">
                        <div className="w-full bg-[#064e3b] rounded-xl shadow-2xl p-4 flex items-start gap-4">
                            <div className="flex flex-col items-center justify-center pt-1">
                                <ArrowUp className="w-10 h-10 text-white" strokeWidth={3} />
                                <span className="text-white font-bold text-lg mt-1">400m</span>
                            </div>
                            <div className="flex-1">
                                <div className="text-emerald-100 text-sm font-medium mb-1">Towards</div>
                                <div className="text-white text-3xl font-bold leading-tight">1st Main Rd</div>
                            </div>
                        </div>
                        {/* Next Instruction Peek */}
                        <div className="w-11/12 bg-[#062d24] -mt-2 pt-4 pb-2 px-4 rounded-b-lg shadow-lg z-[-1] flex items-center gap-2">
                            <div className="text-emerald-200 text-sm font-medium">Then</div>
                            <CornerUpRight className="w-4 h-4 text-emerald-200" />
                        </div>
                    </div>

                    {/* Bottom Info Panel */}
                    <div className="absolute bottom-6 left-4 right-4 z-30 pb-safe">
                        <div className="bg-zinc-900/95 backdrop-blur-md rounded-2xl p-4 shadow-2xl border border-zinc-800">
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col">
                                    <div className="text-4xl font-bold text-white flex items-baseline gap-2">
                                        24 <span className="text-xl text-zinc-400 font-medium">min</span>
                                    </div>
                                    <div className="text-emerald-400 font-medium flex items-center gap-2">
                                        12.4 km <span className="text-zinc-500">•</span> 17:34 ETA
                                    </div>
                                </div>
                                <div className="flex gap-3">
                                    <button className="p-4 rounded-full bg-zinc-800 text-white hover:bg-zinc-700">
                                        <Search className="w-6 h-6" />
                                    </button>
                                    <button
                                        onClick={stopNavigation}
                                        className="p-4 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500/30 border border-red-500/50"
                                    >
                                        <X className="w-6 h-6" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* STAGE 1: SETUP & OVERVIEW */}
            {!navigationActive && (
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
                                    disabled={calculating}
                                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                >
                                    {calculating ? (
                                        <Play className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <Play className="w-4 h-4 fill-current" />
                                    )}
                                    {calculating ? 'CALCULATING...' : 'CALCULATE ROUTE'}
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

                            {/* START NAVIGATION ACTION */}
                            <button
                                onClick={startNavigation}
                                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-lg shadow-lg shadow-emerald-900/50 flex items-center justify-center gap-3 animate-pulse"
                            >
                                <Navigation className="w-6 h-6 fill-current" />
                                START NAVIGATION
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Co-Pilot Integration (Bottom Layer) - Hide in Nav Mode? Or keep it? keeping it but adjusting z-index */}
            <div className={`absolute bottom-6 left-4 right-4 z-20 flex justify-center pointer-events-none transition-opacity ${navigationActive ? 'opacity-0' : 'opacity-100'}`}>
                <div className="pointer-events-auto flex justify-center">
                    <MicrophoneWithWaves />
                </div>
            </div>


        </div>
    );
}
