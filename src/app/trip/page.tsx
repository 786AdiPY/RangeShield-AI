'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Play, Navigation, Battery, Zap, MapPin, ArrowUp, CornerUpRight, X, Search } from 'lucide-react';
import MicrophoneWithWaves from '@/components/CoPilot/MicrophoneWithWaves';
import VoiceMicrophone from '@/components/CoPilot/VoiceMicrophone';

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
    const [tripData, setTripData] = useState<any>(null);
    const [manualStart, setManualStart] = useState('Bangalore');
    const [manualEnd, setManualEnd] = useState('');
    const [loading, setLoading] = useState(true);
    const [calculating, setCalculating] = useState(false);
    const [navigationActive, setNavigationActive] = useState(false);
    // Stream State
    const [streamData, setStreamData] = useState<{
        soc: number;
        efficiency: number;
        temp: number;
        tirePressure: number;
        heading: number;
        lat: number;
        lng: number;
        totalWeight: number;
    }>({
        soc: 80,
        efficiency: 200,
        temp: 25,
        tirePressure: 35,
        heading: 0,
        lat: 0,
        lng: 0,
        totalWeight: 2150
    });
    const [isStreamConnected, setIsStreamConnected] = useState(false);
    const [tripReady, setTripReady] = useState(false); // New state: Ready to Start (Telemtry connected)

    // AI Suggestion Panel State
    const [activeSuggestion, setActiveSuggestion] = useState<string | null>(null);
    const [suggestionImportant, setSuggestionImportant] = useState(false); // Red text if true
    const [showSuggestionPanel, setShowSuggestionPanel] = useState(false);

    // Voice AI State for Set Course
    const [voiceAiResponse, setVoiceAiResponse] = useState<string | null>(null);
    const [voiceAiImportant, setVoiceAiImportant] = useState(false);

    // Load saved trip or clear it to force new manual entry flow if desired
    useEffect(() => {
        // We might want to start fresh every time for this specific flow check
        setLoading(false);
    }, []);


    // --- STREAM INTEGRATION ---
    useEffect(() => {
        // Auto-connect on mount
        const initStream = async () => {
            // 1. Kickstart the simulation backend
            try {
                await fetch('/api/simulate');
            } catch (e) {
                console.warn("Simulation trigger failed", e);
            }

            // 2. Connect to EventSource
            const eventSource = new EventSource('/api/calculate/stream');

            eventSource.onopen = () => {
                setIsStreamConnected(true);
                // Trip is ready as soon as we have a stream + inputs (user entry)
            };

            eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'gps') {
                        setStreamData(prev => ({
                            ...prev,
                            lat: data.lat,
                            lng: data.lng,
                            heading: data.heading
                        }));
                    } else if (data.type === 'health' || data.soc !== undefined) {
                        setStreamData(prev => ({
                            ...prev,
                            soc: parseFloat(data.soc) || prev.soc,
                            efficiency: data.efficiency || prev.efficiency,
                            temp: data.temp || prev.temp,
                            tirePressure: parseFloat(data.tire_pressure) || prev.tirePressure,
                            totalWeight: data.total_weight_kg || prev.totalWeight
                        }));
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };

            return () => {
                eventSource.close();
            };
        };

        if (!isStreamConnected) {
            initStream();
        }
    }, []); // Run once on mount

    // Auto-hide suggestion panel after 10 seconds
    useEffect(() => {
        if (showSuggestionPanel) {
            const timer = setTimeout(() => {
                setShowSuggestionPanel(false);
            }, 10000); // 10 seconds

            return () => clearTimeout(timer);
        }
    }, [showSuggestionPanel]);

    const handleStartNavigation = async () => {
        if (!manualStart || !manualEnd) {
            alert("Please enter Start and Destination first.");
            return;
        }

        setCalculating(true);

        try {
            // 1. Calculate Route for Visuals (Blue Line) -> We still need the polyline!
            // We use the stream data for calculation inputs now!
            const payload = {
                origin: manualStart,
                destination: manualEnd,
                cargoWeight: "0",
                passengers: "1",
                avgConsumption: (streamData.efficiency / 1000).toString(),
                initialBatteryPct: streamData.soc.toString(),
                batteryCapacity: "60",
                vehicleTemp: streamData.temp,
                soh: 100,
                tirePressure: streamData.tirePressure
            };

            const res = await fetch('/api/calculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) throw new Error("Calculation Failed");
            const data = await res.json();

            const newTripData = {
                start: { lat: 0, lon: 0 }, // Map will infer or use GPS stream
                end: null,
                route: {
                    encodedPolyline: data.polyline,
                    chargingStations: data.charging_stations || []
                },
                result: data
            };

            setTripData(newTripData);

            // 2. Start Movement Simulation
            try {
                await fetch('/api/simulate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ encodedPolyline: data.polyline })
                });
            } catch (simError) {
                console.warn("Failed to start movement simulation", simError);
            }

            // 3. IMMEDIATE TRANSITION TO NAV
            setNavigationActive(true);

            // 4. Set AI suggestion (example - this could come from an API)
            setActiveSuggestion("Route optimized for current traffic. Charging recommended at the next station in 45km.");
            setSuggestionImportant(false); // Set to true for important suggestions
            setShowSuggestionPanel(true);

        } catch (error) {
            console.error(error);
            alert("Route calculation failed. Use valid locations.");
        } finally {
            setCalculating(false);
        }
    };

    const stopNavigation = () => {
        setNavigationActive(false);
        setTripData(null); // Reset to allow new course
        // Stream stays connected
    };

    if (loading) return <div className="min-h-screen bg-black text-emerald-500 flex items-center justify-center">INITIALIZING COCKPIT...</div>;

    return (
        <div className="relative min-h-screen bg-black text-zinc-100 overflow-hidden font-sans">
            {/* Background Map Layer */}
            <div className="absolute inset-0 z-0">
                <GoogleMap
                    encodedPolyline={tripData?.route?.encodedPolyline || ""}
                    // ALWAYS prefer stream position if available (Idle or Moving)
                    startPos={(streamData.lat !== 0 && streamData.lng !== 0) ? { lat: streamData.lat, lon: streamData.lng } : (tripData?.start || undefined)}
                    endPos={tripData?.end || undefined}
                    chargingStations={tripData?.route?.chargingStations || []}
                    // DYNAMIC PROPS
                    tilt={navigationActive ? 45 : 0}
                    heading={navigationActive ? streamData.heading : 0}
                    // Vehicle Navigation Pointer (only when navigation is active)
                    vehiclePosition={navigationActive && streamData.lat !== 0 ? {
                        lat: streamData.lat,
                        lng: streamData.lng,
                        heading: streamData.heading
                    } : undefined}
                />
            </div>

            {/* STAGE 2: NAVIGATION UI */}
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
                    </div>

                    {/* Bottom Panel - Conditional Display */}
                    <div className="absolute bottom-6 left-4 right-4 z-30 pb-safe">
                        {showSuggestionPanel && activeSuggestion ? (
                            // Full Panel with Suggestion
                            <div className="bg-zinc-900/95 backdrop-blur-md rounded-2xl p-4 shadow-2xl border border-zinc-800">
                                <div className="flex items-start justify-between gap-4">
                                    {/* AI Suggestion Text */}
                                    <div className="flex-1">
                                        <div className="text-xs text-emerald-400 font-mono mb-2 flex items-center gap-2">
                                            <span className="relative flex h-2 w-2">
                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                            </span>
                                            VERTEX AI CO-PILOT
                                        </div>
                                        <p className={`text-sm leading-relaxed ${suggestionImportant ? 'text-red-500 font-semibold' : 'text-zinc-300'}`}>
                                            {activeSuggestion}
                                        </p>
                                    </div>

                                    {/* Microphone Component */}
                                    <div className="flex items-center gap-3">
                                        <div className="scale-75 origin-right">
                                            <MicrophoneWithWaves />
                                        </div>
                                        <button
                                            onClick={() => setShowSuggestionPanel(false)}
                                            className="p-3 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500/30 border border-red-500/50 transition-all"
                                        >
                                            <X className="w-5 h-5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            // Mic-Only View
                            <div className="flex justify-center">
                                <div className="bg-zinc-900/95 backdrop-blur-md rounded-2xl p-4 shadow-2xl border border-zinc-800">
                                    <div className="scale-90">
                                        <MicrophoneWithWaves />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* STAGE 1: SETUP & OVERVIEW */}
            {!navigationActive && (
                <>
                    {/* Sidebar */}
                    <div className="absolute top-20 left-4 z-20 w-80">
                        <div className="bg-zinc-900/90 backdrop-blur-md border border-zinc-800 p-6 rounded-xl shadow-2xl">
                            <h2 className="text-lg font-bold text-white mb-4 flex items-center">
                                <Navigation className="w-5 h-5 mr-2 text-emerald-400" />
                                SET COURSE
                            </h2>

                            {/* INPUTS */}
                            <div className="space-y-4 mb-6">
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
                            </div>

                            {/* LIVE TELEMETRY DISPLAY - Show Always or if Connected */}
                            <div className="space-y-3 mb-6 p-3 bg-black/40 rounded-lg border border-emerald-500/30">
                                <div className="text-xs font-mono text-emerald-400 uppercase mb-2 flex items-center gap-2">
                                    <span className={`relative flex h-2 w-2 ${isStreamConnected ? '' : 'hidden'}`}>
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                    </span>
                                    {isStreamConnected ? "Linked to Tesla Model Y" : "Connecting to Stream..."}
                                </div>
                                <div className="grid grid-cols-2 gap-4 opacity-90">
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase">SoC</div>
                                        <div className="text-xl font-bold text-white">{streamData.soc.toFixed(1)}%</div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase">Efficiency</div>
                                        <div className="text-xl font-bold text-white">{(streamData.efficiency / 1000).toFixed(1)} <span className="text-xs font-normal text-zinc-400">kWh/km</span></div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase">Tire Press.</div>
                                        <div className="text-xl font-bold text-white">{streamData.tirePressure.toFixed(1)} <span className="text-xs font-normal text-zinc-400">PSI</span></div>
                                    </div>
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase">Temp</div>
                                        <div className="text-xl font-bold text-white">{streamData.temp}°C</div>
                                    </div>
                                    <div className="col-span-2">
                                        <div className="text-[10px] text-zinc-500 uppercase">Total Weight</div>
                                        <div className="text-xl font-bold text-white">{streamData.totalWeight} <span className="text-xs font-normal text-zinc-400">kg</span></div>
                                    </div>
                                </div>
                            </div>

                            {/* START BUTTON (Enabled when inputs filled) */}
                            {(manualStart && manualEnd) && (
                                <button
                                    onClick={handleStartNavigation}
                                    disabled={calculating || !isStreamConnected}
                                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-lg shadow-lg shadow-emerald-900/50 flex items-center justify-center gap-3 animate-pulse transition-all disabled:opacity-50 disabled:animate-none"
                                >
                                    {calculating ? (
                                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <Navigation className="w-6 h-6 fill-current" />
                                    )}
                                    {calculating ? "CALCULATING..." : "START NAVIGATION"}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* BOTTOM CENTER MIC & AI PANEL (Outside Sidebar) */}
                    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-4 w-full px-4 pointer-events-none">
                        {/* Voice AI Response Panel - Floating above Mic */}
                        {voiceAiResponse && (
                            <div className="bg-black/80 backdrop-blur-md rounded-xl p-4 border border-zinc-700 shadow-2xl max-w-md pointer-events-auto animate-in slide-in-from-bottom-5 fade-in duration-300">
                                <div className="text-xs text-emerald-400 font-mono mb-2 flex items-center gap-2">
                                    <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                                    </span>
                                    VERTEX AI CO-PILOT
                                </div>
                                <p className={`text-sm leading-relaxed ${voiceAiImportant ? 'text-red-500 font-semibold' : 'text-zinc-300'}`}>
                                    {voiceAiResponse}
                                </p>
                                <button
                                    onClick={() => setVoiceAiResponse(null)}
                                    className="mt-3 w-full py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors"
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}

                        {/* Microphone - Pointer Events Auto */}
                        <div className="pointer-events-auto">
                            <VoiceMicrophone
                                onResponse={(response, isImportant) => {
                                    setVoiceAiResponse(response);
                                    setVoiceAiImportant(isImportant);
                                }}
                                context={{
                                    telemetry: {
                                        soc: streamData.soc,
                                        efficiency: streamData.efficiency,
                                        temp: streamData.temp,
                                        tirePressure: streamData.tirePressure
                                    }
                                }}
                            />
                        </div>
                    </div>
                </>
            )}


        </div>
    );
}
