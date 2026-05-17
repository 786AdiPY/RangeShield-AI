'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Play, Navigation, MapPin, X, Search, Battery, Gauge, Thermometer, Weight, Zap, Activity, AlertTriangle, ShieldCheck, ChevronRight } from 'lucide-react';
import VoiceMicrophone from '@/components/CoPilot/VoiceMicrophone';
import { searchCity } from '@/lib/geocoding';

const BATTERY_KWH = 60;

const GoogleMap = dynamic(() => import('@/components/Map/GoogleMap'), {
    ssr: false,
    loading: () => (
        <div className="w-full h-full flex items-center justify-center bg-zinc-900">
            <div className="animate-spin h-8 w-8 border-4 border-emerald-500 border-t-transparent rounded-full" />
        </div>
    )
});

export default function TripCockpit() {
    const [tripData, setTripData]               = useState<any>(null);
    const [manualStart, setManualStart]         = useState('Bangalore');
    const [manualEnd, setManualEnd]             = useState('');
    const [loading, setLoading]                 = useState(true);
    const [calculating, setCalculating]         = useState(false);
    const [navigationActive, setNavigationActive] = useState(false);

    const [streamData, setStreamData] = useState<{
        soc: number; soh: number; speed: number; efficiency: number;
        temp: number; tirePressure: number; heading: number;
        lat: number; lng: number; totalWeight: number;
        elevation: number; drainRate: number;
        anomaly_type: string | null; tripComplete: boolean;
    }>({
        soc: 65, soh: 82, speed: 60, efficiency: 200,
        temp: 5.5, tirePressure: 28, heading: 0,
        lat: 0, lng: 0, totalWeight: 2300,
        elevation: 920, drainRate: 0.2,
        anomaly_type: null, tripComplete: false,
    });

    // Guardian / Gemma state
    const [activeSuggestion, setActiveSuggestion]   = useState<string | null>(null);
    const [activeAction,     setActiveAction]        = useState<string | null>(null);
    const [correctionFactor, setCorrectionFactor]   = useState<number | null>(null);
    const [gemmaSource, setGemmaSource]             = useState<string>('Cloud · 26B');
    const [alertFired, setAlertFired]               = useState(false);

    // Preview pins (geocoded as user types, before trip starts)
    const [previewStartCoords, setPreviewStartCoords] = useState<{ lat: number; lon: number } | null>(null);
    const [previewDestCoords,  setPreviewDestCoords]  = useState<{ lat: number; lon: number } | null>(null);
    const startDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const destDebounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Voice Co-Pilot response
    const [voiceAiResponse, setVoiceAiResponse]     = useState<string | null>(null);
    const [voiceAiImportant, setVoiceAiImportant]   = useState(false);
    const [lastTranscript,   setLastTranscript]     = useState<string | null>(null);
    const voiceDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Auto-dismiss voice response after 15s
    useEffect(() => {
        if (!voiceAiResponse) return;
        if (voiceDismissRef.current) clearTimeout(voiceDismissRef.current);
        voiceDismissRef.current = setTimeout(() => { setVoiceAiResponse(null); setLastTranscript(null); }, 15000);
        return () => { if (voiceDismissRef.current) clearTimeout(voiceDismissRef.current); };
    }, [voiceAiResponse]);

    // Live trip timer
    const [elapsedSeconds, setElapsedSeconds]       = useState(0);

    // Elevation delta (per SSE tick)
    const prevElevRef  = useRef<number>(920);
    const [elevDelta, setElevDelta]                 = useState(0);

    // EMA smoothed drain rate — prevents predicted-range bouncing
    const drainEmaRef  = useRef<number>(0.2);

    // Live trip bottom tab
    const [activeLiveTab, setActiveLiveTab]         = useState<'voice' | 'guardian'>('guardian');

    // Reroute state — fired once when predicted range < remaining distance
    const [rerouteState, setRerouteState] = useState<null | {
        toChargerPoints: Array<{ lat: number; lng: number }>;
        toDestPoints:    Array<{ lat: number; lng: number }>;
        chargerName:     string;
        chargerLat:      number;
        chargerLng:      number;
    }>(null);
    const rerouteFiredRef = useRef(false);

    useEffect(() => {
        setLoading(false);
        try {
            const saved = localStorage.getItem('rangeShield_activeTrip');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed.originText) setManualStart(parsed.originText);
                if (parsed.destText)   setManualEnd(parsed.destText);
            }
        } catch { /* ignore */ }
    }, []);

    // Geocode start as user types (debounced 600ms)
    useEffect(() => {
        if (navigationActive) return;
        if (startDebounceRef.current) clearTimeout(startDebounceRef.current);
        if (!manualStart || manualStart.trim().length < 3) { setPreviewStartCoords(null); return; }
        startDebounceRef.current = setTimeout(async () => {
            const result = await searchCity(manualStart).catch(() => null);
            if (result) setPreviewStartCoords({ lat: parseFloat(result.lat), lon: parseFloat(result.lon) });
            else setPreviewStartCoords(null);
        }, 600);
        return () => { if (startDebounceRef.current) clearTimeout(startDebounceRef.current); };
    }, [manualStart, navigationActive]); // eslint-disable-line react-hooks/exhaustive-deps

    // Geocode destination as user types (debounced 600ms)
    useEffect(() => {
        if (navigationActive) return;
        if (destDebounceRef.current) clearTimeout(destDebounceRef.current);
        if (!manualEnd || manualEnd.trim().length < 3) { setPreviewDestCoords(null); return; }
        destDebounceRef.current = setTimeout(async () => {
            const result = await searchCity(manualEnd).catch(() => null);
            if (result) setPreviewDestCoords({ lat: parseFloat(result.lat), lon: parseFloat(result.lon) });
            else setPreviewDestCoords(null);
        }, 600);
        return () => { if (destDebounceRef.current) clearTimeout(destDebounceRef.current); };
    }, [manualEnd, navigationActive]); // eslint-disable-line react-hooks/exhaustive-deps

    // Elapsed timer
    useEffect(() => {
        if (!navigationActive) { setElapsedSeconds(0); return; }
        const id = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
        return () => clearInterval(id);
    }, [navigationActive]);

    // SSE stream
    useEffect(() => {
        const es = new EventSource('/api/vehicle/stream');
        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // EMA smoothing: 90% old + 10% new — stabilises predicted range display
                if (data.drainRate !== undefined && data.drainRate > 0) {
                    drainEmaRef.current = drainEmaRef.current * 0.9 + data.drainRate * 0.1;
                }
                setStreamData(prev => {
                    const newElev = data.elevation ?? prev.elevation;
                    setElevDelta(parseFloat((newElev - prevElevRef.current).toFixed(1)));
                    prevElevRef.current = newElev;
                    return {
                        ...prev,
                        soc:          data.soc          ?? prev.soc,
                        soh:          data.soh          ?? prev.soh,
                        speed:        data.speed        ?? prev.speed,
                        efficiency:   data.efficiency   ?? prev.efficiency,
                        temp:         data.temp         ?? prev.temp,
                        tirePressure: data.tirePressure ?? prev.tirePressure,
                        totalWeight:  data.totalWeight  ?? prev.totalWeight,
                        lat:          data.lat          ?? prev.lat,
                        lng:          data.lng          ?? prev.lng,
                        heading:      data.heading      ?? prev.heading,
                        elevation:    newElev,
                        drainRate:    data.drainRate    ?? prev.drainRate,
                        anomaly_type: data.anomaly_type ?? null,
                        tripComplete: data.tripComplete ?? prev.tripComplete,
                    };
                });
            } catch { /* ignore parse errors */ }
        };
        return () => es.close();
    }, []);

    // Guardian: anomaly → Gemma → update live panel
    useEffect(() => {
        if (!streamData.anomaly_type) return;
        const telemetry = {
            soc: streamData.soc, soh: streamData.soh, temp: streamData.temp,
            tirePressure: streamData.tirePressure, drainRate: streamData.drainRate,
            speed: streamData.speed, elevation: streamData.elevation, totalWeight: streamData.totalWeight,
        };
        fetch('/api/vehicle/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telemetry, anomalyType: streamData.anomaly_type }),
        })
            .then(r => r.json())
            .then(result => {
                setActiveSuggestion(result.reasoning);
                setActiveAction(result.suggestion || null);
                setCorrectionFactor(result.correction_factor);
                setGemmaSource(result.source === 'cloud' ? 'Cloud · 26B' : 'Fallback');
                setAlertFired(true);
                setActiveLiveTab('guardian');
            })
            .catch(() => {
                setActiveSuggestion(`Anomaly detected: ${streamData.anomaly_type?.replace(/_/g, ' ')}`);
                setActiveAction(null);
                setAlertFired(true);
                setActiveLiveTab('guardian');
            });
    }, [streamData.anomaly_type]); // eslint-disable-line react-hooks/exhaustive-deps

    // Reroute: fire once when predicted range < remaining distance
    useEffect(() => {
        if (!navigationActive || !tripData || rerouteFiredRef.current) return;

        // Compute inline to avoid TDZ (derived consts declared later in render body)
        const eCap        = BATTERY_KWH * (streamData.soh / 100);
        const drain       = drainEmaRef.current;
        const rangeKm     = drain > 0 ? Math.max(0, (streamData.soc / 100 * eCap) / drain) : 0;
        const tripDist    = tripData?.result?.distance_km ?? 0;
        const elapsed     = (streamData.speed / 3.6) * elapsedSeconds / 1000;
        const remaining   = Math.max(0, tripDist - elapsed);

        if (rangeKm <= 0 || remaining <= 0) return;
        if (rangeKm >= remaining) return;

        const stations = tripData.route?.chargingStations ?? [];
        if (stations.length === 0) return;

        rerouteFiredRef.current = true;

        const vLat = streamData.lat !== 0 ? streamData.lat : tripData.start.lat;
        const vLng = streamData.lng !== 0 ? streamData.lng : tripData.start.lon;

        // Nearest charging station by straight-line distance
        const nearest = (stations as any[]).reduce((best: any, s: any) => {
            const sLat = s.AddressInfo.Latitude;
            const sLng = s.AddressInfo.Longitude;
            const d = Math.hypot(sLat - vLat, sLng - vLng);
            return (!best || d < best.d) ? { station: s, d } : best;
        }, null);

        if (!nearest) return;

        const cLat = nearest.station.AddressInfo.Latitude;
        const cLng = nearest.station.AddressInfo.Longitude;
        const dLat = tripData.end.lat;
        const dLng = tripData.end.lon;

        Promise.all([
            fetch(`https://router.project-osrm.org/route/v1/driving/${vLng},${vLat};${cLng},${cLat}?overview=full&geometries=geojson`).then(r => r.json()),
            fetch(`https://router.project-osrm.org/route/v1/driving/${cLng},${cLat};${dLng},${dLat}?overview=full&geometries=geojson`).then(r => r.json()),
        ]).then(([r1, r2]) => {
            const toChargerPoints = (r1.routes?.[0]?.geometry?.coordinates ?? []).map(([lng, lat]: [number, number]) => ({ lat, lng }));
            const toDestPoints    = (r2.routes?.[0]?.geometry?.coordinates ?? []).map(([lng, lat]: [number, number]) => ({ lat, lng }));
            setRerouteState({
                toChargerPoints,
                toDestPoints,
                chargerName: nearest.station.AddressInfo.Title || 'Charging Station',
                chargerLat:  cLat,
                chargerLng:  cLng,
            });
            setActiveLiveTab('guardian');
        }).catch(err => console.warn('[Reroute] OSRM failed:', err));
    }, [navigationActive, streamData.soc, streamData.soh, streamData.speed, elapsedSeconds, tripData]); // eslint-disable-line react-hooks/exhaustive-deps

    // Derived metrics — use EMA drain for stable range/drain display
    const effectiveCap     = BATTERY_KWH * (streamData.soh / 100);
    const smoothDrain      = drainEmaRef.current;
    const drainPctPerKm    = smoothDrain > 0 ? (smoothDrain / effectiveCap) * 100 : 0;
    const predictedRangeKm = smoothDrain > 0
        ? Math.max(0, (streamData.soc / 100 * effectiveCap) / smoothDrain)
        : 0;
    const tripDistKm      = tripData?.result?.distance_km ?? 0;
    const elapsedDistKm   = (streamData.speed / 3.6) * elapsedSeconds / 1000;
    const distToDestKm    = Math.max(0, tripDistKm - elapsedDistKm);
    const etaMins         = distToDestKm > 0 && streamData.speed > 0
        ? Math.round(distToDestKm / streamData.speed * 60) : 0;
    const arrivalSoc      = tripData?.result?.range_analysis?.arrival_soc_predicted ?? null;

    const formatElapsed = (s: number) =>
        `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

    const socColor      = streamData.soc > 30 ? 'text-emerald-400' : streamData.soc > 10 ? 'text-amber-400' : 'text-red-400';
    const drainIsHigh   = drainPctPerKm > 1.0;

    // Bearing from vehicle to destination (degrees 0–360)
    const bearingToDestination = useMemo(() => {
        const dest = tripData?.end;
        if (!dest || !streamData.lat || !streamData.lng) return 0;
        const toRad = (d: number) => d * Math.PI / 180;
        const dLng  = toRad(dest.lon - streamData.lng);
        const lat1  = toRad(streamData.lat);
        const lat2  = toRad(dest.lat);
        const y     = Math.sin(dLng) * Math.cos(lat2);
        const x     = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }, [streamData.lat, streamData.lng, tripData?.end]); // eslint-disable-line react-hooks/exhaustive-deps

    // Memoized vehicle position — heading points toward destination
    const vehiclePosition = useMemo(() => {
        if (!navigationActive) return undefined;
        if (streamData.lat !== 0)
            return { lat: streamData.lat, lng: streamData.lng, heading: bearingToDestination };
        if (tripData?.start?.lat)
            return { lat: tripData.start.lat, lng: tripData.start.lon, heading: bearingToDestination };
        return undefined;
    }, [navigationActive, streamData.lat, streamData.lng, bearingToDestination, tripData?.start]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleStartNavigation = async () => {
        if (!manualStart || !manualEnd) { alert('Enter Start and Destination first.'); return; }
        setCalculating(true);
        try {
            // Restart sim with user's actual route + current SOC
            fetch('/api/simulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    origin:      manualStart,
                    destination: manualEnd,
                    soc:         streamData.soc,
                    speed:       80,
                }),
            }).catch(() => {});

            const payload = {
                origin: manualStart, destination: manualEnd,
                cargoWeight: '0', passengers: '1',
                avgConsumption: (streamData.efficiency / 1000).toString(),
                initialBatteryPct: streamData.soc.toString(),
                batteryCapacity: '60',
                vehicleTemp: streamData.temp, soh: 100, tirePressure: streamData.tirePressure,
            };
            const res  = await fetch('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!res.ok) throw new Error('Calculation Failed');
            const data = await res.json();
            setTripData({
                start: data.origin_coords
                    ? { lat: data.origin_coords.lat, lon: data.origin_coords.lng }
                    : { lat: 0, lon: 0 },
                end: data.dest_coords
                    ? { lat: data.dest_coords.lat, lon: data.dest_coords.lng }
                    : null,
                route: { encodedPolyline: data.polyline, chargingStations: data.charging_stations || [] },
                result: data,
            });
            fetch('/api/vehicle', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ encodedPolyline: data.polyline }),
            }).catch(() => {});
            setPreviewStartCoords(null);
            setPreviewDestCoords(null);
            setNavigationActive(true);
            setAlertFired(false);
            setActiveSuggestion(null);
            setCorrectionFactor(null);
            setRerouteState(null);
            rerouteFiredRef.current = false;
        } catch (err) {
            console.error(err);
            alert('Route calculation failed. Use valid locations.');
        } finally { setCalculating(false); }
    };

    const stopNavigation = () => {
        setNavigationActive(false);
        setTripData(null);
        setRerouteState(null);
        rerouteFiredRef.current = false;
        fetch('/api/simulate', { method: 'DELETE' }).catch(() => {});
    };

    if (loading) return (
        <div className="min-h-screen bg-black text-emerald-500 flex items-center justify-center font-mono tracking-widest">
            INITIALIZING COCKPIT...
        </div>
    );

    return (
        <div className="flex h-screen w-full bg-zinc-950 text-zinc-100 overflow-hidden pt-[80px]">

            {/* ── Left Sidebar ──────────────────────────────────────────────── */}
            <aside className="w-[35%] h-full flex flex-col border-r border-zinc-900 bg-zinc-950 z-20 overflow-y-auto">

                {/* ── SET COURSE (pre-nav) ─────────────────────────────────── */}
                {!navigationActive && (
                    <div className="flex-1 p-6 space-y-6">
                        <div className="space-y-1">
                            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400">
                                Set Course
                            </h1>
                            <p className="text-xs text-zinc-500 font-mono tracking-wider">TRIP COCKPIT — LIVE TELEMETRY</p>
                        </div>

                        {/* Route inputs */}
                        <div className="border border-zinc-800 bg-zinc-900/30 rounded-lg overflow-hidden">
                            <div className="p-4 pb-2 flex items-center gap-2">
                                <Navigation className="w-4 h-4 text-emerald-500" />
                                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Route</h3>
                            </div>
                            <div className="p-4 pt-2">
                                <div className="bg-zinc-900/80 rounded-xl border border-zinc-800/60 relative">
                                    <div className="absolute left-[19.5px] top-[32px] bottom-[32px] w-[1px] bg-zinc-700/50" />
                                    <div className="relative flex items-center h-12">
                                        <div className="w-10 flex justify-center z-10 bg-zinc-900 py-1 rounded-l-xl">
                                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 block mt-0.5" />
                                        </div>
                                        <div className="flex-1 flex flex-col justify-center">
                                            <input type="text" value={manualStart} onChange={e => setManualStart(e.target.value)}
                                                placeholder="Current location"
                                                className="w-full bg-transparent text-sm font-semibold text-white placeholder:text-zinc-500 focus:outline-none" />
                                            <span className="text-[10px] text-zinc-500">Current location</span>
                                        </div>
                                        <div className="pr-3 text-emerald-500"><Navigation className="w-3.5 h-3.5" /></div>
                                    </div>
                                    <div className="h-[1px] bg-zinc-800/60 w-full ml-10" />
                                    <div className="relative flex items-center h-12">
                                        <div className="w-10 flex justify-center z-10 bg-zinc-900 py-1 rounded-l-xl">
                                            <MapPin className="w-4 h-4 text-zinc-500" />
                                        </div>
                                        <div className="flex-1">
                                            <input type="text" value={manualEnd} onChange={e => setManualEnd(e.target.value)}
                                                placeholder="Enter destination"
                                                className="w-full bg-transparent text-sm font-semibold text-white placeholder:text-zinc-500 focus:outline-none" />
                                        </div>
                                        <div className="pr-3 text-zinc-500"><Search className="w-3.5 h-3.5" /></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Vehicle telemetry */}
                        <div className="border border-zinc-800 bg-zinc-900/30 rounded-lg overflow-hidden">
                            <div className="p-4 pb-2">
                                <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">Vehicle Data</h3>
                            </div>
                            <div className="p-4 pt-0">
                                <div className="border border-zinc-800/60 rounded-xl overflow-hidden bg-zinc-950/50">
                                    <div className="grid grid-cols-2">
                                        <div className="p-4 border-b border-r border-zinc-800/60">
                                            <div className={`text-xl font-bold ${socColor}`}>{streamData.soc.toFixed(1)}%</div>
                                            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1"><Battery className="w-3 h-3" /> SOC</div>
                                        </div>
                                        <div className="p-4 border-b border-zinc-800/60">
                                            <div className="text-xl font-bold text-white">{(streamData.drainRate * 1000).toFixed(0)}<span className="text-sm font-medium"> Wh/km</span></div>
                                            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1"><Gauge className="w-3 h-3" /> Drain rate</div>
                                        </div>
                                        <div className="p-4 border-b border-r border-zinc-800/60">
                                            <div className="text-xl font-bold text-white">{streamData.tirePressure.toFixed(1)}<span className="text-sm font-medium"> PSI</span></div>
                                            <div className="text-xs text-zinc-500 mt-1">Tire press.</div>
                                        </div>
                                        <div className="p-4 border-b border-zinc-800/60">
                                            <div className="text-xl font-bold text-white">{streamData.temp.toFixed(1)}<span className="text-sm font-medium">°C</span></div>
                                            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1"><Thermometer className="w-3 h-3" /> Temp</div>
                                        </div>
                                        <div className="p-4 border-r border-zinc-800/60">
                                            <div className="text-xl font-bold text-white">{streamData.elevation.toFixed(0)}<span className="text-sm font-medium"> m</span></div>
                                            <div className="text-xs text-zinc-500 mt-1">Elevation</div>
                                        </div>
                                        <div className="p-4">
                                            <div className="text-xl font-bold text-white">{streamData.totalWeight}<span className="text-sm font-medium"> kg</span></div>
                                            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1"><Weight className="w-3 h-3" /> Weight</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Voice AI response */}
                        {voiceAiResponse && (
                            <div className="border border-zinc-700 bg-zinc-800/95 rounded-xl p-3">
                                <div className="text-[10px] text-emerald-400 font-mono mb-1 flex items-center gap-2">
                                    <span className="relative flex h-1.5 w-1.5">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                                    </span>
                                    VERTEX AI CO-PILOT
                                </div>
                                <p className={`text-xs leading-relaxed ${voiceAiImportant ? 'text-red-400 font-semibold' : 'text-zinc-200'}`}>{voiceAiResponse}</p>
                                <button onClick={() => setVoiceAiResponse(null)}
                                    className="mt-2 w-full py-1 text-[10px] bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors uppercase">
                                    Dismiss
                                </button>
                            </div>
                        )}

                        {/* Mic */}
                        <div className="flex flex-col items-center py-2">
                            <div className="scale-90">
                                <VoiceMicrophone
                                    onResponse={(r, imp) => { setVoiceAiResponse(r); setVoiceAiImportant(imp); }}
                                    context={{
                                        telemetry: {
                                            soc:          streamData.soc,
                                            efficiency:   streamData.efficiency,
                                            temp:         streamData.temp,
                                            tirePressure: streamData.tirePressure,
                                        },
                                        trip: {
                                            origin:       manualStart,
                                            destination:  manualEnd,
                                            distance_km:  tripData?.result?.distance_km ?? 0,
                                            duration_mins: tripData?.result?.duration_mins ?? 0,
                                            battery_pct:  streamData.soc,
                                            cargo_kg:     tripData?.cargo ?? 0,
                                            passengers:   tripData?.passengers ?? 1,
                                        },
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                )}

                {/* ── LIVE TRIP dashboard (nav active) ─────────────────────── */}
                {navigationActive && (
                    <div className="flex-1 p-5 flex flex-col gap-4 overflow-hidden">

                        {/* Header */}
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                <span className="text-xs font-mono font-semibold text-zinc-300 uppercase tracking-widest">Live Trip</span>
                            </div>
                            <span className="font-mono text-sm text-zinc-400">{formatElapsed(elapsedSeconds)}</span>
                        </div>

                        {/* SOC + Drain rate */}
                        <div className="space-y-2">
                            <div className="flex items-end justify-between">
                                <div>
                                    <div className={`text-5xl font-bold tabular-nums ${socColor}`}>
                                        {streamData.soc.toFixed(1)}<span className="text-2xl">%</span>
                                    </div>
                                    <div className="text-xs text-zinc-500 mt-1">State of charge</div>
                                </div>
                                <div className="text-right">
                                    <div className={`text-2xl font-bold tabular-nums ${drainPctPerKm > 1.5 ? 'text-red-400' : 'text-zinc-300'}`}>
                                        {drainPctPerKm.toFixed(1)}<span className="text-base">%/km</span>
                                    </div>
                                    <div className="text-xs text-zinc-500 mt-1">Drain rate</div>
                                </div>
                            </div>
                            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                <div className={`h-full rounded-full transition-all duration-500 ${streamData.soc > 30 ? 'bg-emerald-500' : streamData.soc > 10 ? 'bg-amber-500' : 'bg-red-500'}`}
                                    style={{ width: `${Math.max(0, streamData.soc)}%` }} />
                            </div>
                        </div>

                        {/* Range section */}
                        <div className="space-y-2">
                            <div className="flex items-end justify-between">
                                <div>
                                    <div className="text-3xl font-bold text-white tabular-nums">
                                        {predictedRangeKm.toFixed(0)} <span className="text-base font-medium text-zinc-400">km</span>
                                    </div>
                                    <div className="text-xs text-zinc-500 mt-1">Predicted range</div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xl font-bold text-zinc-300 tabular-nums">
                                        {distToDestKm.toFixed(1)} <span className="text-sm font-medium text-zinc-500">km</span>
                                    </div>
                                    <div className="text-xs text-zinc-500 mt-1">To destination</div>
                                </div>
                            </div>
                            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                <div className="h-full rounded-full bg-blue-500 transition-all duration-500"
                                    style={{ width: tripDistKm > 0 ? `${Math.min(100, (predictedRangeKm / tripDistKm) * 100)}%` : '0%' }} />
                            </div>
                        </div>

                        {/* Reroute alert banner */}
                        {rerouteState && (
                            <div className="rounded-xl border border-blue-700/60 bg-blue-950/20 p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                                    <span className="text-[10px] font-mono text-blue-300 uppercase tracking-widest">Rerouting</span>
                                </div>
                                <p className="text-xs text-zinc-200 leading-relaxed">
                                    Range insufficient to reach destination. Rerouting via nearest charger:
                                </p>
                                <div className="flex items-center gap-2 text-xs text-blue-300 font-medium">
                                    <span className="inline-block w-3 h-0.5 bg-blue-900 rounded" style={{ minWidth: 12 }} />
                                    <span>{rerouteState.chargerName}</span>
                                </div>
                                <button
                                    onClick={() => { setRerouteState(null); rerouteFiredRef.current = true; }}
                                    className="w-full py-1 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded transition-colors uppercase tracking-wider"
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}

                        {/* Guardian panel */}
                        {(() => {
                            const isCritical = correctionFactor !== null && correctionFactor >= 1.3;
                            const isWarning  = correctionFactor !== null && correctionFactor >= 1.1 && correctionFactor < 1.3;
                            const anomalyLabel = streamData.anomaly_type
                                ? streamData.anomaly_type.replace(/_/g, ' ')
                                : null;
                            return (
                                <div className={`rounded-xl flex-1 flex flex-col overflow-hidden transition-all duration-500 border ${
                                    isCritical ? 'border-red-700/60 bg-red-950/10' :
                                    isWarning  ? 'border-amber-700/50 bg-amber-950/10' :
                                    'border-zinc-800/60 bg-zinc-900/30'
                                }`}>
                                    {/* Header */}
                                    <div className="flex items-center gap-2 px-3 pt-3 pb-2 border-b border-zinc-800/60">
                                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                            alertFired ? (isCritical ? 'bg-red-400 animate-pulse' : 'bg-amber-400 animate-pulse') : 'bg-zinc-600'
                                        }`} />
                                        <Zap className="w-3 h-3 text-violet-400 flex-shrink-0" />
                                        <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest flex-1">
                                            Guardian · {gemmaSource}
                                        </span>
                                    </div>

                                    <div className="p-3 flex-1 flex flex-col gap-2.5 overflow-y-auto">
                                        {activeSuggestion ? (
                                            <>
                                                {/* Anomaly type pill */}
                                                {anomalyLabel && (
                                                    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md w-fit ${
                                                        isCritical ? 'bg-red-950/50 border border-red-800/40' : 'bg-amber-950/40 border border-amber-800/40'
                                                    }`}>
                                                        <AlertTriangle className={`w-2.5 h-2.5 ${isCritical ? 'text-red-400' : 'text-amber-400'}`} />
                                                        <span className={`text-[9px] font-mono uppercase tracking-widest ${isCritical ? 'text-red-300' : 'text-amber-300'}`}>
                                                            {anomalyLabel}
                                                        </span>
                                                    </div>
                                                )}

                                                {/* Reasoning */}
                                                <p className="text-xs text-zinc-300 leading-relaxed">{activeSuggestion}</p>

                                                {/* Driver Action */}
                                                {activeAction && (
                                                    <div className={`rounded-lg p-3 space-y-1.5 border ${
                                                        isCritical
                                                            ? 'bg-red-950/30 border-red-700/50'
                                                            : 'bg-amber-950/30 border-amber-700/50'
                                                    }`}>
                                                        <div className="flex items-center gap-1.5">
                                                            <ChevronRight className={`w-3 h-3 ${isCritical ? 'text-red-400' : 'text-amber-400'}`} />
                                                            <span className={`text-[9px] font-mono uppercase tracking-widest ${isCritical ? 'text-red-400' : 'text-amber-400'}`}>
                                                                Driver Action
                                                            </span>
                                                        </div>
                                                        <p className={`text-xs leading-relaxed font-medium ${isCritical ? 'text-red-100' : 'text-amber-100'}`}>
                                                            {activeAction}
                                                        </p>
                                                    </div>
                                                )}

                                            </>
                                        ) : (
                                            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
                                                <div className="w-8 h-8 rounded-full border border-zinc-700/50 flex items-center justify-center">
                                                    <ShieldCheck className="w-4 h-4 text-zinc-600" />
                                                </div>
                                                <span className="text-[10px] text-zinc-600 font-mono">All systems nominal</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                )}

                {/* Sticky bottom CTA */}
                <div className="p-4 border-t border-zinc-900 space-y-3">
                    {navigationActive && (
                        <>
                            {/* Voice conversation display */}
                            {(lastTranscript || voiceAiResponse) && (
                                <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/60 overflow-hidden">
                                    {/* Header */}
                                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/60">
                                        <div className="flex items-center gap-1.5">
                                            <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                                            <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">Co-Pilot · Gemma 4</span>
                                        </div>
                                        <button onClick={() => { setVoiceAiResponse(null); setLastTranscript(null); }}
                                            className="text-zinc-600 hover:text-zinc-400">
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>

                                    <div className="p-3 space-y-2 max-h-40 overflow-y-auto">
                                        {/* User bubble */}
                                        {lastTranscript && (
                                            <div className="flex justify-end">
                                                <div className="bg-blue-600/80 text-white text-xs rounded-2xl rounded-br-sm px-3 py-2 max-w-[85%] leading-relaxed">
                                                    {lastTranscript}
                                                </div>
                                            </div>
                                        )}

                                        {/* Co-Pilot response bubble */}
                                        {voiceAiResponse && (
                                            <div className="flex justify-start">
                                                <div className={`text-xs rounded-2xl rounded-bl-sm px-3 py-2 max-w-[85%] leading-relaxed border ${
                                                    voiceAiImportant
                                                        ? 'bg-red-950/50 border-red-700/40 text-red-200'
                                                        : 'bg-zinc-800/80 border-zinc-700/40 text-zinc-200'
                                                }`}>
                                                    {voiceAiResponse}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Mic */}
                            <div className="flex items-center justify-center">
                                <VoiceMicrophone
                                    onResponse={(r, imp) => { setVoiceAiResponse(r); setVoiceAiImportant(imp); }}
                                    onTranscript={(t) => setLastTranscript(t)}
                                    context={{
                                        telemetry: {
                                            soc:          streamData.soc,
                                            efficiency:   streamData.efficiency,
                                            temp:         streamData.temp,
                                            tirePressure: streamData.tirePressure,
                                        },
                                        trip: {
                                            origin:       manualStart,
                                            destination:  manualEnd,
                                            distance_km:  tripData?.result?.distance_km ?? 0,
                                            duration_mins: tripData?.result?.duration_mins ?? 0,
                                            battery_pct:  streamData.soc,
                                            cargo_kg:     tripData?.cargo ?? 0,
                                            passengers:   tripData?.passengers ?? 1,
                                        },
                                    }}
                                />
                            </div>
                        </>
                    )}
                    {navigationActive ? (
                        <button onClick={stopNavigation}
                            className="w-full bg-red-950/40 hover:bg-red-950/60 border border-red-900/60 text-red-400 font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-all">
                            <X className="w-4 h-4" /> End Trip
                        </button>
                    ) : (
                        <button onClick={handleStartNavigation}
                            disabled={calculating || !manualStart || !manualEnd}
                            className={`w-full font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-all tracking-widest disabled:opacity-50 ${
                                manualStart && manualEnd && !calculating
                                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.35)]'
                                    : 'bg-zinc-900 border border-zinc-800/60 text-zinc-400'
                            }`}>
                            {calculating
                                ? <div className="w-4 h-4 border-2 border-zinc-500 border-t-white rounded-full animate-spin" />
                                : <Play className="w-4 h-4 fill-current" />}
                            {calculating ? 'Calculating...' : 'Start Trip'}
                        </button>
                    )}
                </div>
            </aside>

            {/* ── Map ───────────────────────────────────────────────────────── */}
            <main className="flex-1 relative bg-zinc-950">
                <GoogleMap
                    encodedPolyline={tripData?.route?.encodedPolyline || ''}
                    startPos={navigationActive
                        ? (tripData?.start?.lat !== 0 ? tripData?.start : undefined)
                        : (previewStartCoords || undefined)}
                    endPos={navigationActive
                        ? (tripData?.end || undefined)
                        : (previewDestCoords || undefined)}
                    chargingStations={tripData?.route?.chargingStations || []}
                    tilt={0}
                    heading={0}
                    vehiclePosition={vehiclePosition}
                    rerouteSegments={rerouteState ? [
                        { points: rerouteState.toChargerPoints, color: '#1e3a8a', dashed: false, weight: 6 },
                        { points: rerouteState.toDestPoints,    color: '#3b82f6', dashed: true,  weight: 5 },
                    ] : []}
                    rerouteChargerPos={rerouteState ? {
                        lat:  rerouteState.chargerLat,
                        lng:  rerouteState.chargerLng,
                        name: rerouteState.chargerName,
                    } : undefined}
                />

                {/* Floating telemetry + ETA card (nav active) */}
                {navigationActive && (
                    <div className="absolute top-4 right-4 z-30 bg-zinc-950/92 border border-zinc-800 backdrop-blur-md rounded-xl p-4 shadow-2xl min-w-[200px] space-y-3">
                        {/* Telemetry grid */}
                        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                            <div>
                                <div className="text-sm font-bold text-white tabular-nums">{streamData.speed.toFixed(0)} <span className="text-xs text-zinc-400">km/h</span></div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">Speed</div>
                            </div>
                            <div>
                                <div className="text-sm font-bold text-white tabular-nums">{streamData.temp.toFixed(1)}<span className="text-xs text-zinc-400">°C</span></div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">Temp</div>
                            </div>
                            <div>
                                <div className={`text-sm font-bold tabular-nums ${elevDelta < 0 ? 'text-emerald-400' : elevDelta > 0 ? 'text-amber-400' : 'text-white'}`}>
                                    {elevDelta > 0 ? '+' : ''}{elevDelta.toFixed(0)}<span className="text-xs text-zinc-400"> m</span>
                                </div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">Elev Δ</div>
                            </div>
                            <div>
                                <div className="text-sm font-bold text-white tabular-nums">{(smoothDrain * 1000).toFixed(0)}<span className="text-xs text-zinc-400"> Wh/km</span></div>
                                <div className="text-[10px] text-zinc-500 mt-0.5">Efficiency</div>
                            </div>
                        </div>
                        {/* Divider */}
                        <div className="border-t border-zinc-800 pt-2 space-y-2">
                            <div className="flex items-center justify-between gap-6">
                                <span className="text-xs text-zinc-500">ETA</span>
                                <span className="text-sm font-bold text-white">{etaMins} min</span>
                            </div>
                            <div className="flex items-center justify-between gap-6">
                                <span className="text-xs text-zinc-500">Arrival SOC</span>
                                <span className={`text-sm font-bold ${arrivalSoc !== null && arrivalSoc < 10 ? 'text-red-400' : 'text-emerald-400'}`}>
                                    ~{arrivalSoc ?? '--'}%
                                </span>
                            </div>
                            <div className="flex items-center justify-between gap-6">
                                <span className="text-xs text-zinc-500">Mode</span>
                                <span className="text-xs font-mono text-violet-400">{gemmaSource}</span>
                            </div>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
