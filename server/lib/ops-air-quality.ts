import { fetchJson } from './ops-geo-sources.js';

export interface AirQualityBounds {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

export interface AirQualityPoint {
  lat: number;
  lng: number;
  usAqi: number | null;
  europeanAqi: number | null;
  observedAt?: string;
  band: 'good' | 'moderate' | 'usg' | 'unhealthy' | 'very-unhealthy' | 'hazardous' | 'unknown';
}

export interface AirQualitySnapshot {
  sourceName: string;
  sourceLabel: string;
  sourceUrl: string;
  dataSource: string;
  generatedAt: string;
  points: AirQualityPoint[];
  emptyReason?: string;
}

function gridSizeForZoom(zoom: number) {
  if (zoom >= 10) return { columns: 8, rows: 6 };
  if (zoom >= 8) return { columns: 7, rows: 5 };
  if (zoom >= 6) return { columns: 6, rows: 4 };
  return { columns: 5, rows: 3 };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildGrid(bounds: AirQualityBounds) {
  const columns = gridSizeForZoom(bounds.zoom).columns;
  const rows = gridSizeForZoom(bounds.zoom).rows;
  const latSpan = bounds.north - bounds.south;
  const lngSpan = bounds.east - bounds.west;
  if (!Number.isFinite(latSpan) || !Number.isFinite(lngSpan) || latSpan <= 0 || lngSpan <= 0) return [];

  const points: Array<{ lat: number; lng: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    const lat = bounds.south + ((row + 0.5) / rows) * latSpan;
    for (let column = 0; column < columns; column += 1) {
      const lng = bounds.west + ((column + 0.5) / columns) * lngSpan;
      points.push({
        lat: clamp(lat, -89.9, 89.9),
        lng: clamp(lng, -179.9, 179.9),
      });
    }
  }

  return points;
}

function classifyAqi(value: number | null): AirQualityPoint['band'] {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value <= 50) return 'good';
  if (value <= 100) return 'moderate';
  if (value <= 150) return 'usg';
  if (value <= 200) return 'unhealthy';
  if (value <= 300) return 'very-unhealthy';
  return 'hazardous';
}

function normalizeUtcTime(value: string | undefined) {
  if (!value) return undefined;
  const withTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(withTimezone);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export async function fetchAirQualityOverlay(bounds: AirQualityBounds): Promise<AirQualitySnapshot> {
  const grid = buildGrid(bounds);
  if (!grid.length) {
    return {
      sourceName: 'Open-Meteo Air Quality API',
      sourceLabel: 'Air Quality / AQI',
      sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api',
      dataSource: 'CAMS global air quality forecast, sampled across the visible map bounds.',
      generatedAt: new Date().toISOString(),
      points: [],
      emptyReason: 'Unable to build an AQI sample grid for the current map bounds.',
    };
  }

  const latitude = grid.map((point) => point.lat.toFixed(4)).join(',');
  const longitude = grid.map((point) => point.lng.toFixed(4)).join(',');
  const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
  url.searchParams.set('latitude', latitude);
  url.searchParams.set('longitude', longitude);
  url.searchParams.set('current', 'us_aqi,european_aqi');
  url.searchParams.set('domains', 'auto');
  url.searchParams.set('timezone', 'UTC');

  const payload = await fetchJson(url.toString());
  const results = Array.isArray(payload) ? payload : [payload];

  const points = results.map((entry, index) => {
    const current = typeof entry === 'object' && entry && !Array.isArray(entry) ? (entry as Record<string, unknown>).current as Record<string, unknown> | undefined : undefined;
    const currentTime = current && typeof current.time === 'string' ? current.time : undefined;
    const usAqi = current?.us_aqi == null ? null : Number(current.us_aqi);
    const europeanAqi = current?.european_aqi == null ? null : Number(current.european_aqi);
    const aqi = Number.isFinite(usAqi ?? NaN) ? usAqi : europeanAqi;
    return {
      lat: grid[index]?.lat ?? 0,
      lng: grid[index]?.lng ?? 0,
      usAqi: Number.isFinite(usAqi ?? NaN) ? usAqi : null,
      europeanAqi: Number.isFinite(europeanAqi ?? NaN) ? europeanAqi : null,
      observedAt: normalizeUtcTime(currentTime),
      band: classifyAqi(aqi ?? null),
    };
  });

  const nonEmptyPoints = points.filter((point) => point.usAqi != null || point.europeanAqi != null);
  return {
    sourceName: 'Open-Meteo Air Quality API',
    sourceLabel: 'Air Quality / AQI',
    sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api',
    dataSource: 'Open-Meteo CAMS global air quality forecast (US AQI / European AQI).',
    generatedAt: new Date().toISOString(),
    points: nonEmptyPoints.length ? nonEmptyPoints : points,
    emptyReason: nonEmptyPoints.length ? undefined : 'No current AQI values were returned for the visible map bounds.',
  };
}
