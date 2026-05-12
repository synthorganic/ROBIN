import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { broadcast } from '../routes/events.js';

export const OPS_MAP_ASSET_TYPES = ['document', 'video', 'note', 'link'] as const;
export type OpsMapAssetType = typeof OPS_MAP_ASSET_TYPES[number];

export interface OpsMapAsset {
  id: string;
  title: string;
  type: OpsMapAssetType;
  lat: number;
  lng: number;
  sourceUrl: string;
  streamUrl?: string;
  thumbnailUrl?: string;
  notes?: string;
  tags: string[];
  status?: string;
  linkedSessionId?: string;
  sourceId?: string;
  sourceName?: string;
  severity?: 'info' | 'watch' | 'warning' | 'critical';
  confidence?: 'low' | 'medium' | 'high';
  observedAt?: string;
  live?: boolean;
  createdAt?: string;
  updatedAt?: string;
  heading?: number;
  speed?: number;
  altitude?: number;
  trail?: Array<{ lat: number; lng: number; observedAt?: string }>;
}

export interface OpsMapLayer {
  id: string;
  name: string;
  visible: boolean;
  assetIds: string[];
  kind: 'type' | 'source';
  sourceId?: string;
}

interface OpsMapStoreShape {
  assets: OpsMapAsset[];
}

const STORE_DIR = path.join(config.home, '.robin', 'inertiai-ops');
const STORE_FILE = path.join(STORE_DIR, 'map-assets.json');

function isAssetType(value: unknown): value is OpsMapAssetType {
  return typeof value === 'string' && OPS_MAP_ASSET_TYPES.includes(value as OpsMapAssetType);
}

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalString(value: unknown) {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function normalizeOptionalNumber(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((tag) => normalizeString(tag))
        .filter(Boolean),
    ),
  );
}

function normalizeCoordinate(value: unknown) {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function sortAssets(assets: OpsMapAsset[]) {
  assets.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function normalizeAssetRecord(value: unknown): OpsMapAsset | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const title = normalizeString(record.title);
  const type = isAssetType(record.type) ? record.type : null;
  const id = normalizeString(record.id);

  if (!id || !title || !type) {
    return null;
  }

  return {
    id,
    title,
    type,
    lat: normalizeCoordinate(record.lat),
    lng: normalizeCoordinate(record.lng),
    sourceUrl: normalizeString(record.sourceUrl),
    streamUrl: normalizeOptionalString(record.streamUrl),
    thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
    notes: normalizeOptionalString(record.notes),
    tags: normalizeTags(record.tags),
    status: normalizeOptionalString(record.status),
    linkedSessionId: normalizeOptionalString(record.linkedSessionId),
    sourceId: normalizeOptionalString(record.sourceId),
    sourceName: normalizeOptionalString(record.sourceName),
    severity: normalizeSeverity(record.severity),
    confidence: normalizeConfidence(record.confidence),
    observedAt: normalizeOptionalString(record.observedAt),
    live: record.live === true,
    createdAt: normalizeOptionalString(record.createdAt),
    updatedAt: normalizeOptionalString(record.updatedAt),
    heading: normalizeOptionalNumber(record.heading),
    speed: normalizeOptionalNumber(record.speed),
    altitude: normalizeOptionalNumber(record.altitude),
    trail: normalizeTrail(record.trail),
  };
}

function normalizeSeverity(value: unknown): OpsMapAsset['severity'] | undefined {
  if (value === 'info' || value === 'watch' || value === 'warning' || value === 'critical') return value;
  return undefined;
}

function normalizeConfidence(value: unknown): OpsMapAsset['confidence'] | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

function normalizeTrailPoint(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const lat = normalizeOptionalNumber(record.lat);
  const lng = normalizeOptionalNumber(record.lng);
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    observedAt: normalizeOptionalString(record.observedAt),
  };
}

function normalizeTrail(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => normalizeTrailPoint(point))
    .filter((point): point is NonNullable<ReturnType<typeof normalizeTrailPoint>> => Boolean(point));
}

function normalizeStoreShape(value: unknown): OpsMapStoreShape {
  if (!value || typeof value !== 'object') {
    return { assets: [] };
  }

  const record = value as Record<string, unknown>;
  const assets = Array.isArray(record.assets)
    ? record.assets
      .map((asset) => normalizeAssetRecord(asset))
      .filter((asset): asset is OpsMapAsset => Boolean(asset))
    : [];

  sortAssets(assets);
  return { assets };
}

function normalizeAssetInput(input: Omit<OpsMapAsset, 'id'>): Omit<OpsMapAsset, 'id'> {
  return {
    title: normalizeString(input.title),
    type: input.type,
    lat: normalizeCoordinate(input.lat),
    lng: normalizeCoordinate(input.lng),
    sourceUrl: normalizeString(input.sourceUrl),
    streamUrl: normalizeOptionalString(input.streamUrl),
    thumbnailUrl: normalizeOptionalString(input.thumbnailUrl),
    notes: normalizeOptionalString(input.notes),
    tags: normalizeTags(input.tags),
    status: normalizeOptionalString(input.status),
    linkedSessionId: normalizeOptionalString(input.linkedSessionId),
    sourceId: normalizeOptionalString(input.sourceId),
    sourceName: normalizeOptionalString(input.sourceName),
    severity: normalizeSeverity(input.severity),
    confidence: normalizeConfidence(input.confidence),
    observedAt: normalizeOptionalString(input.observedAt),
    live: input.live === true,
    createdAt: normalizeOptionalString(input.createdAt),
    updatedAt: normalizeOptionalString(input.updatedAt),
    heading: normalizeOptionalNumber(input.heading),
    speed: normalizeOptionalNumber(input.speed),
    altitude: normalizeOptionalNumber(input.altitude),
    trail: normalizeTrail(input.trail),
  };
}

export function buildOpsMapLayers(assets: OpsMapAsset[]): OpsMapLayer[] {
  const typeLayers: OpsMapLayer[] = [
    { id: 'documents', name: 'Documents', visible: true, kind: 'type', assetIds: assets.filter((asset) => asset.type === 'document').map((asset) => asset.id) },
    { id: 'videos', name: 'Video Feeds', visible: true, kind: 'type', assetIds: assets.filter((asset) => asset.type === 'video').map((asset) => asset.id) },
    { id: 'notes', name: 'Notes', visible: true, kind: 'type', assetIds: assets.filter((asset) => asset.type === 'note').map((asset) => asset.id) },
    { id: 'links', name: 'Links', visible: true, kind: 'type', assetIds: assets.filter((asset) => asset.type === 'link').map((asset) => asset.id) },
  ];

  const sourceIds = Array.from(new Set(assets.map((asset) => asset.sourceId || 'manual'))).sort();
  const sourceLayers = sourceIds.map((sourceId) => {
    const sourceAssets = assets.filter((asset) => (asset.sourceId || 'manual') === sourceId);
    const label = sourceAssets.find((asset) => asset.sourceName)?.sourceName
      || (sourceId === 'manual' ? 'Operator Assets' : sourceId.toUpperCase());
    return {
      id: `source-${sourceId}`,
      name: label,
      visible: true,
      kind: 'source' as const,
      sourceId,
      assetIds: sourceAssets.map((asset) => asset.id),
    };
  });

  return [...typeLayers, ...sourceLayers];
}

class OpsMapStore {
  private cache: OpsMapStoreShape | null = null;

  async list() {
    const store = await this.read();
    return store.assets;
  }

  async layers() {
    const assets = await this.list();
    return buildOpsMapLayers(assets);
  }

  async create(input: Omit<OpsMapAsset, 'id'>) {
    const store = await this.read();
    const now = new Date().toISOString();
    const asset: OpsMapAsset = {
      ...normalizeAssetInput(input),
      id: `asset-${randomUUID().slice(0, 10)}`,
      createdAt: normalizeOptionalString(input.createdAt) || now,
      updatedAt: now,
    };
    store.assets.push(asset);
    sortAssets(store.assets);
    await this.write(store);
    await this.emit(store.assets);
    return asset;
  }

  async update(id: string, patch: Partial<Omit<OpsMapAsset, 'id'>>) {
    const store = await this.read();
    const index = store.assets.findIndex((asset) => asset.id === id);
    if (index === -1) throw new Error(`Asset '${id}' not found`);

    const now = new Date().toISOString();
    store.assets[index] = {
      ...store.assets[index],
      ...(patch.title != null ? { title: normalizeString(patch.title) } : {}),
      ...(patch.type != null ? { type: patch.type } : {}),
      ...(patch.lat != null ? { lat: normalizeCoordinate(patch.lat) } : {}),
      ...(patch.lng != null ? { lng: normalizeCoordinate(patch.lng) } : {}),
      ...(patch.sourceUrl != null ? { sourceUrl: normalizeString(patch.sourceUrl) } : {}),
      ...(patch.streamUrl !== undefined ? { streamUrl: normalizeOptionalString(patch.streamUrl) } : {}),
      ...(patch.thumbnailUrl !== undefined ? { thumbnailUrl: normalizeOptionalString(patch.thumbnailUrl) } : {}),
      ...(patch.notes !== undefined ? { notes: normalizeOptionalString(patch.notes) } : {}),
      ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
      ...(patch.status !== undefined ? { status: normalizeOptionalString(patch.status) } : {}),
      ...(patch.linkedSessionId !== undefined ? { linkedSessionId: normalizeOptionalString(patch.linkedSessionId) } : {}),
      ...(patch.createdAt !== undefined ? { createdAt: normalizeOptionalString(patch.createdAt) } : {}),
      ...(patch.heading !== undefined ? { heading: normalizeOptionalNumber(patch.heading) } : {}),
      ...(patch.speed !== undefined ? { speed: normalizeOptionalNumber(patch.speed) } : {}),
      ...(patch.altitude !== undefined ? { altitude: normalizeOptionalNumber(patch.altitude) } : {}),
      ...(patch.trail !== undefined ? { trail: normalizeTrail(patch.trail) } : {}),
      updatedAt: now,
      id,
    };

    sortAssets(store.assets);
    await this.write(store);
    await this.emit(store.assets);
    return store.assets[index];
  }

  async remove(id: string) {
    const store = await this.read();
    const nextAssets = store.assets.filter((asset) => asset.id !== id);
    store.assets = nextAssets;
    await this.write(store);
    await this.emit(store.assets);
  }

  private async read() {
    if (this.cache) return this.cache;

    await mkdir(STORE_DIR, { recursive: true });
    try {
      const raw = await readFile(STORE_FILE, 'utf8');
      this.cache = normalizeStoreShape(JSON.parse(raw));
    } catch {
      this.cache = { assets: [] };
      await this.write(this.cache);
    }

    return this.cache;
  }

  private async write(store: OpsMapStoreShape) {
    this.cache = store;
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  }

  private async emit(assets: OpsMapAsset[]) {
    broadcast('ops.map.updated', {
      assets,
      layers: await this.layers(),
      ts: Date.now(),
    });
  }
}

export const opsMapStore = new OpsMapStore();
