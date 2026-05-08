import { createHash } from 'node:crypto';
import type { OpsMapAsset } from './ops-map-store.js';

export type OpsGeoSourceId =
  | 'gdelt'
  | 'gdacs'
  | 'usgs'
  | 'nws'
  | 'firms'
  | 'radnet'
  | 'eurdep'
  | 'safecast'
  | 'gmcmap'
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

async function fetchJson(url: string) {
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
