import { decodePolyline } from '@/lib/polyline';

export interface VehicleState {
    lat: number;
    lng: number;
    soc: number;
    soh: number;
    speed: number;
    elevation: number;
    drainRate: number;      // kWh/km current
    efficiency: number;     // base Wh/km
    temp: number;           // cabin °C
    tirePressure: number;   // PSI
    totalWeight: number;    // kg
    anomalyType: string | null;
    tripComplete: boolean;
    timestamp: number;
}

interface RoutePoint {
    lat: number;
    lng: number;
    cumDist: number;    // meters from start
    elevation: number;  // simulated
}

interface TriggerPoint {
    fraction: number;   // 0–1 fraction of total route distance
    anomalyType: string;
    overrides: {
        temp?: number;
        tirePressure?: number;
        speed?: number;
        soh?: number;
        drainMultiplier?: number;
    };
    fired: boolean;
}

// ---------- Config ----------
const TICK_MS = 100;
const BATTERY_CAPACITY_KWH = 60;
const VEHICLE_MASS_KG = 2100;
const REGEN_EFFICIENCY = 0.65;

// Trigger points chosen to stress-test Gemma:
//   20%  cold_snap       → temp 2.5°C  (math: flat 10%, Gemma corrects non-linear HVAC)
//   45%  tyre_pressure   → 24 PSI      (math: linear %, Gemma corrects rolling resistance curve)
//   72%  battery_degrade → soh 74%     (math: capacity penalty, Gemma corrects discharge curve)
const DEFAULT_TRIGGERS: TriggerPoint[] = [
    {
        fraction: 0.20,
        anomalyType: 'cold_snap',
        overrides: { temp: 2.5, tirePressure: 27 },
        fired: false,
    },
    {
        fraction: 0.45,
        anomalyType: 'tyre_pressure_drop',
        overrides: { tirePressure: 24, speed: 40 },
        fired: false,
    },
    {
        fraction: 0.72,
        anomalyType: 'battery_degrade',
        overrides: { soh: 74, drainMultiplier: 1.75 },
        fired: false,
    },
];

// ---------- Module-level state ----------
let state: VehicleState = makeDefaultState();
let route: RoutePoint[] = [];
let routeLength = 0;        // total meters
let distanceCovered = 0;    // meters traveled
let drainMultiplier = 1.0;
let triggers: TriggerPoint[] = DEFAULT_TRIGGERS.map(t => ({ ...t }));
let pendingAnomalies: string[] = [];
let intervalId: ReturnType<typeof setInterval> | null = null;
let externalControl = false; // when true, internal tick defers to external script

function makeDefaultState(): VehicleState {
    return {
        lat: 12.9716,
        lng: 77.5946,
        soc: 65.0,
        soh: 82.0,
        speed: 60,
        elevation: 920,
        drainRate: 0.2,
        efficiency: 200,
        temp: 5.5,
        tirePressure: 28.0,
        totalWeight: 2300,
        anomalyType: null,
        tripComplete: false,
        timestamp: Date.now(),
    };
}

// ---------- Helpers ----------
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6_371_000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function simulatedElevation(fraction: number, base = 920): number {
    // Sine terrain — realistic enough to produce ascent/descent physics + regen
    return base + Math.sin(fraction * Math.PI * 5) * 90;
}

function interpolateRoute(dist: number): { lat: number; lng: number; elevation: number } {
    if (route.length === 0) return { lat: state.lat, lng: state.lng, elevation: state.elevation };

    let lo = 0, hi = route.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (route[mid].cumDist <= dist) lo = mid; else hi = mid;
    }

    const p1 = route[lo], p2 = route[hi];
    if (p2.cumDist === p1.cumDist) return { lat: p1.lat, lng: p1.lng, elevation: p1.elevation };

    const t = (dist - p1.cumDist) / (p2.cumDist - p1.cumDist);
    return {
        lat: p1.lat + t * (p2.lat - p1.lat),
        lng: p1.lng + t * (p2.lng - p1.lng),
        elevation: p1.elevation + t * (p2.elevation - p1.elevation),
    };
}

function physicsStep(stepM: number, elevDelta: number): number {
    // Returns kWh consumed for this step
    const distKm = stepM / 1000;
    let energyKwh = distKm * (state.efficiency / 1000);

    if (elevDelta > 0) {
        // Ascending — potential energy cost
        energyKwh += (VEHICLE_MASS_KG * 9.81 * elevDelta) / 3_600_000;
    } else if (elevDelta < 0) {
        // Descending — regen recovery
        energyKwh -= (VEHICLE_MASS_KG * 9.81 * Math.abs(elevDelta) * REGEN_EFFICIENCY) / 3_600_000;
    }

    return Math.max(0, energyKwh * drainMultiplier);
}

// ---------- Public API ----------
export function getVehicleState(): VehicleState {
    return { ...state };
}

// Called by /api/vehicle/ingest — standalone script takes over state
export function setStateFromExternal(packet: Partial<VehicleState> & { anomaly_type?: string | null }): void {
    externalControl = true;
    const anomalyType = packet.anomaly_type ?? null;
    if (anomalyType) pendingAnomalies.push(anomalyType);
    state = {
        ...state,
        ...packet,
        anomalyType,
        timestamp: Date.now(),
    };
}

export function releaseExternalControl(): void {
    externalControl = false;
}

export function consumePendingAnomalies(): string[] {
    const out = [...pendingAnomalies];
    pendingAnomalies = [];
    return out;
}

export function resetVehicleState(): void {
    state = makeDefaultState();
    route = [];
    routeLength = 0;
    distanceCovered = 0;
    drainMultiplier = 1.0;
    triggers = DEFAULT_TRIGGERS.map(t => ({ ...t, fired: false }));
    pendingAnomalies = [];
}

export function setRoute(encodedPolyline: string): void {
    const decoded = decodePolyline(encodedPolyline);
    let cumDist = 0;

    route = decoded.map(([lat, lng], i) => {
        if (i > 0) cumDist += haversineM(decoded[i - 1][0], decoded[i - 1][1], lat, lng);
        return { lat, lng, cumDist, elevation: 0 };
    });

    routeLength = route[route.length - 1]?.cumDist ?? 0;

    // Assign simulated elevation using fraction
    route = route.map(p => ({
        ...p,
        elevation: simulatedElevation(routeLength > 0 ? p.cumDist / routeLength : 0),
    }));

    distanceCovered = 0;
    triggers = DEFAULT_TRIGGERS.map(t => ({ ...t, fired: false }));
    drainMultiplier = 1.0;

    if (route.length > 0) {
        state = { ...state, lat: route[0].lat, lng: route[0].lng, elevation: route[0].elevation, tripComplete: false };
    }
}

export function startSimulation(): void {
    if (intervalId) return;

    intervalId = setInterval(() => {
        if (state.tripComplete || externalControl) return;

        const stepM = (state.speed / 3.6) * (TICK_MS / 1000); // meters this tick
        const prevDist = distanceCovered;
        distanceCovered = Math.min(distanceCovered + stepM, routeLength || 0);

        const routeFraction = routeLength > 0 ? distanceCovered / routeLength : 0;

        // --- Trigger check ---
        let anomalyType: string | null = null;
        for (const trigger of triggers) {
            if (!trigger.fired && routeFraction >= trigger.fraction) {
                trigger.fired = true;
                anomalyType = trigger.anomalyType;
                pendingAnomalies.push(anomalyType);

                const ov = trigger.overrides;
                if (ov.temp !== undefined)         state = { ...state, temp: ov.temp };
                if (ov.tirePressure !== undefined) state = { ...state, tirePressure: ov.tirePressure };
                if (ov.speed !== undefined)        state = { ...state, speed: ov.speed };
                if (ov.soh !== undefined)          state = { ...state, soh: ov.soh };
                if (ov.drainMultiplier !== undefined) drainMultiplier = ov.drainMultiplier;
                break;
            }
        }

        // --- Position + physics ---
        if (route.length > 0) {
            const prev = interpolateRoute(prevDist);
            const cur  = interpolateRoute(distanceCovered);
            const elevDelta = cur.elevation - prev.elevation;

            // Amplify energy on anomaly tick to make Gemma correction obvious
            const energyKwh = physicsStep(stepM, elevDelta) * (anomalyType ? 1.4 : 1.0);
            const effectiveCapacity = BATTERY_CAPACITY_KWH * (state.soh / 100);
            const socDrop = (energyKwh / effectiveCapacity) * 100;
            const drainRateKwhKm = stepM > 0 ? energyKwh / (stepM / 1000) : 0.2;

            const arrived = distanceCovered >= routeLength;

            state = {
                ...state,
                lat: cur.lat,
                lng: cur.lng,
                elevation: parseFloat(cur.elevation.toFixed(1)),
                soc: parseFloat(Math.max(0, state.soc - socDrop).toFixed(3)),
                drainRate: parseFloat(drainRateKwhKm.toFixed(4)),
                anomalyType,
                tripComplete: arrived,
                timestamp: Date.now(),
            };
        } else {
            // Idle — no route loaded yet
            state = { ...state, anomalyType: null, timestamp: Date.now() };
        }
    }, TICK_MS);
}

export function stopSimulation(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}
