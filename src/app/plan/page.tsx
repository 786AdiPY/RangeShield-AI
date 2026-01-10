"use client";

import React, { useState } from 'react';
import { MapPin, Users, Box, Play, Calculator, ArrowRight, Activity, Wifi } from 'lucide-react';
import dynamic from 'next/dynamic';

import { searchCity, GeocodeResult } from '@/lib/geocoding';
import { fetchWeather, WeatherData } from '@/lib/weather';
import CoPilotCard from '@/components/CoPilot/CoPilotCard';
import ChatInterface from '@/components/CoPilot/ChatInterface';

// Dynamic import for Google Map to avoid SSR issues
const GoogleMap = dynamic(() => import('@/components/Map/GoogleMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
            <div className="flex flex-col items-center gap-2">
                <MapPin className="w-8 h-8 animate-pulse" />
                <span className="text-sm font-mono">LOADING MAP...</span>
            </div>
        </div>
    )
});

export default function PlanPage() {
    const [passengers, setPassengers] = useState(1);
    const [avgWeight, setAvgWeight] = useState(75);
    const [cargo, setCargo] = useState(0);
    const [battery, setBattery] = useState(85);
    const [batteryCapacity, setBatteryCapacity] = useState(100);
    const [energyConsumption, setEnergyConsumption] = useState(0.2);
    const [rangeCalculated, setRangeCalculated] = useState(false);

    // Geocoding State
    const [startLocation, setStartLocation] = useState<GeocodeResult | null>(null);
    const [destinationLocation, setDestinationLocation] = useState<GeocodeResult | null>(null);
    const [isSearchingStart, setIsSearchingStart] = useState(false);
    const [isSearchingDest, setIsSearchingDest] = useState(false);

    // Weather State (Still used for initial display if needed, but API returns precise weather)
    // We can merge them or update weather state from API response
    const [weather, setWeather] = useState<WeatherData | null>(null);
    const [loadingWeather, setLoadingWeather] = useState(false);
    const [calculationResult, setCalculationResult] = useState<any>(null); // Store API response
    const [error, setError] = useState<string | null>(null);

    // Stream State
    const [vehicleTemp, setVehicleTemp] = useState<number | null>(null);
    const [tirePressure, setTirePressure] = useState<number>(35); // Default 35 PSI
    const [soh, setSoh] = useState<number | null>(null);
    const [isStreamConnected, setIsStreamConnected] = useState(false);

    // Co-Pilot State
    const [coPilotSuggestion, setCoPilotSuggestion] = useState<string | null>(null);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [coPilotContext, setCoPilotContext] = useState<any>(null);

    // Telemetry Integration (Static Snapshot)
    React.useEffect(() => {
        const fetchTelemetrySnapshot = async () => {
            try {
                // Fetch static snapshot strictly for planning
                console.log("📸 Fetching static telemetry snapshot...");
                const res = await fetch('/api/simulate?mode=snapshot');
                const json = await res.json();

                if (json.success && json.data && json.data.payload) {
                    const data = json.data.payload;
                    console.log("✅ Static Snapshot loaded:", data);

                    // Update state with static values
                    if (data.vehicle_temp !== undefined) setVehicleTemp(Number(data.vehicle_temp));
                    if (data.soc !== undefined) setBattery(Number(data.soc));
                    if (data.tire_pressure !== undefined) setTirePressure(Number(data.tire_pressure));
                    if (data.soh !== undefined) setSoh(Number(data.soh));

                    setIsStreamConnected(true); // Connected to "Static Data Source"
                }
            } catch (error) {
                console.error("Failed to fetch telemetry snapshot:", error);
            }
        };

        fetchTelemetrySnapshot();
    }, []);

    const handleCitySearch = async (query: string, type: 'start' | 'destination') => {
        if (type === 'start') setIsSearchingStart(true);
        else setIsSearchingDest(true);

        const result = await searchCity(query);

        if (type === 'start') {
            setStartLocation(result);
            setIsSearchingStart(false);
        } else {
            setDestinationLocation(result);
            setIsSearchingDest(false);
        }
    };

    const handleCalculate = async () => {
        setLoadingWeather(true);
        setRangeCalculated(false);

        const startAddr = startLocation?.display_name || "San Francisco, CA";
        const destAddr = destinationLocation?.display_name || "Los Angeles, CA"; // Warning: Fallback if empty, better to require input

        // Prepare Payload
        // Note: energyConsumption in page is kWh/km (0.2). API expects kWh/100km if > 2, or handles it. 
        // Prompt said "avgConsumption (Number): The car's baseline energy usage in kWh/100km."
        // We will send it as per page state (kWh/km) and let API handle conversion if it detects < 2, 
        // OR we just multiply by 100 here to be safe and rigorous.
        // Let's multiply by 100 to send kWh/100km as requested by API prompt spec.
        const consumptionKwh100km = energyConsumption * 100;

        try {
            const res = await fetch('/api/calculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    origin: startAddr,
                    destination: destAddr,
                    cargoWeight: cargo,
                    passengers: passengers,
                    avgConsumption: consumptionKwh100km,
                    initialBatteryPct: battery,
                    batteryCapacity: batteryCapacity,
                    tirePressure: tirePressure, // Pass tire pressure if API supports it
                    vehicleTemp: vehicleTemp // Pass vehicle temp if API supports it
                })
            });

            if (!res.ok) throw new Error("Calculation failed");

            const data = await res.json();
            setCalculationResult(data);

            // Update weather state from API result for the UI card
            if (data.weather) {
                setWeather({
                    temperature: data.weather.temp,
                    windSpeed: data.weather.wind,
                    weatherCode: 0 // Default or omit
                });
            }

            setRangeCalculated(true);

            // --- Trigger Co-Pilot Suggestion ---
            try {
                const contextData = {
                    telemetry: {
                        range_km: data.range_analysis.remaining_range,
                        arrival_soc: data.range_analysis.arrival_soc_predicted,
                        efficiency: energyConsumption // Use the direct state variable
                    },
                    trip: {
                        distance_km: data.distanceKm,
                        duration_mins: data.durationMins
                    },
                    user: {
                        passengers: passengers, // Use the direct state variable
                        payload: cargo // Use the direct state variable
                    },
                    chargers: data.chargingStations ? data.chargingStations.slice(0, 5) : [] // Send first 5 relevant chargers
                };

                setCoPilotContext(contextData);

                // Initial Message to get suggestion
                // We send a "system" style trigger or just an empty user message with context to prompt the greeting/suggestion
                const coPilotRes = await fetch('/api/copilot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: "Analyze my route and provide a strategy." }], // Trigger prompt
                        context: contextData
                    })
                });

                const coPilotJson = await coPilotRes.json();
                if (coPilotJson.reply) {
                    setCoPilotSuggestion(coPilotJson.reply);
                }
            } catch (aiError: any) {
                console.error("Co-Pilot failed to initialize:", aiError);
                // Optionally set an error for Co-Pilot specifically
            }

        } catch (err: any) {
            console.error(err);
            setError(err.message || 'Calculation failed');
        } finally {
            setLoadingWeather(false);
        }
    };

    return (
        <div className="flex h-screen w-full bg-zinc-950 text-white overflow-hidden pt-[80px]">
            <aside className="w-[35%] h-full p-6 flex flex-col justify-between border-r border-zinc-900 bg-zinc-950/95 backdrop-blur-sm z-20 overflow-y-auto custom-scrollbar">
                <div className="space-y-8">
                    <div className="space-y-1">
                        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400">
                            Trip Configuration
                        </h1>
                        <p className="text-xs text-zinc-500 font-mono tracking-wider">
                            INITIALIZE CONFLUENT STREAMING PIPELINE & VERTEX AI ANALYSIS
                        </p>
                    </div>

                    {/* Custom Card Implementation */}
                    <div className="border border-zinc-800 bg-zinc-900/30 rounded-lg overflow-hidden">
                        <div className="p-6 pb-2">
                            <h3 className="text-xl font-semibold text-zinc-100 flex items-center gap-2">
                                <MapPin className="w-5 h-5 text-blue-500" />
                                Route Parameters
                            </h3>
                        </div>
                        <div className="p-6 pt-0 space-y-6">
                            {/* Start Point */}
                            <div className="space-y-2">
                                <label htmlFor="start" className="text-sm font-medium text-zinc-300">Starting Point</label>
                                <div className="relative">
                                    <input
                                        id="start"
                                        defaultValue="Current Location (San Francisco)"
                                        onBlur={(e) => handleCitySearch(e.target.value, 'start')}
                                        onKeyDown={(e) => e.key === 'Enter' && handleCitySearch(e.currentTarget.value, 'start')}
                                        className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-10 transition-all"
                                    />
                                    {isSearchingStart ? (
                                        <div className="absolute right-3 top-2.5 h-4 w-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        <MapPin className={`absolute right-3 top-2.5 h-4 w-4 ${startLocation ? 'text-emerald-500' : 'text-zinc-600'}`} />
                                    )}
                                </div>
                            </div>

                            {/* Target Destination */}
                            <div className="space-y-2">
                                <label htmlFor="destination" className="text-sm font-medium text-zinc-300">Target Destination</label>
                                <div className="relative">
                                    <input
                                        id="destination"
                                        placeholder="Enter coordinates or address"
                                        onBlur={(e) => handleCitySearch(e.target.value, 'destination')}
                                        onKeyDown={(e) => e.key === 'Enter' && handleCitySearch(e.currentTarget.value, 'destination')}
                                        className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-10 transition-all"
                                    />
                                    {isSearchingDest ? (
                                        <div className="absolute right-3 top-2.5 h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                    ) : (
                                        <MapPin className={`absolute right-3 top-2.5 h-4 w-4 ${destinationLocation ? 'text-blue-500' : 'text-zinc-600'}`} />
                                    )}
                                </div>
                            </div>

                            {/* Passengers & Weight */}
                            <div className="space-y-4">
                                <div className="flex justify-between items-end">
                                    <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                        <Users className="w-4 h-4" /> Passengers
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1">
                                            <span className="text-xs text-zinc-500">Avg Kg</span>
                                            <input
                                                type="number"
                                                value={avgWeight}
                                                onChange={(e) => setAvgWeight(parseInt(e.target.value))}
                                                className="w-8 bg-transparent text-right text-xs text-zinc-300 outline-none"
                                            />
                                        </div>
                                        <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors text-blue-400 border-blue-900 bg-blue-950/20">
                                            {passengers} Pax
                                        </span>
                                    </div>
                                </div>
                                <input
                                    type="number"
                                    min="1"
                                    max="7"
                                    value={passengers}
                                    onChange={(e) => setPassengers(parseInt(e.target.value))}
                                    className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                />
                            </div>

                            {/* Cargo Weight */}
                            <div className="space-y-4">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                        <Box className="w-4 h-4" /> Cargo Weight
                                    </label>
                                    <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-emerald-400 border-emerald-900 bg-emerald-950/20">
                                        {cargo} kg
                                    </span>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    max="500"
                                    value={cargo}
                                    onChange={(e) => setCargo(parseInt(e.target.value))}
                                    className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                                />
                            </div>

                            {/* Efficiency (Moved out of EV Specs) */}
                            <div className="space-y-2 pt-4 border-t border-zinc-800/50">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                        <Wifi className="w-4 h-4 text-purple-500" /> Efficiency
                                    </label>
                                    <span className="text-xs font-mono font-bold text-purple-400">
                                        {energyConsumption} kWh/km
                                    </span>
                                </div>
                                <input
                                    type="number"
                                    min="0.1"
                                    max="1.0"
                                    step="0.01"
                                    value={energyConsumption}
                                    onChange={(e) => setEnergyConsumption(parseFloat(e.target.value))}
                                    className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                                />
                            </div>

                            {/* EV Configuration */}
                            <div className="space-y-4 pt-4 border-t border-zinc-800/50">
                                <h4 className="text-xs font-mono text-zinc-500 uppercase tracking-wider">EV Specs</h4>

                                {/* Battery Capacity */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                            <Activity className="w-4 h-4 text-blue-500" /> Battery Capacity
                                        </label>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-mono font-bold text-blue-400">
                                                {batteryCapacity} kWh
                                            </span>
                                        </div>
                                    </div>
                                    <input
                                        type="number"
                                        min="10"
                                        max="300"
                                        value={batteryCapacity}
                                        onChange={(e) => setBatteryCapacity(parseInt(e.target.value))}
                                        className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                                    />
                                </div>

                                {/* SoH (State of Health) - NOW PROMINENT */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                            <Activity className="w-4 h-4 text-pink-500" /> State of Health
                                        </label>
                                        {soh !== null ? (
                                            <span className="text-xs font-mono font-bold text-pink-400 animate-pulse">
                                                {soh}%
                                            </span>
                                        ) : (
                                            <span className="text-xs font-mono text-zinc-600">
                                                -- (Waiting for Stream)
                                            </span>
                                        )}
                                    </div>
                                    <input
                                        type="number"
                                        readOnly
                                        value={soh || ''}
                                        className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-400 cursor-not-allowed focus:outline-none"
                                        placeholder="Waiting for telemetry..."
                                    />
                                </div>

                                {/* Vehicle Temp (Streamed) */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                            <Activity className="w-4 h-4 text-orange-500" /> Vehicle Temp
                                        </label>
                                        {vehicleTemp !== null ? (
                                            <span className="text-xs font-mono font-bold text-orange-400 animate-pulse">
                                                {vehicleTemp}°C
                                            </span>
                                        ) : (
                                            <span className="text-xs font-mono text-zinc-600">
                                                -- (Waiting for Stream)
                                            </span>
                                        )}
                                    </div>
                                    {/* Read-only display bar or visual element */}
                                    <div className="w-full bg-zinc-800 h-1 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-orange-500 transition-all duration-500"
                                            style={{ width: `${Math.min(Math.max(((vehicleTemp || 0) + 20) / 80 * 100, 0), 100)}%` }} // Arbitrary scale -20 to 60C
                                        />
                                    </div>
                                </div>

                                {/* Tire Pressure */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                            <Activity className="w-4 h-4 text-yellow-500" /> Tire Pressure
                                        </label>
                                        <span className="text-xs font-mono font-bold text-yellow-400">
                                            {tirePressure} PSI
                                        </span>
                                    </div>
                                    <input
                                        type="number"
                                        min="20"
                                        max="50"
                                        value={Number.isNaN(tirePressure) ? '' : tirePressure}
                                        onChange={(e) => setTirePressure(parseInt(e.target.value) || 0)}
                                        className="flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-transparent transition-all"
                                    />
                                </div>
                            </div>

                            {/* Initial Battery % */}
                            <div className="space-y-2 pt-2 border-t border-zinc-800/50">
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                                        <Activity className="w-4 h-4 text-emerald-500" /> State of Charge
                                    </label>
                                    <span className={`text-xs font-mono font-bold ${battery < 20 ? 'text-red-500' : 'text-emerald-400'}`}>
                                        {battery}%
                                    </span>
                                </div>
                                <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={battery}
                                    onChange={(e) => setBattery(parseInt(e.target.value))}
                                    className={`flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${battery < 20 ? 'focus:ring-red-500' : 'focus:ring-emerald-500'}`}
                                />
                            </div>

                            <p className="text-[10px] text-zinc-500 flex items-center gap-1 pt-2">
                                <ArrowRight className="w-3 h-3 text-amber-500" />
                                Heavy loads increase kinetic energy drain.
                            </p>
                        </div>
                    </div>

                    <button
                        className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border bg-background w-full border-blue-500/50 text-blue-400 hover:bg-blue-950/30 hover:text-blue-300 font-mono uppercase tracking-widest h-12"
                        onClick={handleCalculate}
                        disabled={loadingWeather}
                    >
                        {loadingWeather ? (
                            <div className="animate-spin h-4 w-4 border-2 border-blue-400 border-t-transparent rounded-full mr-2" />
                        ) : (
                            <Calculator className="w-4 h-4 mr-2" />
                        )}
                        {loadingWeather ? 'ANALYZING ATMOSPHERE...' : 'Calculate Range'}
                    </button>
                </div>

                <div className="space-y-4 mt-auto">
                    <button
                        disabled={!rangeCalculated}
                        onClick={() => {
                            if (calculationResult) {
                                const tripPayload = {
                                    result: calculationResult,
                                    route: {
                                        encodedPolyline: calculationResult.polyline,
                                        chargingStations: calculationResult.charging_stations
                                    },
                                    start: startLocation ? { lat: parseFloat(startLocation.lat), lon: parseFloat(startLocation.lon) } : undefined,
                                    end: destinationLocation ? { lat: parseFloat(destinationLocation.lat), lon: parseFloat(destinationLocation.lon) } : undefined,
                                    passengers: passengers, // Persist context
                                    cargo: cargo
                                };
                                localStorage.setItem('rangeShield_activeTrip', JSON.stringify(tripPayload));
                                window.location.href = '/trip'; // Force full nav to ensure clean state
                            }
                        }}
                        className={`inline-flex items-center justify-center rounded-md text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 w-full h-14 font-bold tracking-widest transition-all ${rangeCalculated
                            ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] cursor-pointer'
                            : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                            }`}
                    >
                        <Play className="w-5 h-5 mr-2 fill-current" />
                        START NAVIGATION
                    </button>

                    {/* Co-Pilot Suggestion Card */}
                    {coPilotSuggestion && (
                        <CoPilotCard
                            suggestion={coPilotSuggestion}
                            onClick={() => setIsChatOpen(true)}
                        />
                    )}


                </div>

                {weather && (
                    <div className="mt-4 border border-zinc-800 bg-zinc-900/50 rounded-md p-3">
                        <h4 className="text-xs font-mono text-zinc-500 mb-2 uppercase">Environmental Conditions</h4>
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                                <span className="text-[10px] text-zinc-400">Temperature</span>
                                <span className="text-sm font-bold text-zinc-200">{weather.temperature}°C</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-zinc-400">Wind Speed</span>
                                <span className="text-sm font-bold text-zinc-200">{weather.windSpeed} km/h</span>
                            </div>
                        </div>
                    </div>
                )}

                {calculationResult && (
                    <div className="mt-4 border border-zinc-800 bg-zinc-900/50 rounded-md p-3 space-y-3">
                        <h4 className="text-xs font-mono text-zinc-500 uppercase">Analysis</h4>

                        <div className="flex justify-between items-center">
                            <span className="text-xs text-zinc-400">Predicted Usage</span>
                            <span className="text-sm font-mono font-bold text-blue-400">
                                {calculationResult.predicted_kwh} kWh
                            </span>
                        </div>

                        <div className="flex justify-between items-center">
                            <span className="text-xs text-zinc-400">Arrival Charge</span>
                            <span className={`text-sm font-mono font-bold ${calculationResult.range_analysis.status === 'CRITICAL' ? 'text-red-500' : 'text-emerald-400'}`}>
                                {calculationResult.range_analysis.arrival_soc_predicted}% ({calculationResult.range_analysis.status})
                            </span>
                        </div>

                        <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                            <div
                                className={`h-full ${calculationResult.range_analysis.status === 'CRITICAL' ? 'bg-red-500' : 'bg-emerald-500'}`}
                                style={{ width: `${calculationResult.range_analysis.arrival_soc_predicted}%` }}
                            />
                        </div>
                    </div>
                )}

                <div className="flex items-center justify-between py-2 border-t border-zinc-900/50">
                    <span className={`inline-flex items-center rounded-full border text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-emerald-900/50 ${isStreamConnected ? 'text-emerald-500 bg-emerald-950/10' : 'text-zinc-500 bg-zinc-900'} gap-2 px-3 py-1`}>
                        <span className="relative flex h-2 w-2">
                            {isStreamConnected && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            )}
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${isStreamConnected ? 'bg-emerald-500' : 'bg-zinc-600'}`}></span>
                        </span>
                        Confluent Stream: {isStreamConnected ? 'ONLINE' : 'CONNECTING...'}
                    </span>
                    <span className="inline-flex items-center rounded-full border text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-blue-900/50 text-blue-500 bg-blue-950/10 gap-2 px-3 py-1">
                        <Activity className="w-3 h-3 mr-1" />
                        Vertex AI: CONNECTED
                    </span>
                </div>
            </aside>

            {/* Right Panel - Google Map Visualization */}
            <main className="flex-1 relative bg-zinc-950 p-4 pl-0">
                <div className="w-full h-full rounded-xl overflow-hidden border border-zinc-800 relative shadow-2xl">
                    <GoogleMap
                        encodedPolyline={calculationResult?.polyline}
                        startPos={startLocation ? { lat: parseFloat(startLocation.lat), lon: parseFloat(startLocation.lon) } : undefined}
                        endPos={destinationLocation ? { lat: parseFloat(destinationLocation.lat), lon: parseFloat(destinationLocation.lon) } : undefined}
                        chargingStations={calculationResult?.charging_stations}
                    />
                    <div className="absolute top-4 right-4 w-64 bg-zinc-950/90 border border-zinc-800 backdrop-blur-md shadow-xl z-[1000] rounded-lg">
                        <div className="flex flex-col space-y-1.5 p-4 pb-2">
                            <h3 className="text-sm font-mono text-zinc-400 uppercase leading-none tracking-tight">Live Telemetry</h3>
                        </div>
                        <div className="p-4 pt-0 space-y-2">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-zinc-500">Distance</span>
                                <span className="text-zinc-200 font-mono">
                                    {calculationResult ? `${calculationResult.distance_km} km` : '--'}
                                </span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-zinc-500">Duration</span>
                                <span className="text-zinc-200 font-mono">
                                    {calculationResult ? `${calculationResult.duration_mins} min` : '--'}
                                </span>
                            </div>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-zinc-500">Elevation Gain</span>
                                <span className="text-zinc-200 font-mono text-emerald-400">
                                    {calculationResult ? `+${calculationResult.total_ascent_m} m` : '--'}
                                </span>
                            </div>

                            {/* NEW: Live Stream Data in Map Panel too */}
                            <div className="flex justify-between items-center text-sm pt-2 border-t border-zinc-800/50 mt-2">
                                <span className="text-zinc-500">Live Temp</span>
                                <span className="text-zinc-200 font-mono">
                                    {vehicleTemp ? `${vehicleTemp}°C` : '--'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
            {/* Concierge Chat Interface */}
            <ChatInterface
                isOpen={isChatOpen}
                onClose={() => setIsChatOpen(false)}
                initialContext={coPilotContext}
                initialSuggestion={coPilotSuggestion || undefined}
            />
        </div>
    );
}
