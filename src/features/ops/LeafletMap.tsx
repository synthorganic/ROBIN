import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapAsset } from './api';

interface LeafletLayer {
  addTo: (map: LeafletMapInstance) => LeafletLayer;
  addLayer?: (layer: LeafletLayer) => LeafletLayer;
  remove?: () => void;
  bindPopup: (content: string, options?: Record<string, unknown>) => LeafletLayer;
  bindTooltip?: (content: string, options?: Record<string, unknown>) => LeafletLayer;
  on: (event: string, handler: (...args: any[]) => void) => LeafletLayer;
  openPopup?: () => LeafletLayer;
  bringToFront?: () => LeafletLayer;
  setStyle?: (options: Record<string, unknown>) => LeafletLayer;
}

interface LeafletBounds {
  pad: (ratio: number) => LeafletBounds;
}

interface LeafletMapInstance {
  setView: (coords: [number, number], zoom: number) => void;
  flyTo?: (coords: [number, number], zoom?: number, options?: Record<string, unknown>) => void;
  fitBounds: (bounds: LeafletBounds, options?: Record<string, unknown>) => void;
  getBounds: () => { getWest: () => number; getSouth: () => number; getEast: () => number; getNorth: () => number };
  getZoom: () => number;
  invalidateSize: (options?: Record<string, unknown>) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler: (...args: any[]) => void) => void;
  remove?: () => void;
}

interface LeafletApi {
  map: (element: HTMLElement, options?: Record<string, unknown>) => LeafletMapInstance;
  tileLayer: (url: string, options: Record<string, unknown>) => LeafletLayer;
  marker: (coords: [number, number], options?: Record<string, unknown>) => LeafletLayer;
  circleMarker: (coords: [number, number], options?: Record<string, unknown>) => LeafletLayer;
  polyline: (coords: Array<[number, number]>, options?: Record<string, unknown>) => LeafletLayer;
  layerGroup: (layers?: LeafletLayer[]) => LeafletLayer & { clearLayers?: () => void };
  divIcon: (options: Record<string, unknown>) => Record<string, unknown>;
  latLngBounds: (coords: Array<[number, number]>) => LeafletBounds;
}

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

interface LeafletMapProps {
  assets: MapAsset[];
  selectedAssetId?: string | null;
  onMapClick: (lat: number, lng: number) => void;
  onSelectAsset: (asset: MapAsset) => void;
  airQualityEnabled?: boolean;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
  timeWindowLabel?: string;
}

interface OverlayPoint {
  lat: number;
  lng: number;
  usAqi: number | null;
  europeanAqi: number | null;
  observedAt?: string;
  band: 'good' | 'moderate' | 'usg' | 'unhealthy' | 'very-unhealthy' | 'hazardous' | 'unknown';
}

interface AirQualitySnapshot {
  sourceName: string;
  sourceLabel: string;
  sourceUrl: string;
  dataSource: string;
  generatedAt: string;
  points: OverlayPoint[];
  emptyReason?: string;
}

type BaseLayerPhase = 'loading' | 'ready' | 'fallback' | 'error';
type OverlayPhase = 'off' | 'loading' | 'ready' | 'empty' | 'error';

interface BaseLayerState {
  phase: BaseLayerPhase;
  name: string;
  detail: string;
}

interface OverlayState {
  phase: OverlayPhase;
  name: string;
  detail: string;
}

interface LayerBundle {
  marker: LeafletLayer;
  trail?: LeafletLayer;
  kind: 'aircraft' | 'poi' | 'point';
}

const TILE_PROVIDERS = [
  {
    name: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    name: 'Carto Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
  },
  {
    name: 'Esri Imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
] as const;

const SOURCE_COLORS: Record<string, string> = {
  manual: '#e6c26d',
  gdelt: '#7fd9ff',
  gdacs: '#ffd56e',
  usgs: '#ff9d67',
  nws: '#89de72',
  firms: '#ff6e73',
  radnet: '#cc9cff',
  nrcevents: '#d2a9ff',
  nrcreactorstatus: '#b78cff',
  eurdep: '#98a9ff',
  safecast: '#77e3d8',
  gmcmap: '#ccff72',
  trafficcams: '#f0ba67',
  trackedflights: '#8ed1ff',
  ntad: '#93c8ff',
  faf: '#94d9ad',
  marinecadastre: '#7dd6ef',
  mobilitydb: '#9bd7ff',
  tigerline: '#c8d1dc',
};

const AQI_COLORS: Record<OverlayPoint['band'], string> = {
  good: '#46d296',
  moderate: '#f1d35f',
  usg: '#ffb25c',
  unhealthy: '#ff7758',
  'very-unhealthy': '#d86cff',
  hazardous: '#ff4357',
  unknown: '#8ea0b8',
};

const MAP_PIN_PATH = 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0';
const AIRCRAFT_PATH = 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z';

function ensureLeaflet(): Promise<LeafletApi> {
  return new Promise((resolve, reject) => {
    const resolveLeaflet = () => {
      if (window.L) {
        resolve(window.L);
      } else {
        reject(new Error('Leaflet did not initialize'));
      }
    };

    if (window.L) {
      resolve(window.L);
      return;
    }

    if (!document.querySelector('link[data-leaflet="true"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/vendor/leaflet/leaflet.css';
      link.dataset.leaflet = 'true';
      document.head.appendChild(link);
    }

    const existingScript = document.querySelector('script[data-leaflet="true"]') as HTMLScriptElement | null;
    if (existingScript) {
      existingScript.addEventListener('load', resolveLeaflet, { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Leaflet failed to load')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = '/vendor/leaflet/leaflet.js';
    script.async = true;
    script.dataset.leaflet = 'true';
    script.addEventListener('load', resolveLeaflet, { once: true });
    script.addEventListener('error', () => reject(new Error('Leaflet failed to load')), { once: true });
    document.body.appendChild(script);
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatObservedAt(value: string | undefined) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseTimestamp(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function rangeContains(value: string | undefined, start: string | null | undefined, end: string | null | undefined) {
  const timestamp = parseTimestamp(value);
  if (timestamp == null) return true;
  const startMs = parseTimestamp(start ?? undefined);
  const endMs = parseTimestamp(end ?? undefined);
  if (startMs != null && timestamp < startMs) return false;
  if (endMs != null && timestamp > endMs) return false;
  return true;
}

function markerColor(asset: MapAsset) {
  if (asset.severity === 'critical') return '#ff4958';
  if (asset.severity === 'warning') return '#ffbb55';
  if (asset.severity === 'watch') return '#d7e96b';
  return SOURCE_COLORS[asset.sourceId || 'manual'] ?? '#7fd9ff';
}

function sourcePopupHtml(asset: MapAsset) {
  const lines = [
    `<strong>${escapeHtml(asset.title)}</strong>`,
    asset.sourceName ? `<span>${escapeHtml(asset.sourceName)}</span>` : '',
    asset.status ? `<span>${escapeHtml(asset.status)}</span>` : '',
    asset.observedAt ? `<span>Observed ${escapeHtml(formatObservedAt(asset.observedAt))}</span>` : '',
    asset.notes ? `<span>${escapeHtml(asset.notes)}</span>` : '',
  ].filter(Boolean);
  return `<div class="ops-map-popup">${lines.join('')}</div>`;
}

function aircraftPopupHtml(asset: MapAsset) {
  const trailCount = asset.trail?.length ?? 0;
  const lines = [
    `<strong>${escapeHtml(asset.title)}</strong>`,
    asset.sourceName ? `<span>${escapeHtml(asset.sourceName)}</span>` : '',
    asset.status ? `<span>${escapeHtml(asset.status)}</span>` : '',
    asset.altitude != null ? `<span>Altitude ${Math.round(asset.altitude)} ft</span>` : '',
    asset.speed != null ? `<span>Speed ${Math.round(asset.speed)} kt</span>` : '',
    asset.heading != null ? `<span>Heading ${Math.round(asset.heading)}°</span>` : '',
    trailCount ? `<span>Trail ${trailCount} points</span>` : '',
    asset.observedAt ? `<span>Observed ${escapeHtml(formatObservedAt(asset.observedAt))}</span>` : '',
  ].filter(Boolean);
  return `<div class="ops-map-popup">${lines.join('')}</div>`;
}

function aqiPopupHtml(point: OverlayPoint, sourceLabel: string, sourceUrl: string, generatedAt: string) {
  const label = point.usAqi != null ? `US AQI ${Math.round(point.usAqi)}` : point.europeanAqi != null ? `European AQI ${Math.round(point.europeanAqi)}` : 'AQI unavailable';
  const lines = [
    `<strong>${escapeHtml(label)}</strong>`,
    `<span>Band ${escapeHtml(point.band)}</span>`,
    `<span>Source ${escapeHtml(sourceLabel)}</span>`,
    point.observedAt ? `<span>Observed ${escapeHtml(formatObservedAt(point.observedAt))}</span>` : '',
    `<span>Generated ${escapeHtml(formatObservedAt(generatedAt))}</span>`,
    `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>`,
  ];
  return `<div class="ops-map-popup">${lines.join('')}</div>`;
}

function makePlaneIcon(L: LeafletApi, heading: number | null | undefined, color: string) {
  return L.divIcon({
    className: 'ops-map-div-icon ops-map-div-icon-aircraft',
    html: `
      <div class="ops-map-icon ops-map-icon-aircraft" style="--ops-marker-color: ${color}; --ops-heading: ${Number.isFinite(heading ?? NaN) ? `${heading}deg` : '0deg'};">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="${AIRCRAFT_PATH}"></path>
        </svg>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -12],
  });
}

function makePoiIcon(L: LeafletApi, color: string) {
  return L.divIcon({
    className: 'ops-map-div-icon ops-map-div-icon-poi',
    html: `
      <div class="ops-map-icon ops-map-icon-poi" style="--ops-marker-color: ${color};">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="${MAP_PIN_PATH}"></path>
          <circle cx="12" cy="10" r="3.1"></circle>
        </svg>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 29],
    popupAnchor: [0, -24],
  });
}

function formatBoundsParams(map: LeafletMapInstance) {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

export default function LeafletMap({
  assets,
  selectedAssetId,
  onMapClick,
  onSelectAsset,
  airQualityEnabled = false,
  timeWindowStart,
  timeWindowEnd,
  timeWindowLabel,
}: LeafletMapProps) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMapInstance | null>(null);
  const baseLayerRef = useRef<LeafletLayer | null>(null);
  const overlayLayerRef = useRef<LeafletLayer & { clearLayers?: () => void } | null>(null);
  const assetLayerRef = useRef<Record<string, LayerBundle>>({});
  const baseProviderIndexRef = useRef(0);
  const baseLoadSuccessRef = useRef(false);
  const baseErrorCountRef = useRef(0);
  const baseFallbackTimeoutRef = useRef<number | null>(null);
  const overlayRequestIdRef = useRef(0);
  const overlayAbortRef = useRef<AbortController | null>(null);
  const overlayTimerRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const initialViewAppliedRef = useRef(false);
  const [mapReadyTick, setMapReadyTick] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [baseLayerState, setBaseLayerState] = useState<BaseLayerState>({
    phase: 'loading',
    name: 'Base map',
    detail: 'Initializing map tiles...',
  });
  const [overlayState, setOverlayState] = useState<OverlayState>({
    phase: airQualityEnabled ? 'loading' : 'off',
    name: 'Air Quality / AQI',
    detail: airQualityEnabled ? 'Waiting for overlay data...' : 'Off',
  });

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [assets, selectedAssetId],
  );

  const visibleAssetCoords = useMemo(
    () => assets.map((asset) => [asset.lat, asset.lng] as [number, number]),
    [assets],
  );

  const clearLayerBundle = useCallback((bundle: LayerBundle | undefined) => {
    if (!bundle) return;
    bundle.trail?.remove?.();
    bundle.marker.remove?.();
  }, []);

  const clearAssetLayers = useCallback(() => {
    const current = assetLayerRef.current;
    Object.values(current).forEach((bundle) => clearLayerBundle(bundle));
    assetLayerRef.current = {};
  }, [clearLayerBundle]);

  const clearOverlay = useCallback(() => {
    overlayAbortRef.current?.abort();
    overlayAbortRef.current = null;
    overlayLayerRef.current?.clearLayers?.();
  }, []);

  const setBaseLayer = useCallback((map: LeafletMapInstance, L: LeafletApi, providerIndex: number) => {
    const provider = TILE_PROVIDERS[Math.max(0, Math.min(providerIndex, TILE_PROVIDERS.length - 1))];
    baseProviderIndexRef.current = providerIndex;
    baseLoadSuccessRef.current = false;
    baseErrorCountRef.current = 0;
    if (baseLayerRef.current) {
      baseLayerRef.current.remove?.();
      baseLayerRef.current = null;
    }

    const layer = L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: provider.maxZoom,
      updateWhenIdle: true,
      keepBuffer: 4,
      detectRetina: true,
      crossOrigin: true,
    });

    layer.on('load', () => {
      if (baseFallbackTimeoutRef.current != null) {
        window.clearTimeout(baseFallbackTimeoutRef.current);
        baseFallbackTimeoutRef.current = null;
      }
      baseLoadSuccessRef.current = true;
      setBaseLayerState({
        phase: providerIndex > 0 ? 'fallback' : 'ready',
        name: provider.name,
        detail: providerIndex > 0
          ? `Fallback tiles loaded from ${provider.name}.`
          : `Tiles loaded from ${provider.name}.`,
      });
    });

    layer.on('tileerror', () => {
      baseErrorCountRef.current += 1;
      if (baseLoadSuccessRef.current) return;
      if (baseFallbackTimeoutRef.current != null) return;

      baseFallbackTimeoutRef.current = window.setTimeout(() => {
        baseFallbackTimeoutRef.current = null;
        if (baseLoadSuccessRef.current) return;
        const nextIndex = providerIndex + 1;
        if (nextIndex < TILE_PROVIDERS.length) {
          setBaseLayer(map, L, nextIndex);
          setBaseLayerState({
            phase: 'fallback',
            name: TILE_PROVIDERS[nextIndex].name,
            detail: `Switching to ${TILE_PROVIDERS[nextIndex].name} after tile errors from ${provider.name}.`,
          });
          return;
        }

        setBaseLayerState({
          phase: 'error',
          name: provider.name,
          detail: `Map tiles could not be loaded from ${provider.name}. The basemap is unavailable.`,
        });
      }, 1800);
    });

    layer.addTo(map);
    baseLayerRef.current = layer;
    setBaseLayerState({
      phase: providerIndex > 0 ? 'fallback' : 'loading',
      name: provider.name,
      detail: providerIndex > 0
        ? `Using fallback tile provider ${provider.name}...`
        : `Loading ${provider.name} tiles...`,
    });
  }, []);

  const refreshOverlay = useCallback(async () => {
    const map = mapRef.current;
    const L = window.L;
    if (!map || !L || !airQualityEnabled) return;

    overlayRequestIdRef.current += 1;
    const requestId = overlayRequestIdRef.current;
    overlayAbortRef.current?.abort();
    const controller = new AbortController();
    overlayAbortRef.current = controller;
    const bounds = formatBoundsParams(map);

    setOverlayState({
      phase: 'loading',
      name: 'Air Quality / AQI',
      detail: `Loading AQI samples for the visible map bounds${timeWindowLabel ? ` · ${timeWindowLabel}` : ''}...`,
    });

    try {
      const url = new URL('/api/map/air-quality', window.location.origin);
      url.searchParams.set('west', String(bounds.west));
      url.searchParams.set('south', String(bounds.south));
      url.searchParams.set('east', String(bounds.east));
      url.searchParams.set('north', String(bounds.north));
      url.searchParams.set('zoom', String(map.getZoom()));

      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`AQI request failed with HTTP ${response.status}`);
      }

      const payload = await response.json() as { ok?: boolean; overlay?: AirQualitySnapshot; error?: string };
      if (requestId !== overlayRequestIdRef.current || controller.signal.aborted) return;
      const overlay = payload.overlay;
      if (!payload.ok || !overlay) {
        throw new Error(payload.error || 'AQI overlay unavailable');
      }

      const filteredPoints = overlay.points.filter((point) => rangeContains(point.observedAt, timeWindowStart, timeWindowEnd));
      overlayLayerRef.current?.clearLayers?.();

      if (!filteredPoints.length) {
        setOverlayState({
          phase: 'empty',
          name: overlay.sourceLabel,
          detail: overlay.emptyReason || 'No AQI values fall within the active date window.',
        });
        return;
      }

      const overlayLayer = overlayLayerRef.current ?? L.layerGroup().addTo(map);
      overlayLayerRef.current = overlayLayer;

      filteredPoints.forEach((point) => {
        const color = AQI_COLORS[point.band] ?? AQI_COLORS.unknown;
        const radius = point.band === 'hazardous' ? 12 : point.band === 'very-unhealthy' ? 11 : point.band === 'unhealthy' ? 10 : point.band === 'usg' ? 9 : 8;
        const marker = L.circleMarker([point.lat, point.lng], {
          radius,
          weight: 1.2,
          color,
          fillColor: color,
          fillOpacity: 0.34,
          opacity: 0.9,
          pane: 'overlayPane',
        });
        marker.bindPopup(aqiPopupHtml(point, overlay.sourceLabel, overlay.sourceUrl, overlay.generatedAt), { maxWidth: 280 });
        overlayLayer.addLayer?.(marker);
      });

      setOverlayState({
        phase: 'ready',
        name: overlay.sourceLabel,
        detail: `${filteredPoints.length} AQI samples loaded from ${overlay.sourceName}.`,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setOverlayState({
        phase: 'error',
        name: 'Air Quality / AQI',
        detail: error instanceof Error ? error.message : 'AQI overlay unavailable',
      });
      overlayLayerRef.current?.clearLayers?.();
    }
  }, [airQualityEnabled, timeWindowEnd, timeWindowLabel, timeWindowStart]);

  useEffect(() => {
    let disposed = false;
    void ensureLeaflet()
      .then((L) => {
        if (!outerRef.current || disposed || mapRef.current) return;

        const map = L.map(outerRef.current, {
          zoomControl: true,
          attributionControl: true,
          scrollWheelZoom: true,
          worldCopyJump: true,
          preferCanvas: true,
        });

        map.setView([20, 0], 2);
        mapRef.current = map;
        overlayLayerRef.current = L.layerGroup().addTo(map);
        setMapReadyTick((current) => current + 1);
        setBaseLayer(map, L, 0);

        map.on('click', (event: { latlng: { lat: number; lng: number } }) => {
          onMapClick(event.latlng.lat, event.latlng.lng);
        });

        const resize = () => {
          window.requestAnimationFrame(() => map.invalidateSize({ pan: false }));
        };

        if (typeof ResizeObserver !== 'undefined') {
          resizeObserverRef.current = new ResizeObserver(() => resize());
          if (outerRef.current) resizeObserverRef.current.observe(outerRef.current);
        } else {
          window.addEventListener('resize', resize);
        }

        resize();
      })
      .catch((error) => {
        if (disposed) return;
        setRuntimeError(error instanceof Error ? error.message : 'Map runtime unavailable');
        setBaseLayerState({
          phase: 'error',
          name: 'Leaflet',
          detail: error instanceof Error ? error.message : 'Map runtime unavailable',
        });
      });

    return () => {
      disposed = true;
      overlayAbortRef.current?.abort();
      overlayAbortRef.current = null;
      overlayLayerRef.current?.clearLayers?.();
      clearAssetLayers();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (baseFallbackTimeoutRef.current != null) {
        window.clearTimeout(baseFallbackTimeoutRef.current);
        baseFallbackTimeoutRef.current = null;
      }
      if (overlayTimerRef.current != null) {
        window.clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove?.();
        mapRef.current = null;
      }
    };
  }, [clearAssetLayers, onMapClick, setBaseLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;

    clearAssetLayers();

    const L = window.L;
    const nextBundles: Record<string, LayerBundle> = {};

    assets.forEach((asset) => {
      const color = markerColor(asset);
      const isAircraft = asset.sourceId === 'trackedflights';
      const isSavedPoi = asset.sourceId === 'manual';
      const point = [asset.lat, asset.lng] as [number, number];
      const trail = Array.isArray(asset.trail) && asset.trail.length > 1
        ? asset.trail.map((entry) => [entry.lat, entry.lng] as [number, number])
        : null;

      let marker: LeafletLayer;
      if (isAircraft) {
        marker = L.marker(point, {
          icon: makePlaneIcon(L, asset.heading, color),
          riseOnHover: true,
          keyboard: false,
        });
      } else if (isSavedPoi) {
        marker = L.marker(point, {
          icon: makePoiIcon(L, color),
          riseOnHover: true,
          keyboard: false,
        });
      } else {
        marker = L.circleMarker(point, {
          radius: asset.severity === 'critical' ? 9 : asset.severity === 'warning' ? 8 : asset.severity === 'watch' ? 7.5 : 7,
          weight: 1.4,
          color,
          fillColor: color,
          fillOpacity: 0.82,
          opacity: 0.92,
          pane: 'overlayPane',
        });
      }

      marker.addTo(map);
      marker.bindPopup(isAircraft ? aircraftPopupHtml(asset) : sourcePopupHtml(asset), { maxWidth: 320 });
      marker.on('click', () => onSelectAsset(asset));

      let trailLayer: LeafletLayer | undefined;
      if (trail) {
        trailLayer = L.polyline(trail, {
          color,
          weight: isAircraft ? 3.5 : 2.6,
          opacity: selectedAssetId === asset.id ? 0.95 : 0.7,
          lineCap: 'round',
          lineJoin: 'round',
          dashArray: isAircraft ? '7 10' : undefined,
          pane: 'overlayPane',
        });
        trailLayer.addTo(map);
        trailLayer.on('click', () => onSelectAsset(asset));
      }

      nextBundles[asset.id] = { marker, trail: trailLayer, kind: isAircraft ? 'aircraft' : isSavedPoi ? 'poi' : 'point' };
    });

    assetLayerRef.current = nextBundles;

    if (!initialViewAppliedRef.current && assets.length > 0) {
      initialViewAppliedRef.current = true;
      if (assets.length === 1) {
        map.setView([assets[0].lat, assets[0].lng], assets[0].sourceId === 'trackedflights' ? 7 : 8);
      } else if (visibleAssetCoords.length > 1) {
      map.fitBounds(window.L.latLngBounds(visibleAssetCoords).pad(0.1), { maxZoom: 8 });
      }
    }
  }, [assets, clearAssetLayers, mapReadyTick, onSelectAsset, selectedAssetId, visibleAssetCoords]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L || !selectedAsset) return;
    const bundle = assetLayerRef.current[selectedAsset.id];
    if (!bundle) return;

    bundle.marker.openPopup?.();

    if (selectedAsset.trail?.length && selectedAsset.sourceId === 'trackedflights') {
      const bounds = window.L.latLngBounds(selectedAsset.trail.map((point) => [point.lat, point.lng] as [number, number]));
      map.fitBounds(bounds.pad(0.16), { maxZoom: 8 });
      return;
    }

    const targetZoom = selectedAsset.sourceId === 'manual' ? 9 : selectedAsset.sourceId === 'trackedflights' ? 7 : 8;
    if (map.flyTo) {
      map.flyTo([selectedAsset.lat, selectedAsset.lng], targetZoom, { animate: true, duration: 0.7 });
    } else {
      map.setView([selectedAsset.lat, selectedAsset.lng], targetZoom);
    }
  }, [mapReadyTick, selectedAsset]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;

    Object.entries(assetLayerRef.current).forEach(([id, bundle]) => {
      const asset = assets.find((entry) => entry.id === id);
      if (!asset) return;
      const isSelected = id === selectedAssetId;
      if (bundle.marker.setStyle && bundle.kind === 'point') {
        bundle.marker.setStyle({
          radius: isSelected ? 9 : 7,
          weight: isSelected ? 1.8 : 1.4,
        });
      }
      if (bundle.marker.bringToFront && isSelected) {
        bundle.marker.bringToFront();
      }
      if (bundle.trail?.setStyle) {
        bundle.trail.setStyle({
          opacity: isSelected ? 0.95 : 0.7,
          weight: asset.sourceId === 'trackedflights' ? (isSelected ? 4 : 3.5) : isSelected ? 3.2 : 2.6,
        });
      }
    });
  }, [assets, selectedAssetId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;

    if (!airQualityEnabled) {
      clearOverlay();
      setOverlayState({
        phase: 'off',
        name: 'Air Quality / AQI',
        detail: 'Overlay off.',
      });
      return;
    }

    const schedule = () => {
      if (overlayTimerRef.current != null) {
        window.clearTimeout(overlayTimerRef.current);
      }
      overlayTimerRef.current = window.setTimeout(() => {
        overlayTimerRef.current = null;
        void refreshOverlay();
      }, 240);
    };

    map.on('moveend', schedule);
    map.on('zoomend', schedule);
    schedule();

    return () => {
      map.off('moveend', schedule);
      map.off('zoomend', schedule);
      if (overlayTimerRef.current != null) {
        window.clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
      overlayAbortRef.current?.abort();
    };
  }, [airQualityEnabled, clearOverlay, refreshOverlay, timeWindowEnd, timeWindowStart]);

  const baseStatusTone = baseLayerState.phase === 'error'
    ? 'error'
    : baseLayerState.phase === 'fallback'
      ? 'warn'
      : baseLayerState.phase === 'loading'
        ? 'loading'
        : 'ok';

  const overlayStatusTone = overlayState.phase === 'error'
    ? 'error'
    : overlayState.phase === 'empty'
      ? 'warn'
      : overlayState.phase === 'loading'
        ? 'loading'
        : overlayState.phase === 'ready'
          ? 'ok'
          : 'muted';

  return (
    <div className="ops-map-canvas">
      <div ref={outerRef} className="ops-map-canvas-surface" />

      <div className="ops-map-status-stack" aria-live="polite">
        <div className="ops-map-status-chip" data-tone={baseStatusTone}>
          <strong>{baseLayerState.name}</strong>
          <span>{runtimeError ? runtimeError : baseLayerState.detail}</span>
        </div>
        <div className="ops-map-status-chip" data-tone={overlayStatusTone}>
          <strong>{overlayState.name}</strong>
          <span>
            {airQualityEnabled ? overlayState.detail : 'Overlay off.'}
            {timeWindowLabel ? ` · ${timeWindowLabel}` : ''}
          </span>
        </div>
        {assets.length === 0 ? (
          <div className="ops-map-status-chip muted" data-tone="muted">
            <strong>No visible records</strong>
            <span>The current filter does not leave any map records to render.</span>
          </div>
        ) : null}
      </div>

      {(baseLayerState.phase === 'error' || runtimeError) ? (
        <div className="ops-map-center-note">
          <strong>Map tiles unavailable</strong>
          <span>The basemap provider could not be reached. Marker data can still refresh once a provider recovers.</span>
        </div>
      ) : null}
    </div>
  );
}
