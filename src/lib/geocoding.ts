export interface GeocodeResult {
    lat: string;
    lon: string;
    display_name: string;
}

export async function searchCity(query: string): Promise<GeocodeResult | null> {
    if (!query || query.trim().length < 3) return null;

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'RangeShield-Hackathon-App' // Required by OSM
            }
        });

        if (!res.ok) {
            console.error('Geocoding fetch failed:', res.statusText);
            return null;
        }

        const data = await res.json();
        if (data.length > 0) {
            return {
                lat: data[0].lat,
                lon: data[0].lon,
                display_name: data[0].display_name
            };
        }
    } catch (error) {
        console.error('Error searching city:', error);
    }
    return null;
}
