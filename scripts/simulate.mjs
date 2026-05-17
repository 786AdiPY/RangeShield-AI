/**
 * RangeShield-AI — standalone route simulation script
 * Run: node scripts/simulate.mjs
 * Env: NEXT_URL (default http://localhost:3000)
 */

// ─── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  ORIGIN_QUERY: process.env.SIM_ORIGIN ?? 'Bangalore, India',
  DEST_QUERY:   process.env.SIM_DEST   ?? 'Chennai, India',
  INITIAL_SOC:  parseFloat(process.env.SIM_SOC   ?? '85'),
  SPEED_KMH:    parseFloat(process.env.SIM_SPEED ?? '80'),
  TEMP_C:       22,
  AC_ON:        true,
  NEXT_URL:     process.env.NEXT_URL ?? 'http://localhost:3000',
};

// ─── Physics constants ──────────────────────────────────────────────────────────
const BATTERY_KWH     = 60;
const VEHICLE_KG      = 2100;
const BASE_WH_KM      = 200;   // Wh/km base efficiency
const BASE_KWH_KM     = BASE_WH_KM / 1000;
const REGEN_EFF       = 0.65;
const TICK_MS         = 100;

// ─── Trigger points (fraction-based, deterministic) ────────────────────────────
const TRIGGER_POINTS = [
  {
    fraction: 0.20, anomalyType: 'cold_snap', fired: false,
    overrides: { temp: 2.5, tirePressure: 27 },
  },
  {
    fraction: 0.45, anomalyType: 'tyre_pressure_drop', fired: false,
    overrides: { tirePressure: 24, speed: 40 },
  },
  {
    fraction: 0.60, anomalyType: 'CHARGER_WINDOW_CLOSING', fired: false,
    overrides: {},
  },
  {
    fraction: 0.72, anomalyType: 'battery_degrade', fired: false,
    overrides: { soh: 74, drainMultiplier: 1.75 },
  },
];

// ─── Mutable state ─────────────────────────────────────────────────────────────
let state = {
  lat:          12.9716,
  lng:          77.5946,
  soc:          CONFIG.INITIAL_SOC,
  soh:          82,
  speed:        CONFIG.SPEED_KMH,
  elevation:    920,
  drainRate:    BASE_KWH_KM,
  temp:         CONFIG.TEMP_C,
  tirePressure: 32,
  totalWeight:  2300,
  anomalyType:  null,
  tripComplete: false,
  timestamp:    Date.now(),
};

let drainMultiplier   = 1.0;
let distanceCovered   = 0;
let routeLength       = 0;
let waypoints         = [];
let ponrFired         = false;

// Guardian: RAPID_DRAIN debounce
let rapidDrainFirstMs = null;
let rapidDrainFired   = false;

// Periodic Gemma
let lastGemmaMs = Date.now();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const R    = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fallback when Open-Topo-Data is unavailable
function simulatedElevation(fraction, base = 920) {
  return base + Math.sin(fraction * Math.PI * 5) * 90;
}

// Interpolate elevation at cumDist using sampled elevation array
function interpolateElevation(dist, samples) {
  if (samples.length === 0) return 920;
  if (dist <= samples[0].cumDist) return samples[0].elevation;
  if (dist >= samples[samples.length - 1].cumDist) return samples[samples.length - 1].elevation;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].cumDist <= dist) lo = mid; else hi = mid;
  }
  const p1 = samples[lo], p2 = samples[hi];
  const t = (dist - p1.cumDist) / (p2.cumDist - p1.cumDist);
  return p1.elevation + t * (p2.elevation - p1.elevation);
}

// Fetch real elevations from Open-Topo-Data (srtm30m, max 100/req, 1 req/s)
async function fetchElevations(points) {
  const BATCH   = 100;
  const DATASET = 'srtm30m';
  const results = [];

  for (let i = 0; i < points.length; i += BATCH) {
    const batch     = points.slice(i, i + BATCH);
    const locations = batch.map(p => `${p.lat},${p.lng}`).join('|');
    const res  = await fetch(`https://api.opentopodata.org/v1/${DATASET}?locations=${locations}`);
    const data = await res.json();
    if (data.status !== 'OK') throw new Error(`Open-Topo-Data: ${data.error ?? data.status}`);
    results.push(...data.results.map(r => r.elevation ?? 920));
    if (i + BATCH < points.length) await new Promise(r => setTimeout(r, 1100)); // rate limit
  }
  return results;
}

function interpolateRoute(dist) {
  if (waypoints.length === 0) return { lat: state.lat, lng: state.lng, elevation: state.elevation };
  let lo = 0, hi = waypoints.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (waypoints[mid].cumDist <= dist) lo = mid; else hi = mid;
  }
  const p1 = waypoints[lo], p2 = waypoints[hi];
  if (p2.cumDist === p1.cumDist) return { lat: p1.lat, lng: p1.lng, elevation: p1.elevation };
  const t = (dist - p1.cumDist) / (p2.cumDist - p1.cumDist);
  return {
    lat:       p1.lat + t * (p2.lat - p1.lat),
    lng:       p1.lng + t * (p2.lng - p1.lng),
    elevation: p1.elevation + t * (p2.elevation - p1.elevation),
  };
}

function physicsStep(stepM, elevDelta) {
  const distKm = stepM / 1000;
  let energy   = distKm * BASE_KWH_KM;
  if (elevDelta > 0) {
    energy += (VEHICLE_KG * 9.81 * elevDelta) / 3_600_000;
  } else if (elevDelta < 0) {
    energy -= (VEHICLE_KG * 9.81 * Math.abs(elevDelta) * REGEN_EFF) / 3_600_000;
  }
  return Math.max(0, energy * drainMultiplier);
}

// Google encoded polyline decoder (precision 5)
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// ─── HTTP helpers (fire-and-forget — never block tick loop) ────────────────────
function postIngest(packet) {
  fetch(`${CONFIG.NEXT_URL}/api/vehicle/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(packet),
  }).catch(err => console.error('[ingest]', err.message));
}

function callGemma(anomalyType) {
  console.log(`[Gemma] → ${anomalyType} | soc=${state.soc.toFixed(1)}% drain=${(state.drainRate * 1000).toFixed(0)}Wh/km`);
  fetch(`${CONFIG.NEXT_URL}/api/vehicle/analyze`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ telemetry: { ...state }, anomalyType }),
  })
    .then(r => {
      const status = r.status;
      const ct = r.headers.get('content-type') ?? '';
      return r.text().then(text => {
        console.log(`[Gemma] ← HTTP ${status} | content-type: ${ct} | body[:120]: ${text.slice(0, 120).replace(/\n/g, ' ')}`);
        if (!ct.includes('application/json')) {
          console.error(`[Gemma] Non-JSON response — route not compiled or crashed. Status ${status}.`);
          return;
        }
        const d = JSON.parse(text);
        console.log(`[Gemma] ← ${anomalyType}: factor=${d.correction_factor} conf=${d.confidence} | ${d.reasoning}`);
      });
    })
    .catch(err => console.error('[Gemma]', err.message));
}

// ─── POINT_OF_NO_RETURN dynamic check ──────────────────────────────────────────
function checkPONR() {
  if (routeLength === 0 || state.drainRate <= 0) return false;
  const remainingKm  = (routeLength - distanceCovered) / 1000;
  const effectiveCap = BATTERY_KWH * (state.soh / 100);
  const remainingKwh = (state.soc / 100) * effectiveCap;
  const rangeKm      = remainingKwh / state.drainRate;
  return rangeKm < remainingKm * 1.10;
}

// Nominatim geocoder
async function geocodeQuery(query) {
  const res  = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
    { headers: { 'User-Agent': 'RangeShield-Sim' } }
  );
  const data = await res.json();
  if (!data?.length) throw new Error(`Geocode failed for: ${query}`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// ─── OSRM fetch + waypoint build ───────────────────────────────────────────────
async function fetchRoute() {
  console.log(`[Sim] Geocoding: "${CONFIG.ORIGIN_QUERY}" → "${CONFIG.DEST_QUERY}"`);
  const [o, d] = await Promise.all([
    geocodeQuery(CONFIG.ORIGIN_QUERY),
    geocodeQuery(CONFIG.DEST_QUERY),
  ]);

  // Update initial state position to geocoded origin
  state.lat = o.lat;
  state.lng = o.lng;

  const url =
    `http://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}` +
    `?overview=full&geometries=polyline`;

  console.log('[Sim] Fetching OSRM route...');
  const res  = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error(`OSRM error: ${data.code} — ${data.message ?? ''}`);

  const polyline = data.routes[0].geometry;
  const decoded  = decodePolyline(polyline);

  let cumDist = 0;
  waypoints = decoded.map(([lat, lng], i) => {
    if (i > 0) {
      const [pLat, pLng] = decoded[i - 1];
      cumDist += haversineM(pLat, pLng, lat, lng);
    }
    return { lat, lng, cumDist, elevation: 0 };
  });
  routeLength = waypoints[waypoints.length - 1]?.cumDist ?? 0;

  // Sample up to 100 evenly-spaced points → fetch real elevation → interpolate rest
  console.log('[Sim] Fetching elevation data from Open-Topo-Data...');
  try {
    const SAMPLE_COUNT  = Math.min(100, waypoints.length);
    const sampleIndices = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
      Math.round(i * (waypoints.length - 1) / (SAMPLE_COUNT - 1))
    );
    const samplePoints = sampleIndices.map(i => ({ lat: waypoints[i].lat, lng: waypoints[i].lng }));
    const elevations   = await fetchElevations(samplePoints);

    const elevSamples = sampleIndices.map((wi, si) => ({
      cumDist:   waypoints[wi].cumDist,
      elevation: elevations[si] ?? 920,
    }));

    waypoints = waypoints.map(p => ({
      ...p,
      elevation: parseFloat(interpolateElevation(p.cumDist, elevSamples).toFixed(1)),
    }));
    console.log('[Sim] Real elevation loaded via Open-Topo-Data (srtm30m).');
  } catch (err) {
    console.warn(`[Sim] Elevation fetch failed (${err.message}) — using simulated terrain.`);
    waypoints = waypoints.map(p => ({
      ...p,
      elevation: simulatedElevation(routeLength > 0 ? p.cumDist / routeLength : 0),
    }));
  }

  console.log(`[Sim] Route: ${waypoints.length} waypoints | ${(routeLength / 1000).toFixed(1)} km`);

  // Seed the Next.js simulator so the map polyline renders
  await fetch(`${CONFIG.NEXT_URL}/api/vehicle`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ encodedPolyline: polyline }),
  }).catch(err => console.warn('[Sim] Could not seed route to Next.js:', err.message));

  // Set starting position
  if (waypoints.length > 0) {
    state.lat       = waypoints[0].lat;
    state.lng       = waypoints[0].lng;
    state.elevation = waypoints[0].elevation;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await fetchRoute();

  console.log('[Sim] Starting tick loop (100ms). NEXT_URL:', CONFIG.NEXT_URL);
  console.log('[Sim] Triggers:', TRIGGER_POINTS.map(t => `${t.anomalyType}@${(t.fraction * 100).toFixed(0)}%`).join(' | '));

  const tickInterval = setInterval(() => {
    if (state.tripComplete) {
      clearInterval(tickInterval);
      postIngest({ ...state, anomaly_type: 'TRIP_END' });
      console.log('[Sim] Trip complete — TRIP_END sent.');
      setTimeout(() => process.exit(0), 500);
      return;
    }

    const stepM     = (state.speed / 3.6) * (TICK_MS / 1000);
    const prevDist  = distanceCovered;
    distanceCovered = Math.min(distanceCovered + stepM, routeLength);
    const fraction  = routeLength > 0 ? distanceCovered / routeLength : 0;

    // ── Deterministic fraction triggers ──────────────────────────────────────
    let anomalyType = null;
    for (const t of TRIGGER_POINTS) {
      if (!t.fired && fraction >= t.fraction) {
        t.fired     = true;
        anomalyType = t.anomalyType;
        if (t.overrides.temp             !== undefined) state.temp          = t.overrides.temp;
        if (t.overrides.tirePressure     !== undefined) state.tirePressure  = t.overrides.tirePressure;
        if (t.overrides.speed            !== undefined) state.speed         = t.overrides.speed;
        if (t.overrides.soh              !== undefined) state.soh           = t.overrides.soh;
        if (t.overrides.drainMultiplier  !== undefined) drainMultiplier     = t.overrides.drainMultiplier;
        console.log(`[Trigger] ${anomalyType} fired at ${(fraction * 100).toFixed(1)}% route`);
        callGemma(anomalyType);
        break;
      }
    }

    // ── Physics ───────────────────────────────────────────────────────────────
    const prev      = interpolateRoute(prevDist);
    const cur       = interpolateRoute(distanceCovered);
    const elevDelta = cur.elevation - prev.elevation;
    const energyKwh = physicsStep(stepM, elevDelta) * (anomalyType ? 1.4 : 1.0);
    const effCap    = BATTERY_KWH * (state.soh / 100);
    const socDrop   = (energyKwh / effCap) * 100;
    const drainRate = stepM > 0 ? energyKwh / (stepM / 1000) : state.drainRate;

    state = {
      ...state,
      lat:          parseFloat(cur.lat.toFixed(6)),
      lng:          parseFloat(cur.lng.toFixed(6)),
      elevation:    parseFloat(cur.elevation.toFixed(1)),
      soc:          parseFloat(Math.max(0, state.soc - socDrop).toFixed(3)),
      drainRate:    parseFloat(drainRate.toFixed(4)),
      anomalyType,
      tripComplete: distanceCovered >= routeLength,
      timestamp:    Date.now(),
    };

    // ── Guardian: RAPID_DRAIN (1.5× baseline sustained 3s) ───────────────────
    if (!rapidDrainFired && state.drainRate > BASE_KWH_KM * 1.5) {
      if (rapidDrainFirstMs === null) {
        rapidDrainFirstMs = Date.now();
      } else if (Date.now() - rapidDrainFirstMs >= 3000) {
        rapidDrainFired = true;
        console.log('[Guardian] RAPID_DRAIN threshold sustained 3s — firing');
        if (!anomalyType) { anomalyType = 'RAPID_DRAIN'; state = { ...state, anomalyType }; }
        callGemma('RAPID_DRAIN');
      }
    } else if (state.drainRate <= BASE_KWH_KM * 1.5) {
      rapidDrainFirstMs = null;
    }

    // ── POINT_OF_NO_RETURN (dynamic, no debounce, CRITICAL) ──────────────────
    if (!ponrFired && checkPONR()) {
      ponrFired = true;
      console.log('[Guardian] POINT_OF_NO_RETURN — CRITICAL, firing immediately');
      if (!anomalyType) { anomalyType = 'POINT_OF_NO_RETURN'; state = { ...state, anomalyType }; }
      callGemma('POINT_OF_NO_RETURN');
    }

    // ── Emit to Next.js ingest ────────────────────────────────────────────────
    postIngest({ ...state, anomaly_type: anomalyType });

    // ── Periodic Gemma health check (every 60s, skip if anomaly just fired) ──
    if (!anomalyType && Date.now() - lastGemmaMs >= 60_000) {
      lastGemmaMs = Date.now();
      callGemma('periodic_health');
    }

  }, TICK_MS);
}

main().catch(err => {
  console.error('[Sim] Fatal:', err.message);
  process.exit(1);
});
