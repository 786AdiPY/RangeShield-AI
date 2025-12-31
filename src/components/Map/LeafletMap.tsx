"use client";

import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useState } from 'react';
import { decodePolyline } from '@/lib/polyline';

// Fix for default Leaflet markers in Next.js/Webpack
const iconUrl = 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png';
const iconRetinaUrl = 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png';
const shadowUrl = 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png';

// Icon configuration moved to useEffect to avoid SSR/Global issues

interface MapProps {
    encodedPolyline?: string;
    startPos?: { lat: number, lon: number };
    endPos?: { lat: number, lon: number };
    chargingStations?: any[]; // Array of OCM stations
}

// Component to handle map view updates
function MapUpdater({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
    const map = useMap();
    useEffect(() => {
        if (bounds) {
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }, [bounds, map]);
    return null;
}

const MainMap = ({ encodedPolyline, startPos, endPos, chargingStations }: MapProps) => {
    const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
    const [bounds, setBounds] = useState<L.LatLngBoundsExpression | null>(null);

    // Safe Icon Initialization for Next.js
    useEffect(() => {
        // Only run on client
        const fixLeafletIcons = async () => {
            const L = (await import('leaflet')).default;
            // @ts-ignore
            delete L.Icon.Default.prototype._getIconUrl;
            L.Icon.Default.mergeOptions({
                iconRetinaUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon-2x.png',
                iconUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-icon.png',
                shadowUrl: 'https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png',
            });
        };
        fixLeafletIcons();
    }, []);

    useEffect(() => {
        if (encodedPolyline) {
            try {
                const decoded = decodePolyline(encodedPolyline);
                // Filter out invalid points
                const validPoints = decoded.filter(p => !isNaN(p[0]) && !isNaN(p[1]));
                setRouteCoords(validPoints);

                if (validPoints.length > 0) {
                    // L is imported at top level, but let's be safe with bounds creation
                    const latLngs = validPoints.map(p => [p[0], p[1]] as [number, number]);
                    const b = L.latLngBounds(latLngs);
                    setBounds(b);
                }
            } catch (e) {
                console.error("Failed to decode polyline", e);
            }
        }
    }, [encodedPolyline]);

    // Validate positions
    const validStart = startPos && !isNaN(startPos.lat) && !isNaN(startPos.lon);
    const validEnd = endPos && !isNaN(endPos.lat) && !isNaN(endPos.lon);

    // Default center (SF)
    const center: [number, number] = (validStart && startPos) ? [startPos.lat, startPos.lon] : [37.7749, -122.4194];

    return (
        <MapContainer
            center={center}
            zoom={13}
            scrollWheelZoom={true}
            style={{ height: "100%", width: "100%", background: '#1a1a1a' }}
        >
            {/* CartoDB Dark Matter Tiles for Cyberpunk look */}
            <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {routeCoords.length > 0 && (
                <Polyline
                    positions={routeCoords}
                    pathOptions={{
                        color: '#3b82f6', // Neon Blue
                        weight: 5,
                        opacity: 0.8,
                        lineJoin: 'round'
                    }}
                />
            )}

            {validStart && startPos && (
                <Marker position={[startPos.lat, startPos.lon]}>
                    <Popup className="text-black">Start Point</Popup>
                </Marker>
            )}

            {validEnd && endPos && (
                <Marker position={[endPos.lat, endPos.lon]}>
                    <Popup className="text-black">Destination</Popup>
                </Marker>
            )}

            {chargingStations && chargingStations.map((station: any, idx: number) => (
                <Marker
                    key={station.ID || idx}
                    position={[station.AddressInfo.Latitude, station.AddressInfo.Longitude]}
                >
                    <Popup className="text-black">
                        <div className="font-bold">{station.AddressInfo.Title}</div>
                        <div className="text-xs">{station.AddressInfo.Distance?.toFixed(1)} km away</div>
                    </Popup>
                </Marker>
            ))}

            <MapUpdater bounds={bounds} />
        </MapContainer>
    );
};

export default MainMap;
