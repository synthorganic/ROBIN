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

  if (type === 'LineString' && Array.isArray(coordinates)) {
    return averageCoordinatePairs(coordinates);
  }

  if (type === 'MultiLineString' && Array.isArray(coordinates)) {
    const pairs = coordinates.flatMap((line) => asArray(line));
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

function canonicalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pickRecordValue(record: Record<string, unknown>, keys: string[]) {
  const entries = Object.entries(record);
  for (const key of keys) {
    const canonical = canonicalizeKey(key);
    const match = entries.find(([entryKey]) => canonicalizeKey(entryKey) === canonical);
    if (match && cleanText(match[1])) return match[1];
  }
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[], fallback = '') {
  const value = pickRecordValue(record, keys);
  return cleanText(value, fallback);
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  return parseNumber(pickRecordValue(record, keys));
}

function propertyLabel(key: string) {
  return key.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactPropertyNotes(record: Record<string, unknown>, keys: string[], limit = 6) {
  const entries = keys
    .map((key) => {
      const value = cleanText(pickRecordValue(record, [key]));
      return value ? `${propertyLabel(key)}: ${value}` : '';
    })
    .filter(Boolean);
  return entries.slice(0, limit).join(' · ');
}

function scaleEurdepLatitude(value: number) {
  return Math.abs(value) > 90 ? value / 1000 + 30 : value;
}

function scaleEurdepLongitude(value: number) {
  return Math.abs(value) > 180 ? value / 1000 : value;
}

function scaleEurdepDose(value: number) {
  return value > 500 ? value / 1000 : value;
}

function severityFromRadiationValue(value: number | null, unit: string): OpsMapAsset['severity'] {
  if (value == null || !Number.isFinite(value)) return 'info';
  const normalized = unit.toLowerCase();

  if (normalized.includes('cpm') || normalized.includes('cps')) {
    if (value >= 1000) return 'critical';
    if (value >= 300) return 'warning';
    if (value >= 100) return 'watch';
    return 'info';
  }

  if (normalized.includes('msv')) {
    if (value >= 5) return 'critical';
    if (value >= 1) return 'warning';
    if (value >= 0.5) return 'watch';
    return 'info';
  }

  if (normalized.includes('nsv')) {
    if (value >= 2000) return 'critical';
    if (value >= 500) return 'warning';
    if (value >= 200) return 'watch';
    return 'info';
  }

  if (normalized.includes('usv') || normalized.includes('µsv') || normalized.includes('μsv')) {
    if (value >= 5) return 'critical';
    if (value >= 1) return 'warning';
    if (value >= 0.25) return 'watch';
    return 'info';
  }

  if (value >= 1000) return 'warning';
  return 'info';
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

interface ArcGisLayerInfo {
  id?: number;
  name?: string;
  alias?: string;
  geometryType?: string;
  objectIdField?: string;
}

interface ArcGisFeatureRecord {
  id?: unknown;
  geometry?: unknown;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

interface ArcGisQueryFeature {
  serviceName: string;
  serviceUrl: string;
  layer: ArcGisLayerInfo;
  feature: ArcGisFeatureRecord;
}

interface ArcGisLayerFetchConfig {
  serviceUrl: string;
  serviceName: string;
  layerNames: string[];
  tags: string[];
  titleKeys: string[];
  statusKeys?: string[];
  noteKeys?: string[];
  type?: OpsMapAsset['type'];
  severity?: OpsMapAsset['severity'];
  confidence?: OpsMapAsset['confidence'];
  sourceUrl?: string;
}

function normalizeArcGisUrl(serviceUrl: string) {
  return serviceUrl.replace(/\/+$/, '');
}

function arcGisLayerMatches(layer: ArcGisLayerInfo, candidate: string) {
  const normalizedLayerName = canonicalizeKey(cleanText(layer.name || layer.alias || ''));
  const normalizedCandidate = canonicalizeKey(candidate);
  return Boolean(normalizedLayerName) && (
    normalizedLayerName === normalizedCandidate
    || normalizedLayerName.includes(normalizedCandidate)
    || normalizedCandidate.includes(normalizedLayerName)
  );
}

function arcGisLayerFeatureId(feature: ArcGisFeatureRecord, props: Record<string, unknown>) {
  return cleanText(
    feature.id
    ?? pickRecordValue(props, ['OBJECTID', 'OBJECT_ID', 'objectid', 'FID', 'fid', 'ID', 'id', 'OID', 'oid']),
  );
}

function arcGisFeatureProps(feature: ArcGisFeatureRecord) {
  return feature.properties && isRecord(feature.properties)
    ? feature.properties
    : feature.attributes && isRecord(feature.attributes)
      ? feature.attributes
      : {};
}

function arcGisLayerTitle(layer: ArcGisLayerInfo) {
  return cleanText(layer.name || layer.alias, 'ArcGIS layer');
}

function selectedArcGisLayerNames(layers: ArcGisLayerInfo[], candidates: string[]) {
  const selected: ArcGisLayerInfo[] = [];
  const usedIds = new Set<number>();

  for (const candidate of candidates) {
    const match = layers.find((layer) => {
      const layerId = Number(layer.id);
      return !usedIds.has(layerId) && arcGisLayerMatches(layer, candidate);
    });
    if (!match) continue;
    const layerId = Number(match.id);
    if (Number.isFinite(layerId)) usedIds.add(layerId);
    selected.push(match);
  }

  return selected.length ? selected : layers.slice(0, 1);
}

async function fetchArcGisLayerFeatures(serviceUrl: string, layerNames: string[], limit = Number(process.env.INERTIAI_OPS_ARCGIS_LIMIT || 12)) {
  const baseUrl = normalizeArcGisUrl(serviceUrl);
  const metadata = await fetchJson(`${baseUrl}?f=pjson`);
  const metadataRecord = isRecord(metadata) ? metadata : ({} as Record<string, unknown>);
  const layers = isRecord(metadata)
    ? asArray(metadataRecord.layers).filter(isRecord).map((layer) => ({
      id: parseNumber(layer.id) ?? undefined,
      name: cleanText(layer.name || layer.alias),
      alias: cleanText(layer.alias),
      geometryType: cleanText(layer.geometryType),
      objectIdField: cleanText(layer.objectIdField || metadataRecord.objectIdField),
    }))
    : [];

  const selectedLayers = selectedArcGisLayerNames(layers, layerNames);
  const serviceName = cleanText(isRecord(metadata) ? (metadataRecord.title || metadataRecord.serviceDescription || metadataRecord.mapName) : '', baseUrl);
  const features: ArcGisQueryFeature[] = [];

  for (const layer of selectedLayers) {
    const layerId = parseNumber(layer.id);
    if (layerId == null) continue;

    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      f: 'geojson',
      resultRecordCount: String(limit),
      outSR: '4326',
    });

    if (layer.objectIdField) {
      params.set('orderByFields', `${layer.objectIdField} ASC`);
    }

    const payload = await fetchJson(`${baseUrl}/${layerId}/query?${params.toString()}`);
    const layerFeatures = isRecord(payload) ? asArray(payload.features) : [];
    for (const feature of layerFeatures) {
      if (!isRecord(feature)) continue;
      features.push({
        serviceName,
        serviceUrl: baseUrl,
        layer,
        feature: feature as ArcGisFeatureRecord,
      });
    }
  }

  return features;
}

function arcGisAssetFromFeature(
  sourceId: OpsGeoSourceId,
  config: ArcGisLayerFetchConfig,
  entry: ArcGisQueryFeature,
  observedAt: string,
): OpsMapAsset | null {
  const props = arcGisFeatureProps(entry.feature);
  const point = pointFromGeometry(entry.feature.geometry);
  if (!point) return null;

  const featureId = arcGisLayerFeatureId(entry.feature, props) || `${entry.layer.id ?? 'layer'}-${point.lat.toFixed(4)}-${point.lng.toFixed(4)}`;
  const title = firstString(
    props,
    config.titleKeys,
    `${config.serviceName} ${arcGisLayerTitle(entry.layer)} ${featureId}`,
  );
  const status = firstString(props, config.statusKeys || [], '');
  const notes = compactPropertyNotes(props, config.noteKeys || config.titleKeys, 6);
  const geometry = cleanText(entry.layer.geometryType, 'geometry');

  return sourceAsset(sourceId, {
    idParts: [config.serviceName, entry.layer.id ?? entry.layer.name, featureId, point.lat, point.lng],
    type: config.type ?? 'link',
    title,
    lat: point.lat,
    lng: point.lng,
    sourceUrl: config.sourceUrl || entry.serviceUrl,
    notes: [
      `${config.serviceName} ${arcGisLayerTitle(entry.layer)} layer.`,
      geometry ? `Geometry: ${geometry}.` : '',
      notes,
    ].filter(Boolean).join(' '),
    tags: [sourceId, ...config.tags, arcGisLayerTitle(entry.layer)],
    status: status || arcGisLayerTitle(entry.layer),
    sourceName: config.serviceName,
    severity: config.severity ?? 'info',
    confidence: config.confidence ?? 'high',
    observedAt,
  });
}

async function fetchArcGisSourceAssets(
  sourceId: OpsGeoSourceId,
  configs: ArcGisLayerFetchConfig[],
  options: { limit?: number; observedAt?: string } = {},
): Promise<OpsMapAsset[]> {
  const observedAt = options.observedAt || new Date().toISOString();
  const limit = options.limit ?? Number(process.env.INERTIAI_OPS_ARCGIS_LIMIT || 12);
  const assets: OpsMapAsset[] = [];
  const errors: string[] = [];

  for (const config of configs) {
    try {
      const features = await fetchArcGisLayerFeatures(config.serviceUrl, config.layerNames, limit);
      for (const entry of features) {
        const asset = arcGisAssetFromFeature(sourceId, config, entry, observedAt);
        if (asset) assets.push(asset);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!assets.length && errors.length) {
    throw new Error(errors[0]);
  }

  return assets;
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

function stripHtmlArtifacts(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

function textFromHtml(html: string) {
  return cleanText(stripHtmlArtifacts(html), '');
}

function sectionText(text: string, label: string, endLabels: string[]) {
  const start = text.toLowerCase().indexOf(label.toLowerCase());
  if (start < 0) return '';
  const rest = text.slice(start + label.length);
  let end = rest.length;
  for (const endLabel of endLabels) {
    const index = rest.toLowerCase().indexOf(endLabel.toLowerCase());
    if (index >= 0 && index < end) end = index;
  }
  return cleanText(rest.slice(0, end));
}

function unescapeJsString(value: string) {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function tryParseDate(value: unknown) {
  const parsed = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function formatCompactUtcDate(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function resolveUrl(baseUrl: string, href: string) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

async function fetchSafecastAssets(): Promise<OpsMapAsset[]> {
  const hours = Math.max(1, Number(process.env.INERTIAI_OPS_SAFECAST_HOURS || 24));
  const limit = Math.max(1, Number(process.env.INERTIAI_OPS_SAFECAST_LIMIT || 80));
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const params = new URLSearchParams({
    since,
    order: 'captured_at desc',
    limit: String(limit),
  });
  const payload = await fetchJson(`https://api.safecast.org/measurements.json?${params.toString()}`);

  return asArray(payload)
    .map((measurement, index) => {
      if (!isRecord(measurement)) return null;
      const lat = firstNumber(measurement, ['latitude', 'lat']);
      const lng = firstNumber(measurement, ['longitude', 'lng', 'lon']);
      if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

      const value = firstNumber(measurement, ['value']);
      const unit = firstString(measurement, ['unit'], 'nSv/h');
      const capturedAt = firstString(measurement, ['captured_at']);
      const locationName = firstString(measurement, ['location_name'], 'Safecast measurement');
      const deviceId = firstString(measurement, ['device_id', 'station_id', 'sensor_id'], 'device');
      const deviceType = firstString(measurement, ['devicetype_id']);
      const originalId = firstString(measurement, ['original_id']);
      const valueText = value == null ? 'n/a' : value.toFixed(value < 10 ? 2 : 1);

      return sourceAsset('safecast', {
        idParts: [firstString(measurement, ['id'], String(index)), deviceId, capturedAt, lat, lng],
        title: `${locationName}: ${valueText} ${unit}`.trim(),
        lat,
        lng,
        sourceUrl: 'https://safecast.org/data/download/',
        notes: [
          `Safecast measurement from device ${deviceId}.`,
          capturedAt ? `Captured ${capturedAt}.` : '',
          originalId ? `Original ID ${originalId}.` : '',
          deviceType ? `Device type ${deviceType}.` : '',
        ].filter(Boolean).join(' '),
        tags: ['radiation', 'safecast', 'gamma', 'community-sensor', unit.toLowerCase(), locationName.toLowerCase()],
        status: `${valueText} ${unit}`.trim(),
        sourceName: 'Safecast',
        severity: severityFromRadiationValue(value, unit),
        confidence: 'medium',
        observedAt: capturedAt || undefined,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset));
}

function gmcMapSeverityFromCpm(cpm: number) {
  if (cpm >= 1000) return 'critical';
  if (cpm >= 300) return 'warning';
  if (cpm >= 100) return 'watch';
  return 'info';
}

async function fetchGmcMapAssets(): Promise<OpsMapAsset[]> {
  const limit = Math.max(1, Number(process.env.INERTIAI_OPS_GMCMAP_LIMIT || 80));
  const dataRange = Math.max(1, Number(process.env.INERTIAI_OPS_GMCMAP_DAYS || 7));
  const timeZone = process.env.INERTIAI_OPS_GMCMAP_TIMEZONE
    || String(Math.round(-new Date().getTimezoneOffset() / 60));
  const endpoint = `https://www.gmcmap.com/ajaxm.asp?OffSet=0&Limit=${limit}&dataRange=${dataRange}&timeZone=${encodeURIComponent(timeZone)}`;
  const raw = await fetchText(endpoint);
  const rowPattern = /\[\s*'(?<html>(?:\\.|[^'])*)'\s*,\s*(?<lat>-?\d+(?:\.\d+)?)\s*,\s*(?<lng>-?\d+(?:\.\d+)?)\s*,\s*(?<cpm>-?\d+(?:\.\d+)?)\s*,\s*'(?<color>[^']*)'\s*\]/g;

  return Array.from(raw.matchAll(rowPattern))
    .map((match, index) => {
      const groups = match.groups;
      if (!groups) return null;
      const lat = parseNumber(groups.lat);
      const lng = parseNumber(groups.lng);
      const cpm = parseNumber(groups.cpm);
      if (lat == null || lng == null || cpm == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

      const snippet = textFromHtml(xmlDecode(unescapeJsString(groups.html)).replace(/&nbsp;/g, ' '));
      const title = truncate(snippet || `GMCMap ${cpm.toFixed(0)} CPM`, 120);
      const color = cleanText(groups.color);

      return sourceAsset('gmcmap', {
        idParts: [index, lat, lng, cpm, color, title],
        title: title || `GMCMap ${cpm.toFixed(0)} CPM`,
        lat,
        lng,
        sourceUrl: 'https://www.gmcmap.com/',
        notes: [
          `Community Geiger counter reading.`,
          snippet ? `Station summary: ${snippet}.` : '',
          color ? `Display color ${color}.` : '',
        ].filter(Boolean).join(' '),
        tags: ['radiation', 'gmcmap', 'geiger', 'community-sensor', 'cpm'],
        status: `${cpm.toFixed(0)} CPM`,
        sourceName: 'GMCMap',
        severity: gmcMapSeverityFromCpm(cpm),
        confidence: 'medium',
        observedAt: new Date().toISOString(),
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset));
}

async function fetchEurdepAssets(): Promise<OpsMapAsset[]> {
  const days = Math.max(1, Number(process.env.INERTIAI_OPS_EURDEP_DAYS || 7));
  const limit = Math.max(1, Number(process.env.INERTIAI_OPS_EURDEP_LIMIT || 120));
  const now = new Date();
  const startDate = formatCompactUtcDate(new Date(now.getTime() - days * 24 * 60 * 60_000));
  const endDate = formatCompactUtcDate(now);
  const baseUrl = 'https://remap.jrc.ec.europa.eu';
  const lastUpdatedPayload = await fetchJson(`${baseUrl}/api/stations/all/last-updated`);
  const lastUpdated = isRecord(lastUpdatedPayload) ? tryParseDate(String(lastUpdatedPayload.lastUpdated ?? '')) : undefined;
  const stationPayload = await fetchJson(`${baseUrl}/api/stations?type=Last&startDate=${startDate}&endDate=${endDate}`);
  const stations = asArray(stationPayload)
    .map((station, index) => {
      if (!isRecord(station)) return null;
      const rawLat = firstNumber(station, ['lat']);
      const rawLng = firstNumber(station, ['long', 'lng', 'lon']);
      const rawValue = firstNumber(station, ['value']);
      if (rawLat == null || rawLng == null || rawValue == null) return null;

      const lat = scaleEurdepLatitude(rawLat);
      const lng = scaleEurdepLongitude(rawLng);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

      const dose = scaleEurdepDose(rawValue);
      const code = firstString(station, ['code'], `station-${index + 1}`);
      const country = firstString(station, ['country']);
      const observedAt = firstString(station, ['date']) || lastUpdated || undefined;

      return sourceAsset('eurdep', {
        idParts: [code, observedAt, lat, lng, dose],
        title: `EURDEP ${dose.toFixed(dose < 10 ? 1 : 0)} nSv/h`,
        lat,
        lng,
        sourceUrl: `${baseUrl}/Advanced.aspx?map=simple`,
        notes: [
          `EURDEP hourly gamma dose reading from the JRC radiological monitoring map.`,
          code ? `Station code ${code}.` : '',
          country ? `Country ${country}.` : '',
          observedAt ? `Observed ${observedAt}.` : '',
          'Measurements are often non-validated and subject to the provider copyright/consent restrictions.',
        ].filter(Boolean).join(' '),
        tags: ['radiation', 'eurdep', 'gamma-dose'],
        status: `${dose.toFixed(1)} nSv/h`,
        sourceName: 'EURDEP',
        severity: severityFromRadiationValue(dose, 'nSv/h'),
        confidence: 'medium',
        observedAt,
      });
    })
    .filter((asset): asset is OpsMapAsset => Boolean(asset))
    .sort((left, right) => {
      const leftValue = Number(left.status?.match(/[\d.]+/)?.[0] ?? '0');
      const rightValue = Number(right.status?.match(/[\d.]+/)?.[0] ?? '0');
      return rightValue - leftValue;
    })
    .slice(0, limit);

  const overview = sourceAsset('eurdep', {
    idParts: ['overview', lastUpdated || endDate, stations.length],
    type: 'note',
    title: 'EURDEP Gamma Dose Rates',
    lat: 50.5,
    lng: 10,
    sourceUrl: `${baseUrl}/Consent/Advanced.aspx`,
    notes: [
      'EURDEP provides hourly gamma dose averages going back up to 35 days from roughly 5,500 stations across Europe.',
      'Most measurements on the advanced map are non-validated.',
      'No alerting function is provided; the platform is informational only.',
      'EURDEP data is subject to the originating provider copyright and consent terms.',
    ].join(' '),
    tags: ['radiation', 'eurdep', 'gamma-dose', 'europe'],
    status: [
      lastUpdated ? `Last updated ${lastUpdated}` : 'Live EURDEP map',
      `${stations.length} stations in snapshot`,
    ].join(' · '),
    sourceName: 'EURDEP',
    severity: 'watch',
    confidence: 'medium',
    observedAt: lastUpdated || undefined,
  });

  return [overview, ...stations];
}

const NTAD_ARCGIS_CONFIGS: ArcGisLayerFetchConfig[] = [
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_North_American_Roads/FeatureServer',
    serviceName: 'North American Roads',
    layerNames: ['North American Roads'],
    tags: ['transport', 'roads', 'highway', 'north-america'],
    titleKeys: ['FULLNAME', 'NAME', 'ROADNAME', 'RTTYP'],
    statusKeys: ['MTFCC', 'RTTYP', 'FUNCLASS'],
    noteKeys: ['FULLNAME', 'NAME', 'MTFCC', 'RTTYP', 'STATE_NAME', 'COUNTY_NAME'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Network/FeatureServer',
    serviceName: 'National Network',
    layerNames: ['National Network'],
    tags: ['transport', 'highway', 'national-network'],
    titleKeys: ['NAME', 'FULLNAME', 'RTTYP'],
    statusKeys: ['MTFCC', 'RTTYP'],
    noteKeys: ['NAME', 'FULLNAME', 'MTFCC', 'RTTYP'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Highway_System/FeatureServer',
    serviceName: 'National Highway System',
    layerNames: ['National Highway System'],
    tags: ['transport', 'highway', 'nhs'],
    titleKeys: ['FULLNAME', 'NAME', 'RTTYP'],
    statusKeys: ['MTFCC', 'RTTYP'],
    noteKeys: ['FULLNAME', 'NAME', 'MTFCC', 'RTTYP'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Highway_Freight_Network/FeatureServer',
    serviceName: 'National Highway Freight Network',
    layerNames: ['National Highway Freight Network'],
    tags: ['transport', 'freight', 'highway', 'nhfn'],
    titleKeys: ['FULLNAME', 'NAME', 'RTTYP'],
    statusKeys: ['MTFCC', 'RTTYP'],
    noteKeys: ['FULLNAME', 'NAME', 'MTFCC', 'RTTYP'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer',
    serviceName: 'North American Rail Network Lines',
    layerNames: ['North American Rail Network Lines'],
    tags: ['transport', 'rail', 'line'],
    titleKeys: ['NAME', 'LINE_NAME', 'RAILROAD', 'SYSTEM'],
    statusKeys: ['TYPE', 'OWNER', 'OPERATOR'],
    noteKeys: ['NAME', 'LINE_NAME', 'RAILROAD', 'SYSTEM', 'TYPE', 'OWNER', 'OPERATOR'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_North_American_Rail_Network_Nodes/FeatureServer',
    serviceName: 'North American Rail Network Nodes',
    layerNames: ['North American Rail Network Nodes'],
    tags: ['transport', 'rail', 'node'],
    titleKeys: ['NAME', 'STATION', 'NODE_NAME', 'FACILITY'],
    statusKeys: ['TYPE', 'OWNER', 'OPERATOR'],
    noteKeys: ['NAME', 'STATION', 'NODE_NAME', 'FACILITY', 'TYPE', 'OWNER', 'OPERATOR'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Commercial_Strategic_Seaports/FeatureServer',
    serviceName: 'Commercial Strategic Seaports',
    layerNames: ['Commercial Strategic Seaports'],
    tags: ['maritime', 'port', 'seaport'],
    titleKeys: ['PORT_NAME', 'NAME', 'FACILITY', 'SEAPORT'],
    statusKeys: ['PORTTYPE', 'TYPE', 'MODE'],
    noteKeys: ['PORT_NAME', 'NAME', 'STATE', 'PORT_CODE', 'OWNER', 'TYPE'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Intermodal_Freight_Facilities_Air_to_Truck/FeatureServer',
    serviceName: 'Intermodal Freight Facilities Air to Truck',
    layerNames: ['Intermodal Freight Facilities Air to Truck'],
    tags: ['transport', 'freight', 'intermodal', 'air', 'truck'],
    titleKeys: ['FACILITY_NAME', 'NAME', 'AIRPORT', 'PORT_NAME'],
    statusKeys: ['TYPE', 'MODE'],
    noteKeys: ['FACILITY_NAME', 'NAME', 'AIRPORT', 'PORT_NAME', 'TYPE', 'MODE'],
  },
];

async function fetchNtadAssets(): Promise<OpsMapAsset[]> {
  return fetchArcGisSourceAssets('ntad', NTAD_ARCGIS_CONFIGS, { limit: Number(process.env.INERTIAI_OPS_NTAD_LIMIT || 12) });
}

const FAF_ARCGIS_CONFIGS: ArcGisLayerFetchConfig[] = [
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Freight_Analysis_Framework_Network_Links/FeatureServer',
    serviceName: 'FAF5 Network Links',
    layerNames: ['Freight Analysis Framework (FAF5) Network Links'],
    tags: ['freight', 'faf', 'links', 'flow'],
    titleKeys: ['NAME', 'LINK_NAME', 'ORIG_NAME', 'DEST_NAME'],
    statusKeys: ['OD', 'ORIG', 'DEST', 'MODE'],
    noteKeys: ['NAME', 'LINK_NAME', 'ORIG_NAME', 'DEST_NAME', 'MODE', 'COMMODITY'],
  },
  {
    serviceUrl: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Freight_Analysis_Framework_Regions/FeatureServer',
    serviceName: 'FAF5 Regions',
    layerNames: ['Freight Analysis Framework (FAF5) Regions'],
    tags: ['freight', 'faf', 'regions'],
    titleKeys: ['NAME', 'REGION', 'FAF_NAME', 'AREA_NAME'],
    statusKeys: ['FAF_ID', 'REGION', 'TYPE'],
    noteKeys: ['NAME', 'REGION', 'FAF_ID', 'TYPE'],
    type: 'note',
  },
];

async function fetchFafAssets(): Promise<OpsMapAsset[]> {
  return fetchArcGisSourceAssets('faf', FAF_ARCGIS_CONFIGS, { limit: Number(process.env.INERTIAI_OPS_FAF_LIMIT || 12) });
}

const TIGER_ARCGIS_CONFIGS: ArcGisLayerFetchConfig[] = [
  {
    serviceUrl: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer',
    serviceName: 'TIGERweb Transportation',
    layerNames: ['Primary Roads', 'Secondary Roads', 'Local Roads', 'Railroads'],
    tags: ['tiger', 'transport', 'roads', 'rail', 'reference'],
    titleKeys: ['FULLNAME', 'NAME', 'ROADNAME', 'RTTYP', 'MTFCC'],
    statusKeys: ['MTFCC', 'RTTYP', 'CLASS'],
    noteKeys: ['FULLNAME', 'NAME', 'MTFCC', 'RTTYP', 'CLASS'],
  },
  {
    serviceUrl: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer',
    serviceName: 'TIGERweb States and Counties',
    layerNames: ['States', 'Counties'],
    tags: ['tiger', 'boundaries', 'states', 'counties', 'reference'],
    titleKeys: ['NAME', 'NAMELSAD', 'STATE_NAME', 'COUNTY_NAME', 'STUSAB'],
    statusKeys: ['STATEFP', 'COUNTYFP', 'STUSAB'],
    noteKeys: ['NAME', 'NAMELSAD', 'STATE_NAME', 'COUNTY_NAME', 'STATEFP', 'COUNTYFP'],
    type: 'note',
  },
  {
    serviceUrl: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer',
    serviceName: 'TIGERweb Places',
    layerNames: ['Incorporated Places', 'Census Designated Places'],
    tags: ['tiger', 'boundaries', 'places', 'reference'],
    titleKeys: ['NAME', 'NAMELSAD', 'BASENAME'],
    statusKeys: ['LSAD', 'STUSAB'],
    noteKeys: ['NAME', 'NAMELSAD', 'LSAD', 'STUSAB'],
    type: 'note',
  },
  {
    serviceUrl: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer',
    serviceName: 'TIGERweb Census Reference',
    layerNames: ['Census Tracts', 'Census Block Groups'],
    tags: ['tiger', 'reference', 'tracts', 'blocks'],
    titleKeys: ['NAMELSAD', 'NAME', 'GEOID', 'BASENAME'],
    statusKeys: ['GEOID', 'MTFCC'],
    noteKeys: ['NAME', 'NAMELSAD', 'GEOID', 'MTFCC'],
    type: 'note',
  },
];

async function fetchTigerLineAssets(): Promise<OpsMapAsset[]> {
  return fetchArcGisSourceAssets('tigerline', TIGER_ARCGIS_CONFIGS, { limit: Number(process.env.INERTIAI_OPS_TIGER_LIMIT || 10) });
}

async function fetchMarineCadastreAssets(): Promise<OpsMapAsset[]> {
  const pageUrl = 'https://hub.marinecadastre.gov/pages/vesseltraffic';
  const itemData = await fetchJson('https://www.arcgis.com/sharing/rest/content/items/22fb5273ccb54f6aa423f6667a856761?f=json');
  const pageHtml = await fetchText(pageUrl);
  const observedAt = isRecord(itemData) ? tryParseDate(itemData.modified) : undefined;
  const latestBulkIndex = 'https://noaaocm.blob.core.windows.net/ais/csv2/csv2025/index.html';
  const trackIndex = 'https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/ais/aistrack/index-aistrack.html';
  const transitIndex = 'https://ocmgeodatastor1.blob.core.windows.net/marinecadastre/ais/aistransit/index-aistransit.html';
  const assets: OpsMapAsset[] = [];
  const itemTitle = isRecord(itemData) ? cleanText(itemData.title, 'Vessel Traffic - Marine Cadastre') : 'Vessel Traffic - Marine Cadastre';
  const itemSnippet = isRecord(itemData) ? cleanText(itemData.snippet) : '';
  const itemDescription = isRecord(itemData) ? cleanText(itemData.description) : '';
  const pageText = textFromHtml(pageHtml);

  assets.push(sourceAsset('marinecadastre', {
    idParts: ['overview', observedAt, itemTitle],
    type: 'note',
    title: itemTitle,
    lat: 38.5,
    lng: -97,
    sourceUrl: pageUrl,
    notes: [
      itemSnippet,
      itemDescription,
      pageText.includes('AIS') ? 'Marine Cadastre vessel traffic portal.' : '',
      'The page links to bulk AIS broadcast points, track lines, and transit counts for U.S. coastal waters.',
    ].filter(Boolean).join(' '),
    tags: ['maritime', 'ais', 'marinecadastre', 'portal'],
    status: 'Marine Cadastre AIS portal',
    sourceName: 'MarineCadastre AIS',
    severity: 'info',
    confidence: 'high',
    observedAt,
  }));

  if (latestBulkIndex) {
    const bulkHtml = await fetchText(latestBulkIndex);
    const csvFiles = Array.from(bulkHtml.matchAll(/href="([^"]+\.csv\.zst)"/gi)).map((match) => resolveUrl(latestBulkIndex, match[1]));
    assets.push(sourceAsset('marinecadastre', {
      idParts: ['bulk', latestBulkIndex, csvFiles.length, observedAt],
      type: 'note',
      title: `MarineCadastre AIS Bulk Downloads ${latestBulkIndex.match(/csv(\d{4})/i)?.[1] ?? ''}`.trim(),
      lat: 38.5,
      lng: -97,
      sourceUrl: latestBulkIndex,
      notes: [
        `Official AIS bulk download index.`,
        csvFiles.length ? `${csvFiles.length} daily CSV.zst files are listed in the latest year index.` : 'Bulk file index available.',
      ].join(' '),
      tags: ['maritime', 'ais', 'bulk-download', 'port-congestion'],
      status: csvFiles.length ? `${csvFiles.length} daily files` : 'Bulk AIS download index',
      sourceName: 'MarineCadastre AIS',
      severity: 'info',
      confidence: 'high',
      observedAt,
    }));
  }

  if (trackIndex) {
    const trackHtml = await fetchText(trackIndex);
    const trackLinks = Array.from(trackHtml.matchAll(/href="([^"]+)"/gi)).map((match) => resolveUrl(trackIndex, match[1]));
    assets.push(sourceAsset('marinecadastre', {
      idParts: ['track', trackIndex, trackLinks.length, observedAt],
      type: 'note',
      title: 'MarineCadastre AIS Track Lines',
      lat: 37.5,
      lng: -74.5,
      sourceUrl: trackIndex,
      notes: [
        'AIS track-line index for vessel movement and port-congestion context.',
        trackLinks.length ? `${trackLinks.length} links exposed in the index page.` : '',
      ].filter(Boolean).join(' '),
      tags: ['maritime', 'ais', 'track-lines', 'port-congestion'],
      status: trackLinks.length ? `${trackLinks.length} linked files` : 'Track-line index',
      sourceName: 'MarineCadastre AIS',
      severity: 'info',
      confidence: 'high',
      observedAt,
    }));
  }

  if (transitIndex) {
    const transitHtml = await fetchText(transitIndex);
    const transitLinks = Array.from(transitHtml.matchAll(/href="([^"]+)"/gi)).map((match) => resolveUrl(transitIndex, match[1]));
    assets.push(sourceAsset('marinecadastre', {
      idParts: ['transit', transitIndex, transitLinks.length, observedAt],
      type: 'note',
      title: 'MarineCadastre AIS Transit Counts',
      lat: 29.5,
      lng: -90,
      sourceUrl: transitIndex,
      notes: [
        'AIS transit-count index for vessel traffic context.',
        transitLinks.length ? `${transitLinks.length} links exposed in the index page.` : '',
      ].filter(Boolean).join(' '),
      tags: ['maritime', 'ais', 'transit-counts', 'port-congestion'],
      status: transitLinks.length ? `${transitLinks.length} linked files` : 'Transit-count index',
      sourceName: 'MarineCadastre AIS',
      severity: 'info',
      confidence: 'high',
      observedAt,
    }));
  }

  const summaryText = textFromHtml(pageHtml);
  if (/geoParquet/i.test(summaryText) || /broadcast point data/i.test(summaryText)) {
    assets.push(sourceAsset('marinecadastre', {
      idParts: ['broadcast-points', observedAt],
      type: 'note',
      title: 'MarineCadastre AIS Broadcast Points',
      lat: 30.5,
      lng: -88,
      sourceUrl: pageUrl,
      notes: 'MarineCadastre notes that 2024 AIS broadcast point data is published as GeoParquet and that bulk point downloads are available by year.',
      tags: ['maritime', 'ais', 'broadcast-points', 'port-congestion'],
      status: '2024 point dataset mentioned in official page notes',
      sourceName: 'MarineCadastre AIS',
      severity: 'info',
      confidence: 'high',
      observedAt,
    }));
  }

  return assets;
}

const DEFAULT_MOBILITY_FEED_PAGES = [
  'https://mobilitydatabase.org/feeds/gtfs/mdb-29',
  'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3101',
  'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2893',
  'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-3055',
];

function mobilitySection(text: string, label: string, endLabels: string[]) {
  return sectionText(text, label, endLabels);
}

async function fetchMobilityDbAssets(): Promise<OpsMapAsset[]> {
  const pageUrls = (process.env.INERTIAI_OPS_MOBILITY_PAGES || '')
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const urls = pageUrls.length ? pageUrls : DEFAULT_MOBILITY_FEED_PAGES;
  const assets = await Promise.all(urls.map(async (pageUrl) => {
    const html = await fetchText(pageUrl);
    const text = textFromHtml(html);
    const title = cleanText(html.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1] || html.match(/<title>(.*?)<\/title>/i)?.[1] || pageUrl, 'Mobility Database feed');
    const producerUrl = cleanText(html.match(/data-testid="producer-url"[^>]*>([^<]+)</i)?.[1]);
    const verificationUpdated = mobilitySection(text, 'Official verification updated:', ['Page generated at:', 'Agency', 'Routes', 'Locations', 'Producer URL', 'License', 'Feed Authentication', 'Related Schedule Feeds', 'Related Realtime Feeds']);
    const pageGenerated = mobilitySection(text, 'Page generated at:', ['Official verification updated:', 'Agency', 'Routes', 'Locations', 'Producer URL', 'License', 'Feed Authentication', 'Related Schedule Feeds', 'Related Realtime Feeds']);
    const agency = mobilitySection(text, 'Agency', ['Routes', 'Locations', 'Producer URL', 'License', 'Feed Authentication', 'Related Schedule Feeds', 'Related Realtime Feeds']);
    const locations = mobilitySection(text, 'Locations', ['Show Details', 'Producer URL', 'License', 'Feed Authentication', 'Related Schedule Feeds', 'Related Realtime Feeds']);
    const feedAuth = mobilitySection(text, 'Feed Authentication', ['License', 'Related Schedule Feeds', 'Related Realtime Feeds']);
    const license = mobilitySection(text, 'License', ['Related Schedule Feeds', 'Related Realtime Feeds']);
    const observedAt = tryParseDate(pageGenerated || verificationUpdated) || undefined;
    const geocodeQueryText = locations.split(/[+,]/)[0] || agency || title;
    const point = (await geocodeQuery(geocodeQueryText)) || (await geocodeQuery(agency)) || (await geocodeQuery(title)) || { lat: 39.5, lng: -98.35 };
    const feedType = pageUrl.includes('/gtfs_rt/') ? 'GTFS Realtime' : 'GTFS Schedule';
    const realtime = /realtime/i.test(feedType);
    const agencyNote = agency && agency.length < 120 ? `Agency ${agency}.` : '';

    return sourceAsset('mobilitydb', {
      idParts: [pageUrl, title, producerUrl, observedAt],
      title: `MobilityDB ${title}`,
      lat: point.lat,
      lng: point.lng,
      sourceUrl: pageUrl,
      notes: [
        feedType ? `Feed type ${feedType}.` : '',
        agencyNote,
        locations ? `Locations ${locations}.` : '',
        producerUrl ? `Producer URL ${producerUrl}.` : '',
        verificationUpdated ? `Verification updated ${verificationUpdated}.` : '',
        pageGenerated ? `Page generated at ${pageGenerated}.` : '',
        feedAuth ? `Authentication ${feedAuth}.` : '',
        license ? `License ${license}.` : '',
      ].filter(Boolean).join(' '),
      tags: ['transit', 'mobilitydb', 'gtfs', realtime ? 'gtfs-realtime' : 'gtfs-schedule', ...splitList(locations.replace(/\+\s*\d+\s+more/gi, ''))],
      status: [feedType, locations].filter(Boolean).join(' · ') || 'Transit feed metadata',
      sourceName: 'Mobility Database',
      severity: 'info',
      confidence: 'high',
      observedAt,
    });
  }));

  return assets.filter((asset): asset is OpsMapAsset => Boolean(asset));
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
    description: 'European radiological monitoring exchange with near-real-time data from participating countries.',
    fetch: fetchEurdepAssets,
  },
  {
    id: 'safecast',
    name: 'Safecast',
    category: 'nuclear',
    refreshSeconds: 15 * 60,
    attribution: 'Safecast open radiation dataset',
    description: 'Global community and fixed-sensor radiation measurements released under CC0.',
    fetch: fetchSafecastAssets,
  },
  {
    id: 'gmcmap',
    name: 'GMCMap',
    category: 'nuclear',
    refreshSeconds: 10 * 60,
    attribution: 'GQ Electronics GMCMap community Geiger counter network',
    description: 'Global community Geiger counter map; useful as a weak signal with variable device quality.',
    fetch: fetchGmcMapAssets,
  },
  {
    id: 'ntad',
    name: 'BTS NTAD',
    category: 'transport',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'Bureau of Transportation Statistics National Transportation Atlas Database',
    description: 'U.S. multimodal transportation facilities, modal networks, and intermodal terminals.',
    fetch: fetchNtadAssets,
  },
  {
    id: 'faf',
    name: 'BTS FAF',
    category: 'freight',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'Bureau of Transportation Statistics Freight Analysis Framework',
    description: 'U.S. freight flow estimates by mode, commodity, and origin/destination.',
    fetch: fetchFafAssets,
  },
  {
    id: 'marinecadastre',
    name: 'MarineCadastre AIS',
    category: 'maritime',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'NOAA Office for Coastal Management / BOEM MarineCadastre.gov AIS',
    description: 'U.S. vessel traffic AIS downloads for maritime movement and port congestion context.',
    fetch: fetchMarineCadastreAssets,
  },
  {
    id: 'mobilitydb',
    name: 'Mobility Database / GTFS',
    category: 'mobility',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'MobilityData Mobility Database and GTFS / GTFS-Realtime feeds',
    description: 'Global public transit schedules and realtime feeds for urban mobility context.',
    fetch: fetchMobilityDbAssets,
  },
  {
    id: 'tigerline',
    name: 'Census TIGER/Line',
    category: 'reference',
    refreshSeconds: ONE_DAY_SECONDS,
    attribution: 'U.S. Census Bureau TIGER/Line and TIGERweb',
    description: 'U.S. roads, boundaries, and geographic reference files.',
    fetch: fetchTigerLineAssets,
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
