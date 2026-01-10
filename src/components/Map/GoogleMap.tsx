import React, { useCallback, useMemo, useState } from 'react';
import { GoogleMap, useJsApiLoader, Polyline, Marker } from '@react-google-maps/api';

interface Station {
    ID: number;
    AddressInfo: {
        Latitude: number;
        Longitude: number;
        Title?: string;
    };
}

interface GoogleMapProps {
    encodedPolyline?: string;
    startPos?: { lat: number; lon: number };
    endPos?: { lat: number; lon: number };
    chargingStations?: Station[];
    tilt?: number;
    heading?: number;
    vehiclePosition?: { lat: number; lng: number; heading: number };
}

const containerStyle = {
    width: '100%',
    height: '100%'
};

// Dark Mode Map Styles (Base)
const baseMapOptions: google.maps.MapOptions = {
    disableDefaultUI: true,
    zoomControl: false, // Cleaner cockpit UI
    styles: [
        { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
        {
            featureType: "administrative.locality",
            elementType: "labels.text.fill",
            stylers: [{ color: "#d59563" }],
        },
        {
            featureType: "poi",
            elementType: "labels.text.fill",
            stylers: [{ color: "#d59563" }],
        },
        {
            featureType: "poi.park",
            elementType: "geometry",
            stylers: [{ color: "#263c3f" }],
        },
        {
            featureType: "poi.park",
            elementType: "labels.text.fill",
            stylers: [{ color: "#6b9a76" }],
        },
        {
            featureType: "road",
            elementType: "geometry",
            stylers: [{ color: "#38414e" }],
        },
        {
            featureType: "road",
            elementType: "geometry.stroke",
            stylers: [{ color: "#212a37" }],
        },
        {
            featureType: "road",
            elementType: "labels.text.fill",
            stylers: [{ color: "#9ca5b3" }],
        },
        {
            featureType: "road.highway",
            elementType: "geometry",
            stylers: [{ color: "#746855" }],
        },
        {
            featureType: "road.highway",
            elementType: "geometry.stroke",
            stylers: [{ color: "#1f2835" }],
        },
        {
            featureType: "road.highway",
            elementType: "labels.text.fill",
            stylers: [{ color: "#f3d19c" }],
        },
        {
            featureType: "transit",
            elementType: "geometry",
            stylers: [{ color: "#2f3948" }],
        },
        {
            featureType: "transit.station",
            elementType: "labels.text.fill",
            stylers: [{ color: "#d59563" }],
        },
        {
            featureType: "water",
            elementType: "geometry",
            stylers: [{ color: "#17263c" }],
        },
        {
            featureType: "water",
            elementType: "labels.text.fill",
            stylers: [{ color: "#515c6d" }],
        },
        {
            featureType: "water",
            elementType: "labels.text.stroke",
            stylers: [{ color: "#17263c" }],
        }
    ]
};

// SVG Icon for Green Bolt
// SVG Icon for Green Pin with Bolt (Matches User Request)
const greenBoltIcon = {
    path: "M 12 2 C 8.13 2 5 5.13 5 9 c 0 5.25 7 13 7 13 s 7 -7.75 7 -13 c 0 -3.87 -3.13 -7 -7 -7 Z M 11.5 14.5 L 11.5 10 L 8.5 10 L 13.5 4 L 13.5 8 L 16.5 8 L 11.5 14.5 Z",
    fillColor: "#4CAF50",
    fillOpacity: 1,
    strokeWeight: 1,
    strokeColor: "#1B5E20",
    rotation: 0,
    scale: 1.5,
    anchor: { x: 12, y: 22 }
};

// Navigation Arrow Icon (Blue triangle pointer like Google Maps)
const createNavigationArrowIcon = (heading: number): google.maps.Symbol => ({
    path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
    fillColor: "#4285F4",
    fillOpacity: 1,
    strokeColor: "#1a73e8",
    strokeWeight: 2,
    scale: 8,
    rotation: heading,
    anchor: new google.maps.Point(0, 2.5)
});

const libraries: ("geometry" | "drawing" | "places" | "visualization")[] = ['geometry'];

function GoogleMapComponent({ encodedPolyline, startPos, endPos, chargingStations = [], tilt = 0, heading = 0, vehiclePosition }: GoogleMapProps) {
    const { isLoaded } = useJsApiLoader({
        id: 'google-map-script',
        googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '',
        libraries
    });

    const [map, setMap] = useState<google.maps.Map | null>(null);

    // Apply tilt once when navigation starts (prevent shaking)
    React.useEffect(() => {
        if (map && tilt > 0) {
            // Set tilt and zoom once for navigation mode
            map.setTilt(45);
            map.setZoom(17);
        } else if (map && tilt === 0) {
            map.setTilt(0);
        }
    }, [map, tilt]);

    // Smooth camera follow for vehicle position (no heading rotation to prevent shaking)
    React.useEffect(() => {
        if (map && vehiclePosition) {
            // Only pan to vehicle position - arrow marker shows direction
            map.panTo({ lat: vehiclePosition.lat, lng: vehiclePosition.lng });
            // Note: Heading rotation removed to prevent map shaking
        }
    }, [map, vehiclePosition]);

    const onLoad = useCallback(function callback(map: google.maps.Map) {
        setMap(map);
    }, []);

    const onUnmount = useCallback(function callback(map: google.maps.Map) {
        setMap(null);
    }, []);

    // Decode polyline
    const path = useMemo(() => {
        if (!encodedPolyline || !window.google) return [];
        return google.maps.geometry.encoding.decodePath(encodedPolyline);
    }, [encodedPolyline]);

    // Fit bounds when path changes
    React.useEffect(() => {
        if (map && path.length > 0) {
            const bounds = new google.maps.LatLngBounds();
            path.forEach(p => bounds.extend(p));
            if (startPos) bounds.extend({ lat: startPos.lat, lng: startPos.lon });
            if (endPos) bounds.extend({ lat: endPos.lat, lng: endPos.lon });
            map.fitBounds(bounds);
        } else if (map && startPos) {
            map.panTo({ lat: startPos.lat, lng: startPos.lon });
            map.setZoom(12);
        }
    }, [map, path, startPos, endPos]);

    if (!isLoaded) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                <span className="text-sm font-mono animate-pulse">LOADING GOOGLE MAPS...</span>
            </div>
        );
    }

    return (
        <GoogleMap
            mapContainerStyle={containerStyle}
            center={startPos ? { lat: startPos.lat, lng: startPos.lon } : { lat: 37.7749, lng: -122.4194 }}
            zoom={10}
            onLoad={onLoad}
            onUnmount={onUnmount}
            options={baseMapOptions}
        >
            {/* Route Polyline */}
            {path.length > 0 && (
                <Polyline
                    path={path}
                    options={{
                        strokeColor: "#3b82f6", // Blue-500
                        strokeOpacity: 1,
                        strokeWeight: 5,
                    }}
                />
            )}

            {/* Start Marker */}
            {(startPos || path.length > 0) && (
                <Marker
                    position={startPos ? { lat: startPos.lat, lng: startPos.lon } : path[0]}
                    label="S"
                    title="Start"
                />
            )}

            {/* End Marker */}
            {(endPos || path.length > 0) && (
                <Marker
                    position={endPos ? { lat: endPos.lat, lng: endPos.lon } : path[path.length - 1]}
                    label="D"
                    title="Destination"
                />
            )}

            {/* Vehicle Navigation Pointer */}
            {vehiclePosition && (
                <Marker
                    position={{ lat: vehiclePosition.lat, lng: vehiclePosition.lng }}
                    icon={createNavigationArrowIcon(vehiclePosition.heading)}
                    title="Your Vehicle"
                    zIndex={1000}
                />
            )}

            {/* Charging Stations */}
            {chargingStations.map(station => (
                <Marker
                    key={station.ID}
                    position={{
                        lat: station.AddressInfo.Latitude,
                        lng: station.AddressInfo.Longitude
                    }}
                    icon={greenBoltIcon as any} // Cast as any if type complains about custom object structure with SVG
                    title={station.AddressInfo.Title || "Charging Station"}
                />
            ))}
        </GoogleMap>
    );
}

export default React.memo(GoogleMapComponent);
