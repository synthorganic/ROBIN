import { createHash } from 'node:crypto';
import type { OpsMapAsset } from './ops-map-store.js';

export type OpsGeoSourceId =
  | 'gdelt'
  | 'gdacs'
  | 'usgs'
  | 'nws'
  | 'firms'
  | 'radnet'
  | 'trafficcams'
  | 'trackedflights'
  | 'eurdep'
  | 'safecast'
  | 'gmcmap'
  | 'nrcevents'
  | 'nrcreactorstatus'
  | 'ntad'
  | 'faf'
  | 'marinecadastre'
  | 'mobilitydb'
  | 'tigerline';

export interface OpsGeoSourceStatus {
  id: OpsGeoSourceId;
  name: string;
  category: 'news' | 'disaster' | 'seismic' | 'weather' | 'fire' | 'nuclear' | 'transport' | 'freight' | 'maritime' | 'mobility' | 'reference';
  enabled: boolean;
  ok: boolean;
  stale: boolean;
  catalogOnly?: boolean;
  itemCount: number;
  refreshSeconds: number;
  lastFetchedAt?: string;
  lastError?: string;
  attribution: string;
  requiresKey?: boolean;
  description?: string;
}

export interface OpsGeoSourceSnapshot {
  assets: OpsMapAsset[];
  sources: OpsGeoSourceStatus[];
  fetchedAt: string;
}

interface SourceDefinition {
  id: OpsGeoSourceId;
  name: string;
  category: OpsGeoSourceStatus['category'];
  refreshSeconds: number;
  attribution: string;
  requiresKey?: boolean;
  catalogOnly?: boolean;
  description?: string;
  isEnabled?: () => boolean;
  disabledReason?: string;
  fetch: () => Promise<OpsMapAsset[]>;
}

interface SourceRunResult {
  status: OpsGeoSourceStatus;
  assets: OpsMapAsset[];
}

const DEFAULT_TIMEOUT_MS = Number(process.env.INERTIAI_OPS_GEO_TIMEOUT_MS || 12_000);
const DEFAULT_CACHE_MS = Number(process.env.INERTIAI_OPS_GEO_CACHE_MS || 5 * 60_000);
const USER_AGENT = process.env.INERTIAI_OPS_USER_AGENT || 'ROBIN/1.5 ops-map (local operator dashboard)';
const ONE_DAY_SECONDS = 24 * 60 * 60;

function stableId(sourceId: OpsGeoSourceId, parts: Array<string | number | undefined | null>) {
  const hash = createHash('sha1')
    .update(parts.map((part) => String(part ?? '')).join('|'))
    .digest('hex')
    .slice(0, 14);
  return `source-${sourceId}-${hash}`;
}

function cleanText(value: unknown, fallback = '') {
  if (value == null) return fallback;
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
}

function truncate(value: string, max = 520) {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function parseNumber(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pointFromGeometry(geometry: unknown): { lat: number; lng: number } | null {
  if (!isRecord(geometry)) return null;
  const type = String(geometry.type ?? '');
  const coordinates = geometry.coordinates;

  if (type === 'Point' && Array.isArray(coordinates)) {
    const lng = parseNumber(coordinates[0]);
    const lat = parseNumber(coordinates[1]);
    return lat == null || lng == null ? null : { lat, lng };
  }

  if (type === 'MultiPoint' && Array.isArray(coordinates)) {
    return averageCoordinatePairs(coordinates);
  }

  if (type === 'Polygon' && Array.isArray(coordinates)) {
    return averageCoordinatePairs(asArray(coordinates[0]));
  }

  if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
    const pairs = coordinates.flatMap((polygon) => asArray(asArray(polygon)[0]));
    return averageCoordinatePairs(pairs);
  }

  if (type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    for (const child of geometry.geometries) {
      const point = pointFromGeometry(child);
      if (point) return point;
    }
  }

  return null;
}

function averageCoordinatePairs(pairs: unknown[]) {
  const points = pairs
    .map((pair) => {
      if (!Array.isArray(pair)) return null;
      const lng = parseNumber(pair[0]);
      const lat = parseNumber(pair[1]);
      return lat == null || lng == null ? null : { lat, lng };
    })
    .filter((point): point is { lat: number; lng: number } => Boolean(point));

  if (!points.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json, application/json, application/xml, text/csv, text/plain;q=0.9, */*;q=0.8',
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }
    return response;
  } catch (error) {
    const host = new URL(url).hostname;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out fetching ${host}`);
    }
    if (error instanceof Error) {
      throw new Error(`${host}: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url: string) {
  const response = await fetchWithTimeout(url);
  return response.json() as Promise<unknown>;
}

async function fetchText(url: string) {
  const response = await fetchWithTimeout(url);
  return response.text();
}

function sourceAsset(
  sourceId: OpsGeoSourceId,
  input: Omit<OpsMapAsset, 'id' | 'type' | 'tags'> & {
    idParts: Array<string | number | undefined | null>;
    tags?: string[];
    type?: OpsMapAsset['type'];
  },
): OpsMapAsset {
  return {
    id: stableId(sourceId, input.idParts),
    type: input.type ?? 'link',
    title: cleanText(input.title, `${sourceId.toUpperCase()} signal`),
    lat: input.lat,
    lng: input.lng,
    sourceUrl: input.sourceUrl,
    streamUrl: input.streamUrl,
    thumbnailUrl: input.thumbnailUrl,
    notes: input.notes ? truncate(cleanText(input.notes), 800) : undefined,
    tags: Array.from(new Set([sourceId, ...(input.tags ?? [])].map((tag) => tag.toLowerCase()).filter(Boolean))),
    status: input.status,
    linkedSessionId: input.linkedSessionId,
    sourceId,
    sourceName: input.sourceName,
    severity: input.severity,
    confidence: input.confidence,
    observedAt: input.observedAt,
    live: true,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    heading: input.heading,
    speed: input.speed,
    altitude: input.altitude,
    trail: input.trail,
  };
}

function severityFromGdacsAlert(alertLevel: string): OpsMapAsset['severity'] {
  const normalized = alertLevel.toLowerCase();
  if (normalized.includes('red')) return 'critical';
  if (normalized.includes('orange')) return 'warning';
  if (normalized.includes('green')) return 'watch';
  return 'info';
}

function severityFromNws(severity: string): OpsMapAsset['severity'] {
  const normalized = severity.toLowerCase();
  if (normalized === 'extreme') return 'critical';
  if (normalized === 'severe') return 'warning';
  if (normalized === 'moderate') return 'watch';
  return 'info';
}

function earthquakeSeverity(mag: number | null, alert: unknown): OpsMapAsset['severity'] {
  const alertText = String(alert ?? '').toLowerCase();
  if (alertText === 'red' || alertText === 'orange' || (mag != null && mag >= 6.5)) return 'critical';
  if (alertText === 'yellow' || (mag != null && mag >= 5.5)) return 'warning';
  return 'watch';
}

function parseGdeltDate(value: unknown) {
  const raw = String(value ?? '');
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))).toISOString();
}

function splitList(value: unknown) {
  return String(value ?? '')
    .split(/[;,|\t]/)
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

interface GeoPoint {
  lat: number;
  lng: number;
  sourceLabel?: string;
}

const locationGeocodeCache = new Map<string, Promise<GeoPoint | null>>();
const locationGeocodeResultCache = new Map<string, GeoPoint | null>();

function locationKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseGeoPointFromNominatim(payload: unknown): GeoPoint | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const candidate = payload[0];
  if (!isRecord(candidate)) return null;
  const lat = parseNumber(candidate.lat);
  const lng = parseNumber(candidate.lon ?? candidate.lng);
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    sourceLabel: cleanText(candidate.display_name || candidate.name),
  };
}

function parseGeoPointFromOpenMeteo(payload: unknown): GeoPoint | null {
  if (!isRecord(payload)) return null;
  const results = asArray(payload.results);
  if (!results.length) return null;
  const candidate = results[0];
  if (!isRecord(candidate)) return null;
  const lat = parseNumber(candidate.latitude);
  const lng = parseNumber(candidate.longitude);
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    sourceLabel: cleanText(candidate.name || candidate.admin1 || candidate.country),
  };
}

async function geocodeQuery(query: string): Promise<GeoPoint | null> {
  const normalized = locationKey(query);
  if (!normalized) return null;
  if (locationGeocodeResultCache.has(normalized)) return locationGeocodeResultCache.get(normalized) ?? null;
  if (locationGeocodeCache.has(normalized)) return locationGeocodeCache.get(normalized) ?? null;

  const promise = (async () => {
    const encoded = encodeURIComponent(query);

    try {
      const nominatim = await fetchJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encoded}`);
      const point = parseGeoPointFromNominatim(nominatim);
      if (point) return point;
    } catch {
      // fall through to Open-Meteo geocoding
    }

    try {
      const openMeteo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encoded}&count=1&language=en&format=json`);
      const point = parseGeoPointFromOpenMeteo(openMeteo);
      if (point) return point;
    } catch {
      // ignore geocoding fallback failures
    }

    return null;
  })();

  locationGeocodeCache.set(normalized, promise);
  const result = await promise;
  locationGeocodeResultCache.set(normalized, result);
  return result;
}

function parseNrcDateTime(dateText: string, timeText: string) {
  const dateMatch = String(dateText || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const timeMatch = String(timeText || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!dateMatch || !timeMatch) return undefined;

  const [, month, day, year] = dateMatch;
  const [, hourText, minuteText, secondText] = timeMatch;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  const date = new Date(Number(year), Number(month) - 1, Number(day), hour, minute, second);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function splitNrcEventRecords(text: string) {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const header = lines[0] ?? '';
  const records: string[][] = [];
  let current: string[] = [];

  for (const line of lines.slice(1)) {
    if (/^[A-Za-z][^|]*\|\d+\|/.test(line)) {
      if (current.length) records.push(current);
      current = [line];
      continue;
    }

    if (!current.length) continue;
    current.push(line);
  }

  if (current.length) records.push(current);
  return { header, records };
}

function parseNrcEventRecord(recordLines: string[], headerIndex: Record<string, number>) {
  const firstLine = recordLines[0] ?? '';
  const values = firstLine.split('|');
  const value = (name: string) => cleanText(values[headerIndex[name]] ?? '');
  const eventDesc = value('Event Desc');
  const eventNo = value('En No');
  const siteName = value('Site Name');
  const licenseeName = value('Licensee Name');
  const cityName = value('City Name');
  const stateCd = value('State Cd');
  const notificationDt = value('Notification Dt');
  const notificationTime = value('Notification Time');
  const eventDt = value('Event Dt');
  const eventTime = value('Event Time');
  const emergencyClass = value('Emergency Class');
  const eventText = [values.slice(headerIndex['Event Text'] >= 0 ? headerIndex['Event Text'] : values.length).join('|'), ...recordLines.slice(1)]
    .join(' ')
    .trim();

  return {
    eventDesc,
    eventNo,
    siteName,
    licenseeName,
    cityName,
    stateCd,
    notificationDt,
    notificationTime,
    eventDt,
    eventTime,
    emergencyClass,
    eventText,
  };
}

function hostnameFromUrl(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function fetchGdeltAssets(): Promise<OpsMapAsset[]> {
  const endpoint = process.env.INERTIAI_OPS_GDELT_URL || 'https://api.gdeltproject.org/api/v1/gkg_geojson';
  const query = process.env.INERTIAI_OPS_GDELT_QUERY || 'EARTHQUAKE,FLOOD,WILDFIRE,CYCLONE,TERROR,EXPLOSION,DISEASE';
  const timespan = process.env.INERTIAI_OPS_GDELT_TIMESPAN || '180';
  const maxRows = process.env.INERTIAI_OPS_GDELT_MAXROWS || '80';
  const params = new URLSearchParams({
    QUERY: query,
    TIMESPAN: timespan,
    MAXROWS: maxRows,
    OUTPUTFIELDS: 'name,geores,url,domain,sharingimage,lang,tone,themes,names',
  });
  const payload = await fetchJson(`${endpoint}?${params.toString()}`);
  const features = isRecord(payload) ? asArray(payload.features) : [];

  return features
    .map((feature) => {
      if (!isRecord(feature)) return null;
      const point = pointFromGeometry(feature.geometry);
      if (!point || !isRecord(feature.properties)) return null;
      const props = feature.properties;
      const url = cleanText(props.url || props.oneurl || splitList(props.allurls)[0] || 'https://www.gdeltproject.org/');
      const locationName = cleanText(props.name || props.location || props.geoname || props.domain, 'Mapped news location');
      const domain = cleanText(props.domain || hostnameFromUrl(url), 'unknown source');
      const themes = splitList(props.mentionedthemes || props.allmentionedthemes).slice(0, 5);
      const names = splitList(props.mentionednames || props.allmentionednames).slice(0, 5);
      const observedAt = parseGdeltDate(props.urlpubtimedate);

      return sourceAsset('gdelt', {
        idParts: [url, locationName, observedAt, point.lat, point.lng],
        title: `GDELT: ${locationName}`,
        lat: point.lat,
        lng: point.lng,
        sourceUrl: url,
        thumbnailUrl: cleanText(props.urlsocialimage || props.oneurlsocialimage),
        notes: [
          `News geography from ${domain}.`,
          themes.length ? `Themes: ${themes.join(', ')}` : '',
          names.length ? `Names: ${names.join(', ')}` : '',
        ].filter(Boolean).join(' '),
        tags: ['news', 'event-awareness', ...themes.map((theme) => theme.toLowerCase())],
        status: domain,
        sourceName: 'GDELT',
        severity: 'info',
        confidence: 'medium',
        observedAt,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset));
}

function xmlDecode(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tagValue(block: string, tagName: string) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? cleanText(xmlDecode(match[1])) : '';
}

async function fetchGdacsAssets(): Promise<OpsMapAsset[]> {
  const endpoint = process.env.INERTIAI_OPS_GDACS_URL || 'https://www.gdacs.org/xml/rss.xml';
  const raw = await fetchText(endpoint);
  const itemBlocks = raw.match(/<item[\s\S]*?<\/item>/gi) ?? [];

  return itemBlocks
    .map((block) => {
      const point = tagValue(block, 'georss:point') || [tagValue(block, 'geo:lat'), tagValue(block, 'geo:long')].filter(Boolean).join(' ');
      const [latRaw, lngRaw] = point.split(/\s+/);
      const lat = parseNumber(latRaw);
      const lng = parseNumber(lngRaw);
      if (lat == null || lng == null) return null;

      const title = tagValue(block, 'title') || 'GDACS disaster alert';
      const link = tagValue(block, 'link') || 'https://www.gdacs.org/';
      const alertLevel = tagValue(block, 'gdacs:alertlevel') || title.split(/\s+/)[0] || 'Alert';
      const eventType = tagValue(block, 'gdacs:eventtype') || 'disaster';
      const pubDate = tagValue(block, 'pubDate');
      const observedAt = pubDate ? new Date(pubDate).toISOString() : undefined;

      return sourceAsset('gdacs', {
        idParts: [link, title, observedAt, lat, lng],
        title,
        lat,
        lng,
        sourceUrl: link,
        notes: tagValue(block, 'description'),
        tags: ['disaster', eventType.toLowerCase(), alertLevel.toLowerCase()],
        status: `${alertLevel} ${eventType}`.trim(),
        sourceName: 'GDACS',
        severity: severityFromGdacsAlert(alertLevel),
        confidence: 'high',
        observedAt,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset));
}

async function fetchUsgsAssets(): Promise<OpsMapAsset[]> {
  const endpoint = process.env.INERTIAI_OPS_USGS_URL || 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
  const payload = await fetchJson(endpoint);
  const features = isRecord(payload) ? asArray(payload.features) : [];

  return features
    .map((feature) => {
      if (!isRecord(feature)) return null;
      const point = pointFromGeometry(feature.geometry);
      if (!point || !isRecord(feature.properties)) return null;
      const props = feature.properties;
      const mag = parseNumber(props.mag);
      const place = cleanText(props.place, 'unknown location');
      const time = parseNumber(props.time);
      const observedAt = time == null ? undefined : new Date(time).toISOString();
      const url = cleanText(props.url || 'https://earthquake.usgs.gov/earthquakes/map/');
      const tsunami = Number(props.tsunami ?? 0) > 0;

      return sourceAsset('usgs', {
        idParts: [cleanText(feature.id), url, observedAt, point.lat, point.lng],
        title: `USGS M${mag?.toFixed(1) ?? '?'}: ${place}`,
        lat: point.lat,
        lng: point.lng,
        sourceUrl: url,
        notes: `Magnitude ${mag ?? 'unknown'} earthquake. Status: ${cleanText(props.status, 'unknown')}. ${tsunami ? 'Tsunami flag present.' : ''}`,
        tags: ['earthquake', 'seismic', tsunami ? 'tsunami' : ''],
        status: cleanText(props.alert, mag == null ? 'earthquake' : `M${mag.toFixed(1)}`),
        sourceName: 'USGS',
        severity: earthquakeSeverity(mag, props.alert),
        confidence: 'high',
        observedAt,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset));
}

async function fetchNwsAssets(): Promise<OpsMapAsset[]> {
  const endpoint = process.env.INERTIAI_OPS_NWS_URL || 'https://api.weather.gov/alerts/active?status=actual&message_type=alert';
  const payload = await fetchJson(endpoint);
  const features = isRecord(payload) ? asArray(payload.features) : [];
  const limit = Number(process.env.INERTIAI_OPS_NWS_LIMIT || 100);

  return features
    .map((feature) => {
      if (!isRecord(feature) || !isRecord(feature.properties)) return null;
      const point = pointFromGeometry(feature.geometry);
      if (!point) return null;
      const props = feature.properties;
      const event = cleanText(props.event, 'Weather alert');
      const area = cleanText(props.areaDesc, 'affected area');
      const severity = cleanText(props.severity, 'Unknown');
      const certainty = cleanText(props.certainty, 'Unknown');
      const urgency = cleanText(props.urgency, 'Unknown');
      const observedAt = cleanText(props.effective || props.sent) || undefined;
      const url = cleanText(feature.id || props['@id'] || 'https://api.weather.gov/alerts/active');

      return sourceAsset('nws', {
        idParts: [url, event, area, observedAt],
        title: `NWS ${event}: ${area}`,
        lat: point.lat,
        lng: point.lng,
        sourceUrl: url,
        notes: truncate(cleanText(props.description || props.headline || props.instruction), 700),
        tags: ['weather', event.toLowerCase(), severity.toLowerCase(), urgency.toLowerCase(), certainty.toLowerCase()],
        status: `${severity} / ${urgency}`,
        sourceName: 'NOAA/NWS',
        severity: severityFromNws(severity),
        confidence: certainty.toLowerCase() === 'observed' || certainty.toLowerCase() === 'likely' ? 'high' : 'medium',
        observedAt,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset))
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, limit);
}

function severityRank(severity: OpsMapAsset['severity']) {
  switch (severity) {
    case 'critical': return 4;
    case 'warning': return 3;
    case 'watch': return 2;
    default: return 1;
  }
}

function firmsMapKey() {
  return process.env.FIRMS_MAP_KEY || process.env.NASA_FIRMS_MAP_KEY || process.env.MAP_KEY || '';
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((entry) => entry.trim())) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some((entry) => entry.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

function confidenceFromFirms(value: string): OpsMapAsset['confidence'] {
  const normalized = value.toLowerCase();
  if (normalized === 'h' || normalized === 'high') return 'high';
  if (normalized === 'l' || normalized === 'low') return 'low';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric >= 80) return 'high';
    if (numeric < 40) return 'low';
  }
  return 'medium';
}

function parseFirmsObservedAt(date: string, time: string) {
  if (!date) return undefined;
  const normalizedTime = time.padStart(4, '0');
  const hour = normalizedTime.slice(0, 2) || '00';
  const minute = normalizedTime.slice(2, 4) || '00';
  const parsed = new Date(`${date}T${hour}:${minute}:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function fetchFirmsAssets(): Promise<OpsMapAsset[]> {
  const key = firmsMapKey();
  if (!key) return [];
  const source = process.env.INERTIAI_OPS_FIRMS_SOURCE || 'VIIRS_SNPP_NRT';
  const dayRange = process.env.INERTIAI_OPS_FIRMS_DAY_RANGE || '1';
  const endpoint = process.env.INERTIAI_OPS_FIRMS_URL
    || `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${encodeURIComponent(source)}/world/${encodeURIComponent(dayRange)}`;
  const raw = await fetchText(endpoint);
  if (/invalid|error/i.test(raw.slice(0, 160))) {
    throw new Error(cleanText(raw.slice(0, 160), 'FIRMS request failed'));
  }

  const limit = Number(process.env.INERTIAI_OPS_FIRMS_LIMIT || 120);
  return parseCsv(raw)
    .map((row) => {
      const lat = parseNumber(row.latitude);
      const lng = parseNumber(row.longitude);
      if (lat == null || lng == null) return null;
      const confidence = confidenceFromFirms(cleanText(row.confidence, 'n'));
      const frp = parseNumber(row.frp);
      const observedAt = parseFirmsObservedAt(cleanText(row.acq_date), cleanText(row.acq_time));

      return sourceAsset('firms', {
        idParts: [source, observedAt, lat, lng, row.satellite, row.instrument],
        title: `FIRMS active fire ${lat.toFixed(2)}, ${lng.toFixed(2)}`,
        lat,
        lng,
        sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/map/',
        notes: `Satellite ${cleanText(row.satellite, 'unknown')} ${cleanText(row.instrument)}. Confidence ${cleanText(row.confidence, 'n/a')}. FRP ${frp ?? 'n/a'}.`,
        tags: ['fire', 'wildfire', 'thermal-anomaly', source.toLowerCase(), cleanText(row.daynight).toLowerCase()],
        status: `confidence ${cleanText(row.confidence, 'n/a')}`,
        sourceName: 'NASA FIRMS',
        severity: confidence === 'high' || (frp != null && frp >= 50) ? 'warning' : 'watch',
        confidence,
        observedAt,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset))
    .filter((asset) => asset.confidence !== 'low')
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, limit);
}

async function fetchRadNetAssets(): Promise<OpsMapAsset[]> {
  const endpoint = process.env.INERTIAI_OPS_RADNET_URL
    || 'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/EPA_Radiation_Air_Monitors/FeatureServer/0/query';
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    f: 'geojson',
    resultRecordCount: process.env.INERTIAI_OPS_RADNET_LIMIT || '200',
  });
  const payload = await fetchJson(`${endpoint}?${params.toString()}`);
  const features = isRecord(payload) ? asArray(payload.features) : [];

  return features
    .map((feature) => {
      if (!isRecord(feature)) return null;
      const point = pointFromGeometry(feature.geometry);
      if (!point || !isRecord(feature.properties)) return null;
      const props = feature.properties;
      const city = cleanText(props.city || props.name, 'RadNet monitor');
      const state = cleanText(props.State_Abbr || props.state);
      const monitorType = cleanText(props.type, 'Fixed');
      const sourceUrl = cleanText(props.url || 'https://www.epa.gov/radnet');

      return sourceAsset('radnet', {
        idParts: [cleanText(props.OBJECTID), city, state, point.lat, point.lng],
        title: `EPA RadNet: ${city}${state ? `, ${state}` : ''}`,
        lat: point.lat,
        lng: point.lng,
        sourceUrl,
        notes: `${monitorType} EPA RadNet air monitor. RadNet is used for near-real-time gamma radiation monitoring and higher-than-normal radiation detection during incidents.`,
        tags: ['nuclear', 'radiation', 'gamma', 'radnet', 'monitor', state.toLowerCase()],
        status: `${monitorType} monitor`,
        sourceName: 'EPA RadNet',
        severity: 'info',
        confidence: 'high',
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset));
}

interface TrafficCameraRecord {
  index: number;
  camera: string;
  lat: number;
  lng: number;
  description: string;
  still: string;
  statusUrl: string;
  hls: string;
}

const TRAFFIC_CAMERA_SOURCE_URL = process.env.INERTIAI_OPS_TRAFFIC_CAMERA_URL
  || 'http://trafficvid.lexingtonky.gov/publicmap/';
const DEFAULT_TRAFFIC_CAMERA_IDS = ['LEX-CAM-057', 'LEX-CAM-058', 'LEX-CAM-059', 'LEX-CAM-060', 'LEX-CAM-061'];
const ADSB_LOL_BASE_URL = process.env.INERTIAI_OPS_ADSB_BASE_URL || 'https://api.adsb.lol';

function normalizeTrafficCameraId(value: string) {
  const trimmed = value.trim().toUpperCase();
  const numeric = trimmed.match(/(\d{1,3})$/)?.[1];
  return numeric ? `LEX-CAM-${numeric.padStart(3, '0')}` : trimmed;
}

function selectedTrafficCameraIds() {
  const configured = process.env.INERTIAI_OPS_TRAFFIC_CAMERA_IDS;
  if (!configured) return DEFAULT_TRAFFIC_CAMERA_IDS;
  const ids = configured
    .split(/[\s,;]+/)
    .map(normalizeTrafficCameraId)
    .filter(Boolean);
  return ids.length ? ids : DEFAULT_TRAFFIC_CAMERA_IDS;
}

function trafficCameraPageUrl(index: number) {
  const url = new URL(TRAFFIC_CAMERA_SOURCE_URL);
  url.searchParams.set('cam', String(index));
  return url.toString();
}

function parseTrafficCameraCatalog(html: string): TrafficCameraRecord[] {
  const cameraPattern = /\{\s*"camera":\s*'(?<camera>LEX-CAM-\d+)'\s*,\s*"lat":\s*'(?<lat>[^']+)'\s*,\s*"lng":\s*'(?<lng>[^']+)'\s*,\s*"description":\s*'(?<description>[^']+)'\s*,\s*"still":\s*'(?<still>[^']+)'\s*,\s*"status":\s*'(?<statusUrl>[^']+)'\s*,\s*"override":\s*'[^']*'\s*,\s*"hls":\s*'(?<hls>[^']+)'/g;
  return Array.from(html.matchAll(cameraPattern))
    .map((match, index) => {
      const groups = match.groups;
      if (!groups) return null;
      const lat = parseNumber(groups.lat);
      const lng = parseNumber(groups.lng);
      if (lat == null || lng == null) return null;
      return {
        index,
        camera: normalizeTrafficCameraId(groups.camera),
        lat,
        lng,
        description: cleanText(groups.description, groups.camera),
        still: groups.still,
        statusUrl: groups.statusUrl,
        hls: groups.hls,
      };
    })
    .filter((record): record is TrafficCameraRecord => Boolean(record));
}

async function fetchTrafficCameraAssets(): Promise<OpsMapAsset[]> {
  const html = await fetchText(TRAFFIC_CAMERA_SOURCE_URL);
  const selectedIds = new Set(selectedTrafficCameraIds());
  const fetchedAt = new Date().toISOString();
  return parseTrafficCameraCatalog(html)
    .filter((camera) => selectedIds.has(camera.camera))
    .map((camera) => sourceAsset('trafficcams', {
      idParts: [camera.camera, camera.lat, camera.lng],
      type: 'video',
      title: `Traffic Cam: ${camera.description}`,
      lat: camera.lat,
      lng: camera.lng,
      sourceUrl: trafficCameraPageUrl(camera.index),
      streamUrl: camera.hls,
      thumbnailUrl: camera.still,
      notes: `Official LFUCG traffic camera ${camera.camera}. Use the sidebar live-feed button for the provider page; direct HLS links are refreshed from the source page and may expire between refreshes.`,
      tags: ['traffic', 'camera', 'cctv', 'live', 'lexington', 'lfucg', camera.camera.toLowerCase()],
      status: 'Live CCTV feed',
      sourceName: 'LFUCG Traffic Cameras',
      severity: 'info',
      confidence: 'high',
      observedAt: fetchedAt,
    }));
}

interface TrackedFlightDefinition {
  registration: string;
  icao24: string;
  sourceUrl: string;
  label?: string;
}

interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | string | null;
  alt_geom?: number | string | null;
  gs?: number | string | null;
  track?: number | string | null;
  lat?: number | string | null;
  lon?: number | string | null;
  seen?: number | string | null;
  seen_pos?: number | string | null;
  baro_rate?: number | string | null;
}

const DEFAULT_TRACKED_FLIGHTS: TrackedFlightDefinition[] = [
  {
    registration: 'N103RV',
    icao24: 'a01164',
    sourceUrl: 'https://www.flightradar24.com/N103RV/3fa6c6f5',
    label: "Van's RV-7",
  },
];

const trackedFlightHistory = new Map<string, Array<{ lat: number; lng: number; observedAt?: string }>>();

function trackedFlights(): TrackedFlightDefinition[] {
  return DEFAULT_TRACKED_FLIGHTS;
}

function formatRounded(value: number | null, unit: string) {
  if (value == null || !Number.isFinite(value)) return null;
  return `${Math.round(value)} ${unit}`;
}

function formatHeading(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return `hdg ${Math.round(value)}°`;
}

function observedAtFromNow(nowMs: number, secondsAgo: number | null) {
  if (secondsAgo == null || !Number.isFinite(secondsAgo)) return new Date(nowMs).toISOString();
  return new Date(nowMs - Math.max(0, secondsAgo) * 1000).toISOString();
}

async function fetchTrackedFlightAssets(): Promise<OpsMapAsset[]> {
  const nowMs = Date.now();
  const flights = await Promise.all(trackedFlights().map(async (flight) => {
    const payload = await fetchJson(`${ADSB_LOL_BASE_URL}/v2/icao/${encodeURIComponent(flight.icao24)}`);
    const aircraft = isRecord(payload) ? asArray(payload.ac)[0] : null;
    if (!isRecord(aircraft)) return null;

    const lat = parseNumber(aircraft.lat);
    const lng = parseNumber(aircraft.lon);
    if (lat == null || lng == null) return null;

    const altitude = parseNumber(aircraft.alt_baro) ?? parseNumber(aircraft.alt_geom);
    const speed = parseNumber(aircraft.gs);
    const heading = parseNumber(aircraft.track);
    const verticalRate = parseNumber(aircraft.baro_rate);
    const seen = parseNumber(aircraft.seen_pos) ?? parseNumber(aircraft.seen);
    if (seen != null && seen > 15 * 60) return null;
    const registration = cleanText(aircraft.r || flight.registration, flight.registration);
    const flightId = cleanText(aircraft.flight || registration, registration);
    const aircraftType = cleanText(aircraft.t || flight.label || 'Aircraft');
    const observedAt = observedAtFromNow(nowMs, seen);
    const historyKey = `${flight.icao24.toLowerCase()}|${registration.toLowerCase()}`;
    const existingHistory = trackedFlightHistory.get(historyKey) ?? [];
    const nextHistory = [...existingHistory, { lat, lng, observedAt }]
      .filter((point, index, all) => index === 0 || Math.abs(point.lat - all[index - 1].lat) > 0.0002 || Math.abs(point.lng - all[index - 1].lng) > 0.0002)
      .slice(-6);
    trackedFlightHistory.set(historyKey, nextHistory);
    const statusParts = [
      formatRounded(altitude, 'ft'),
      formatRounded(speed, 'kt'),
      formatHeading(heading),
    ].filter((part): part is string => Boolean(part));
    const notesParts = [
      `Live ADS-B track for ${registration}${flight.label ? ` (${flight.label})` : ''}.`,
      `ICAO24 ${flight.icao24.toUpperCase()}.`,
      verticalRate != null ? `Vertical rate ${Math.round(verticalRate)} fpm.` : null,
      'Provider page opens in the sidebar action link.',
    ].filter((part): part is string => Boolean(part));

    return sourceAsset('trackedflights', {
      idParts: [flight.icao24, registration],
      type: 'link',
      title: `Flight: ${registration}`,
      lat,
      lng,
      sourceUrl: flight.sourceUrl,
      notes: notesParts.join(' '),
      tags: ['flight', 'aircraft', 'ads-b', 'aviation', 'live', registration.toLowerCase(), flight.icao24.toLowerCase(), aircraftType.toLowerCase()],
      status: statusParts.join(' · ') || 'Live ADS-B track',
      sourceName: 'Tracked Flights',
      severity: 'info',
      confidence: 'high',
      observedAt,
      heading: heading ?? undefined,
      speed: speed ?? undefined,
      altitude: altitude ?? undefined,
      trail: nextHistory,
    });
  }));

  return flights.filter((flight): flight is OpsMapAsset => Boolean(flight));
}

function severityFromNrcEvent(emergencyClass: string, eventDesc: string): OpsMapAsset['severity'] {
  const normalized = `${emergencyClass} ${eventDesc}`.toLowerCase();
  if (normalized.includes('general emergency') || normalized.includes('site area emergency')) return 'critical';
  if (normalized.includes('alert')) return 'warning';
  if (normalized.includes('unusual event')) return 'watch';
  return 'info';
}

function severityFromReactorPower(power: number): OpsMapAsset['severity'] {
  if (power <= 0) return 'critical';
  if (power < 50) return 'warning';
  if (power < 100) return 'watch';
  return 'info';
}

async function geocodeCandidates(candidates: string[]) {
  for (const candidate of candidates) {
    const point = await geocodeQuery(candidate);
    if (point) return point;
  }
  return null;
}

function siteNameFromUnit(unit: string) {
  return unit.replace(/\s+\d+$/, '').trim();
}

function summarizeReactorGroup(units: Array<{ unit: string; power: number }>) {
  return units
    .sort((left, right) => left.unit.localeCompare(right.unit))
    .map((entry) => `${entry.unit}: ${entry.power}%`)
    .join(' · ');
}

async function fetchNrcEventAssets(): Promise<OpsMapAsset[]> {
  const rawText = await fetchText('https://www.nrc.gov/sites/default/files/doc_library/reading-rm/doc-collections/event-status/event/event-notification-rpt-lastmonth.txt');
  const { header, records } = splitNrcEventRecords(rawText);
  const headerIndex = Object.fromEntries(
    header.split('|').map((entry, index) => [cleanText(entry), index]),
  );

  const assets = await Promise.all(records.map(async (recordLines) => {
    const record = parseNrcEventRecord(recordLines, headerIndex);
    const observedAt = parseNrcDateTime(record.eventDt || record.notificationDt, record.eventTime || record.notificationTime)
      || parseNrcDateTime(record.notificationDt, record.notificationTime);
    const sourceLabel = record.siteName || record.cityName || record.licenseeName || record.eventDesc || 'NRC event';
    const queryCandidates = record.eventDesc.toLowerCase().includes('power reactor')
      ? [
        `${record.siteName} nuclear power plant`,
        `${record.siteName} power station`,
        `${record.siteName} power plant`,
        `${record.siteName} reactor`,
        `${record.cityName}, ${record.stateCd}, USA`,
        `${record.siteName}, ${record.cityName}, ${record.stateCd}`,
      ].filter(Boolean)
      : [
        `${record.cityName}, ${record.stateCd}, USA`,
        `${record.siteName}, ${record.cityName}, ${record.stateCd}`,
        `${record.siteName}`,
        `${record.licenseeName}, ${record.cityName}, ${record.stateCd}`,
      ].filter(Boolean);
    const point = await geocodeCandidates(queryCandidates);
    if (!point) return null;

    const textPreview = record.eventText || recordLines.slice(1).join(' ');
    const notesParts = [
      record.eventDesc ? `${record.eventDesc} event.` : 'NRC event notification.',
      record.emergencyClass ? `Emergency class ${record.emergencyClass}.` : null,
      record.notificationDt ? `Notified ${record.notificationDt}${record.notificationTime ? ` ${record.notificationTime}` : ''}.` : null,
      textPreview ? cleanText(textPreview) : null,
    ].filter((entry): entry is string => Boolean(entry));

    return sourceAsset('nrcevents', {
      idParts: [record.eventNo, record.siteName, record.eventDt, record.eventTime, point.lat, point.lng],
      type: 'note',
      title: `NRC Event ${record.eventNo || 'report'}: ${sourceLabel}`,
      lat: point.lat,
      lng: point.lng,
      sourceUrl: 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/index',
      notes: truncate(notesParts.join(' '), 900),
      tags: [
        'nuclear',
        'nrc',
        'event',
        record.eventDesc,
        record.emergencyClass,
        record.stateCd,
        record.cityName,
        record.siteName,
      ],
      status: [record.eventDesc, record.emergencyClass].filter(Boolean).join(' · ') || 'NRC event notification',
      sourceName: 'NRC Event Notifications',
      severity: severityFromNrcEvent(record.emergencyClass, record.eventDesc),
      confidence: 'high',
      observedAt,
    });
  }));

  return assets.filter((asset): asset is OpsMapAsset => Boolean(asset));
}

async function fetchNrcReactorStatusAssets(): Promise<OpsMapAsset[]> {
  const rawText = await fetchText('https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/PowerReactorStatusForLast365Days.txt');
  const rows: Array<{ date: string; unit: string; power: number }> = [];
  const regex = /(\d{1,2}\/\d{1,2}\/\d{4} 12:00:00 AM)\|([^|]+)\|(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawText))) {
    rows.push({
      date: match[1],
      unit: cleanText(match[2]).replace(/\s+/g, ' '),
      power: Number(match[3]),
    });
  }

  const latestByUnit = new Map<string, { date: string; power: number }>();
  for (const row of rows) {
    if (!latestByUnit.has(row.unit)) {
      latestByUnit.set(row.unit, { date: row.date, power: row.power });
    }
  }

  const grouped = new Map<string, Array<{ unit: string; power: number; date: string }>>();
  for (const [unit, details] of latestByUnit.entries()) {
    const siteName = siteNameFromUnit(unit);
    const items = grouped.get(siteName) ?? [];
    items.push({ unit, power: details.power, date: details.date });
    grouped.set(siteName, items);
  }

  const assets = await Promise.all(Array.from(grouped.entries()).map(async ([siteName, units]) => {
    const latestDate = units
      .map((entry) => new Date(entry.date).getTime())
      .reduce((left, right) => Math.max(left, right), 0);
    const observedAt = Number.isFinite(latestDate) ? new Date(latestDate).toISOString() : undefined;
    const point = await geocodeCandidates([
      `${siteName} nuclear power plant`,
      `${siteName} nuclear generating station`,
      `${siteName} power station`,
      `${siteName} power plant`,
      `${siteName} reactor`,
      siteName,
    ]);
    if (!point) return null;

    const powers = units.map((entry) => entry.power);
    const averagePower = powers.length ? powers.reduce((sum, power) => sum + power, 0) / powers.length : 0;
    const minPower = powers.length ? Math.min(...powers) : 0;
    const maxPower = powers.length ? Math.max(...powers) : 0;
    const summary = summarizeReactorGroup(units);
    const notes = [
      `Latest status for ${units.length} unit${units.length === 1 ? '' : 's'} at ${siteName}.`,
      summary,
      observedAt ? `Observed ${observedAt}.` : null,
    ].filter((entry): entry is string => Boolean(entry)).join(' ');

    return sourceAsset('nrcreactorstatus', {
      idParts: [siteName, observedAt, minPower, maxPower, point.lat, point.lng],
      type: 'note',
      title: `Reactor Status: ${siteName}`,
      lat: point.lat,
      lng: point.lng,
      sourceUrl: 'https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/index',
      notes: truncate(notes, 800),
      tags: [
        'nuclear',
        'nrc',
        'reactor',
        'status',
        siteName,
        ...units.map((entry) => entry.unit),
      ],
      status: `${Math.round(averagePower)}% average power${minPower < 100 ? ` · low ${Math.round(minPower)}%` : ''}`,
      sourceName: 'NRC Reactor Status',
      severity: severityFromReactorPower(minPower),
      confidence: 'high',
      observedAt,
    });
  }));

  return assets.filter((asset): asset is OpsMapAsset => Boolean(asset));
}

const SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    id: 'gdelt',
    name: 'GDELT',
    category: 'news',
    refreshSeconds: 15 * 60,
    attribution: 'The GDELT Project',
    fetch: fetchGdeltAssets,
  },
  {
    id: 'gdacs',
    name: 'GDACS',
    category: 'disaster',
    refreshSeconds: 6 * 60,
    attribution: 'Global Disaster Alert and Coordination System',
    fetch: fetchGdacsAssets,
  },
  {
    id: 'usgs',
    name: 'USGS Earthquakes',
    category: 'seismic',
    refreshSeconds: 5 * 60,
    attribution: 'U.S. Geological Survey Earthquake Hazards Program',
    fetch: fetchUsgsAssets,
  },
  {
    id: 'nws',
    name: 'NOAA/NWS Alerts',
    category: 'weather',
    refreshSeconds: 5 * 60,
    attribution: 'NOAA National Weather Service API',
    fetch: fetchNwsAssets,
  },
  {
    id: 'firms',
    name: 'NASA FIRMS',
    category: 'fire',
    refreshSeconds: 15 * 60,
    attribution: 'NASA FIRMS / LANCE',
    requiresKey: true,
    isEnabled: () => Boolean(firmsMapKey()),
    disabledReason: 'Set FIRMS_MAP_KEY or NASA_FIRMS_MAP_KEY to enable active-fire points.',
    fetch: fetchFirmsAssets,
  },
  {
    id: 'radnet',
    name: 'EPA RadNet',
    category: 'nuclear',
    refreshSeconds: 15 * 60,
    attribution: 'U.S. Environmental Protection Agency RadNet',
    description: 'U.S. near-real-time gamma radiation air monitoring network across all 50 states.',
    fetch: fetchRadNetAssets,
  },
  {
    id: 'nrcevents',
    name: 'NRC Event Notifications',
    category: 'nuclear',
    refreshSeconds: 15 * 60,
    attribution: 'U.S. Nuclear Regulatory Commission event notification reports',
    description: 'Recent NRC event notifications covering power reactor, agreement state, and materials events.',
    fetch: fetchNrcEventAssets,
  },
  {
    id: 'nrcreactorstatus',
    name: 'NRC Reactor Status',
    category: 'nuclear',
    refreshSeconds: 15 * 60,
    attribution: 'U.S. Nuclear Regulatory Commission power reactor status reports',
    description: 'Daily power reactor status for operating commercial reactors in the United States.',
    fetch: fetchNrcReactorStatusAssets,
  },
  {
    id: 'trafficcams',
    name: 'LFUCG Traffic Cameras',
    category: 'transport',
    refreshSeconds: 5 * 60,
    attribution: 'Lexington-Fayette Urban County Government Traffic Cameras',
    description: 'Selected Lexington live CCTV traffic cameras with provider-page launch links and refreshed HLS stream URLs.',
    fetch: fetchTrafficCameraAssets,
  },
  {
    id: 'trackedflights',
    name: 'Tracked Flights',
    category: 'transport',
    refreshSeconds: 30,
    attribution: 'ADSB.lol live ADS-B feed with FlightRadar24 operator pages',
    description: 'Live tracked aircraft positions from open ADS-B data with provider links for full flight pages.',
    fetch: fetchTrackedFlightAssets,
  },
  {
    id: 'eurdep',
    name: 'EURDEP',
    category: 'nuclear',
    refreshSeconds: 15 * 60,
    attribution: 'European Commission Joint Research Centre EURDEP',
    catalogOnly: true,
    description: 'European radiological monitoring exchange with near-real-time data from participating countries.',
    fetch: async () => [],
  },
  {
    id: 'safecast',
    name: 'Safecast',
    category: 'nuclear',
    refreshSeconds: 15 * 60,
    attribution: 'Safecast open radiation dataset',
    catalogOnly: true,
    description: 'Global community and fixed-sensor radiation measurements released under CC0.',
    fetch: async () => [],
  },
  {
    id: 'gmcmap',
    name: 'GMCMap',
    category: 'nuclear',
    refreshSeconds: 10 * 60,
    attribution: 'GQ Electronics GMCMap community Geiger counter network',
    catalogOnly: true,
    description: 'Global community Geiger counter map; useful as a weak signal with variable device quality.',
    fetch: async () => [],
  },
  {
    id: 'ntad',
    name: 'BTS NTAD',
    category: 'transport',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'Bureau of Transportation Statistics National Transportation Atlas Database',
    catalogOnly: true,
    description: 'U.S. multimodal transportation facilities, modal networks, and intermodal terminals.',
    fetch: async () => [],
  },
  {
    id: 'faf',
    name: 'BTS FAF',
    category: 'freight',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'Bureau of Transportation Statistics Freight Analysis Framework',
    catalogOnly: true,
    description: 'U.S. freight flow estimates by mode, commodity, and origin/destination.',
    fetch: async () => [],
  },
  {
    id: 'marinecadastre',
    name: 'MarineCadastre AIS',
    category: 'maritime',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'NOAA Office for Coastal Management / BOEM MarineCadastre.gov AIS',
    catalogOnly: true,
    description: 'U.S. vessel traffic AIS downloads for maritime movement and port congestion context.',
    fetch: async () => [],
  },
  {
    id: 'mobilitydb',
    name: 'Mobility Database / GTFS',
    category: 'mobility',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'MobilityData Mobility Database and GTFS / GTFS-Realtime feeds',
    catalogOnly: true,
    description: 'Global public transit schedules and realtime feeds for urban mobility context.',
    fetch: async () => [],
  },
  {
    id: 'tigerline',
    name: 'Census TIGER/Line',
    category: 'reference',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'U.S. Census Bureau TIGER/Line and TIGERweb',
    catalogOnly: true,
    description: 'U.S. roads, boundaries, and geographic reference files.',
    fetch: async () => [],
  },
];

class OpsGeoSourceService {
  private snapshotCache: OpsGeoSourceSnapshot | null = null;
  private pendingSnapshot: Promise<OpsGeoSourceSnapshot> | null = null;
  private readonly lastGoodAssets = new Map<OpsGeoSourceId, OpsMapAsset[]>();

  async snapshot(force = false): Promise<OpsGeoSourceSnapshot> {
    const now = Date.now();
    if (!force && this.snapshotCache && now - new Date(this.snapshotCache.fetchedAt).getTime() < DEFAULT_CACHE_MS) {
      return this.snapshotCache;
    }

    if (!force && this.pendingSnapshot) return this.pendingSnapshot;

    this.pendingSnapshot = this.refresh();
    try {
      this.snapshotCache = await this.pendingSnapshot;
      return this.snapshotCache;
    } finally {
      this.pendingSnapshot = null;
    }
  }

  async sourceStatuses(force = false) {
    const snapshot = await this.snapshot(force);
    return snapshot.sources;
  }

  private async refresh(): Promise<OpsGeoSourceSnapshot> {
    const fetchedAt = new Date().toISOString();
    const results = await Promise.all(SOURCE_DEFINITIONS.map((definition) => this.runSource(definition, fetchedAt)));
    return {
      fetchedAt,
      sources: results.map((result) => result.status),
      assets: results.flatMap((result) => result.assets),
    };
  }

  private async runSource(definition: SourceDefinition, fetchedAt: string): Promise<SourceRunResult> {
    const enabled = definition.isEnabled ? definition.isEnabled() : true;
    const baseStatus: Omit<OpsGeoSourceStatus, 'ok' | 'stale' | 'itemCount'> = {
      id: definition.id,
      name: definition.name,
      category: definition.category,
      enabled,
      refreshSeconds: definition.refreshSeconds,
      lastFetchedAt: fetchedAt,
      attribution: definition.attribution,
      requiresKey: definition.requiresKey,
      catalogOnly: definition.catalogOnly,
      description: definition.description,
    };

    if (!enabled) {
      return {
        assets: [],
        status: {
          ...baseStatus,
          ok: false,
          stale: false,
          itemCount: 0,
          lastError: definition.disabledReason || 'Source is not configured.',
        },
      };
    }

    try {
      const assets = await definition.fetch();
      this.lastGoodAssets.set(definition.id, assets);
      return {
        assets,
        status: {
          ...baseStatus,
          ok: true,
          stale: false,
          itemCount: assets.length,
        },
      };
    } catch (error) {
      const assets = this.lastGoodAssets.get(definition.id) ?? [];
      return {
        assets,
        status: {
          ...baseStatus,
          ok: false,
          stale: assets.length > 0,
          itemCount: assets.length,
          lastError: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

export const opsGeoSourceService = new OpsGeoSourceService();
