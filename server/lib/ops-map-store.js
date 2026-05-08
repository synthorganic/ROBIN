import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { broadcast } from '../routes/events.js';
export const OPS_MAP_ASSET_TYPES = ['document', 'video', 'note', 'link'];
const STORE_DIR = path.join(config.home, '.nerve', 'inertiai-ops');
const STORE_FILE = path.join(STORE_DIR, 'map-assets.json');
function isAssetType(value) {
    return typeof value === 'string' && OPS_MAP_ASSET_TYPES.includes(value);
}
function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizeOptionalString(value) {
    const normalized = normalizeString(value);
    return normalized || undefined;
}
function normalizeTags(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return Array.from(new Set(value
        .map((tag) => normalizeString(tag))
        .filter(Boolean)));
}
function normalizeCoordinate(value) {
    const next = Number(value);
    return Number.isFinite(next) ? next : 0;
}
function sortAssets(assets) {
    assets.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}
function normalizeAssetRecord(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value;
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
        thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
        notes: normalizeOptionalString(record.notes),
        tags: normalizeTags(record.tags),
        status: normalizeOptionalString(record.status),
        linkedSessionId: normalizeOptionalString(record.linkedSessionId),
    };
}
function normalizeStoreShape(value) {
    if (!value || typeof value !== 'object') {
        return { assets: [] };
    }
    const record = value;
    const assets = Array.isArray(record.assets)
        ? record.assets
            .map((asset) => normalizeAssetRecord(asset))
            .filter((asset) => Boolean(asset))
        : [];
    sortAssets(assets);
    return { assets };
}
function normalizeAssetInput(input) {
    return {
        title: normalizeString(input.title),
        type: input.type,
        lat: normalizeCoordinate(input.lat),
        lng: normalizeCoordinate(input.lng),
        sourceUrl: normalizeString(input.sourceUrl),
        thumbnailUrl: normalizeOptionalString(input.thumbnailUrl),
        notes: normalizeOptionalString(input.notes),
        tags: normalizeTags(input.tags),
        status: normalizeOptionalString(input.status),
        linkedSessionId: normalizeOptionalString(input.linkedSessionId),
    };
}
class OpsMapStore {
    cache = null;
    async list() {
        const store = await this.read();
        return store.assets;
    }
    async layers() {
        const assets = await this.list();
        return [
            { id: 'documents', name: 'Documents', visible: true, assetIds: assets.filter((asset) => asset.type === 'document').map((asset) => asset.id) },
            { id: 'videos', name: 'Video Feeds', visible: true, assetIds: assets.filter((asset) => asset.type === 'video').map((asset) => asset.id) },
            { id: 'notes', name: 'Notes', visible: true, assetIds: assets.filter((asset) => asset.type === 'note').map((asset) => asset.id) },
            { id: 'links', name: 'Links', visible: true, assetIds: assets.filter((asset) => asset.type === 'link').map((asset) => asset.id) },
        ];
    }
    async create(input) {
        const store = await this.read();
        const asset = {
            ...normalizeAssetInput(input),
            id: `asset-${randomUUID().slice(0, 10)}`,
        };
        store.assets.push(asset);
        sortAssets(store.assets);
        await this.write(store);
        await this.emit(store.assets);
        return asset;
    }
    async update(id, patch) {
        const store = await this.read();
        const index = store.assets.findIndex((asset) => asset.id === id);
        if (index === -1)
            throw new Error(`Asset '${id}' not found`);
        store.assets[index] = {
            ...store.assets[index],
            ...(patch.title != null ? { title: normalizeString(patch.title) } : {}),
            ...(patch.type != null ? { type: patch.type } : {}),
            ...(patch.lat != null ? { lat: normalizeCoordinate(patch.lat) } : {}),
            ...(patch.lng != null ? { lng: normalizeCoordinate(patch.lng) } : {}),
            ...(patch.sourceUrl != null ? { sourceUrl: normalizeString(patch.sourceUrl) } : {}),
            ...(patch.thumbnailUrl !== undefined ? { thumbnailUrl: normalizeOptionalString(patch.thumbnailUrl) } : {}),
            ...(patch.notes !== undefined ? { notes: normalizeOptionalString(patch.notes) } : {}),
            ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
            ...(patch.status !== undefined ? { status: normalizeOptionalString(patch.status) } : {}),
            ...(patch.linkedSessionId !== undefined ? { linkedSessionId: normalizeOptionalString(patch.linkedSessionId) } : {}),
            id,
        };
        sortAssets(store.assets);
        await this.write(store);
        await this.emit(store.assets);
        return store.assets[index];
    }
    async remove(id) {
        const store = await this.read();
        const nextAssets = store.assets.filter((asset) => asset.id !== id);
        store.assets = nextAssets;
        await this.write(store);
        await this.emit(store.assets);
    }
    async read() {
        if (this.cache)
            return this.cache;
        await mkdir(STORE_DIR, { recursive: true });
        try {
            const raw = await readFile(STORE_FILE, 'utf8');
            this.cache = normalizeStoreShape(JSON.parse(raw));
        }
        catch {
            this.cache = { assets: [] };
            await this.write(this.cache);
        }
        return this.cache;
    }
    async write(store) {
        this.cache = store;
        await mkdir(STORE_DIR, { recursive: true });
        await writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
    }
    async emit(assets) {
        broadcast('ops.map.updated', {
            assets,
            layers: await this.layers(),
            ts: Date.now(),
        });
    }
}
export const opsMapStore = new OpsMapStore();
