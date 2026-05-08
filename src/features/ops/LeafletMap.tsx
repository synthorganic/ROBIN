import { useEffect, useRef } from 'react';
import type { MapAsset } from './api';

interface LeafletMarker {
  addTo: (map: LeafletMapInstance) => LeafletMarker;
  bindPopup: (html: string) => LeafletMarker;
  on: (event: string, handler: () => void) => void;
  openPopup?: () => LeafletMarker;
  remove?: () => void;
}

interface LeafletMapInstance {
  setView: (coords: [number, number], zoom: number) => void;
  on: (event: string, handler: (event: { latlng: { lat: number; lng: number } }) => void) => void;
  remove?: () => void;
}

interface LeafletApi {
  map: (element: HTMLElement) => LeafletMapInstance;
  tileLayer: (url: string, options: Record<string, unknown>) => { addTo: (map: LeafletMapInstance) => void };
  marker: (coords: [number, number]) => LeafletMarker;
  circleMarker?: (coords: [number, number], options: Record<string, unknown>) => LeafletMarker;
}

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

function ensureLeaflet(): Promise<LeafletApi> {
  return new Promise((resolve, reject) => {
    const resolveLeaflet = () => {
      if (window.L) {
        resolve(window.L);
        return;
      }
      reject(new Error('Leaflet did not initialize'));
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

interface LeafletMapProps {
  assets: MapAsset[];
  selectedAssetId?: string | null;
  onMapClick: (lat: number, lng: number) => void;
  onSelectAsset: (asset: MapAsset) => void;
}

const SOURCE_COLORS: Record<string, string> = {
  gdelt: '#74d7ff',
  gdacs: '#ffcf66',
  usgs: '#ff8f5d',
  nws: '#76ff9f',
  firms: '#ff6d72',
  manual: '#d8ff7f',
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markerColor(asset: MapAsset) {
  if (asset.severity === 'critical') return '#ff3d48';
  if (asset.severity === 'warning') return '#ffb347';
  if (asset.severity === 'watch') return '#d8ff7f';
  return SOURCE_COLORS[asset.sourceId || 'manual'] ?? '#74d7ff';
}

export default function LeafletMap({ assets, selectedAssetId, onMapClick, onSelectAsset }: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMapInstance | null>(null);
  const markersRef = useRef<Record<string, LeafletMarker>>({});

  useEffect(() => {
    let disposed = false;
    void ensureLeaflet()
      .then((L) => {
        if (!containerRef.current || disposed || mapRef.current) return;

        const map = L.map(containerRef.current);
        map.setView([44.6, 31.2], 5);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri',
        }).addTo(map);

        map.on('click', (event: { latlng: { lat: number; lng: number } }) => {
          onMapClick(event.latlng.lat, event.latlng.lng);
        });

        mapRef.current = map;
      })
      .catch(() => {
        // Ignore load failures and leave the empty panel visible.
      });

    return () => {
      disposed = true;
      mapRef.current?.remove?.();
      mapRef.current = null;
    };
  }, [onMapClick]);

  useEffect(() => {
    const L = window.L;
    const map = mapRef.current;
    if (!L || !map) return;

    Object.values(markersRef.current).forEach((marker) => marker.remove?.());
    markersRef.current = assets.reduce<Record<string, LeafletMarker>>((acc, asset) => {
      const popup = [
        `<strong>${escapeHtml(asset.title)}</strong>`,
        escapeHtml(asset.sourceName || asset.type),
        asset.status ? `<em>${escapeHtml(asset.status)}</em>` : '',
      ]
        .filter(Boolean)
        .join('<br/>');
      const color = markerColor(asset);
      const marker = (asset.live && L.circleMarker
        ? L.circleMarker([asset.lat, asset.lng], {
          radius: asset.severity === 'critical' ? 9 : 7,
          weight: 1.5,
          color,
          fillColor: color,
          fillOpacity: 0.72,
        })
        : L.marker([asset.lat, asset.lng])).addTo(map).bindPopup(popup);
      marker.on('click', () => onSelectAsset(asset));
      acc[asset.id] = marker;
      return acc;
    }, {});
  }, [assets, onSelectAsset]);

  useEffect(() => {
    if (!selectedAssetId || !mapRef.current) return;
    const asset = assets.find((entry) => entry.id === selectedAssetId);
    const marker = markersRef.current[selectedAssetId];
    if (!asset || !marker) return;
    mapRef.current.setView([asset.lat, asset.lng], 8);
    marker.openPopup?.();
  }, [assets, selectedAssetId]);

  useEffect(() => {
    if (selectedAssetId || !mapRef.current || assets.length === 0) return;
    const [firstAsset] = assets;
    mapRef.current.setView([firstAsset.lat, firstAsset.lng], 6);
  }, [assets, selectedAssetId]);

  return <div ref={containerRef} className="ops-map-canvas" />;
}
