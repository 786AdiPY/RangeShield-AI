export interface WeatherData {
    temperature: number;
    windSpeed: number;
    weatherCode: number;
}

export async function fetchWeather(lat: number, lon: number): Promise<WeatherData | null> {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

        const res = await fetch(url);

        if (!res.ok) {
            console.error('Weather fetch failed:', res.statusText);
            return null;
        }

        const data = await res.json();

        if (data.current_weather) {
            return {
                temperature: data.current_weather.temperature,
                windSpeed: data.current_weather.windspeed,
                weatherCode: data.current_weather.weathercode
            };
        }
    } catch (error) {
        console.error('Error fetching weather:', error);
    }
    return null;
}
