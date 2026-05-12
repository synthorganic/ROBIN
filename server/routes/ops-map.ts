import { Hono } from 'hono';
import { OPS_MAP_ASSET_TYPES, buildOpsMapLayers, opsMapStore, type OpsMapAsset } from '../lib/ops-map-store.js';
import { opsGeoSourceService } from '../lib/ops-geo-sources.js';
import { fetchAirQualityOverlay } from '../lib/ops-air-quality.js';
import { broadcast } from './events.js';

const app = new Hono();

function isAssetType(value: unknown): value is typeof OPS_MAP_ASSET_TYPES[number] {
  return typeof value === 'string' && OPS_MAP_ASSET_TYPES.includes(value as typeof OPS_MAP_ASSET_TYPES[number]);
}

function isSeverity(value: unknown): value is NonNullable<OpsMapAsset['severity']> {
  return value === 'info' || value === 'watch' || value === 'warning' || value === 'critical';
}

function isConfidence(value: unknown): value is NonNullable<OpsMapAsset['confidence']> {
  return value === 'low' || value === 'medium' || value === 'high';
}

async function getMapSnapshot(forceSources = false, includeLive = true) {
  const manualAssets = await opsMapStore.list();
  if (!includeLive) {
    return {
      assets: manualAssets,
      layers: buildOpsMapLayers(manualAssets),
      sources: await opsGeoSourceService.sourceStatuses(false),
    };
  }

  const liveSnapshot = await opsGeoSourceService.snapshot(forceSources);
  const assets = [...manualAssets, ...liveSnapshot.assets];
  return {
    assets,
    layers: buildOpsMapLayers(assets),
    sources: liveSnapshot.sources,
  };
}

async function emitMapSnapshot() {
  const snapshot = await getMapSnapshot(false, true);
  broadcast('ops.map.updated', {
    ...snapshot,
    ts: Date.now(),
  });
}

app.get('/api/map/assets', async (c) => {
  const snapshot = await getMapSnapshot(false, c.req.query('live') !== 'false');
  return c.json({ ok: true, assets: snapshot.assets });
});

app.get('/api/map/layers', async (c) => {
  const snapshot = await getMapSnapshot(false, c.req.query('live') !== 'false');
  return c.json({ ok: true, layers: snapshot.layers });
});

app.get('/api/map/sources', async (c) => {
  const snapshot = await getMapSnapshot(false, true);
  return c.json({ ok: true, sources: snapshot.sources });
});

app.post('/api/map/sources/refresh', async (c) => {
  const snapshot = await getMapSnapshot(true, true);
  broadcast('ops.map.updated', {
    ...snapshot,
    ts: Date.now(),
  });
  return c.json({ ok: true, ...snapshot });
});

app.get('/api/map/air-quality', async (c) => {
  const west = Number(c.req.query('west'));
  const south = Number(c.req.query('south'));
  const east = Number(c.req.query('east'));
  const north = Number(c.req.query('north'));
  const zoom = Number(c.req.query('zoom') ?? 4);
  if (![west, south, east, north, zoom].every((value) => Number.isFinite(value))) {
    return c.json({ ok: false, error: 'west, south, east, north, and zoom are required' }, 400);
  }

  const overlay = await fetchAirQualityOverlay({ west, south, east, north, zoom });
  return c.json({ ok: true, overlay });
});

app.post('/api/map/assets', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.title !== 'string' || !isAssetType(body.type)) {
    return c.json({ ok: false, error: 'title and type are required' }, 400);
  }

  const asset = await opsMapStore.create({
    title: body.title.trim(),
    type: body.type,
    lat: Number(body.lat) || 0,
    lng: Number(body.lng) || 0,
    sourceUrl: String(body.sourceUrl ?? ''),
    streamUrl: typeof body.streamUrl === 'string' ? body.streamUrl : undefined,
    thumbnailUrl: typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl : undefined,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag)) : [],
    status: typeof body.status === 'string' ? body.status : undefined,
    linkedSessionId: typeof body.linkedSessionId === 'string' ? body.linkedSessionId : undefined,
    sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
    sourceName: typeof body.sourceName === 'string' ? body.sourceName : undefined,
    severity: isSeverity(body.severity) ? body.severity : undefined,
    confidence: isConfidence(body.confidence) ? body.confidence : undefined,
    observedAt: typeof body.observedAt === 'string' ? body.observedAt : undefined,
    live: body.live === true,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : undefined,
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
    heading: typeof body.heading === 'number' ? body.heading : Number(body.heading),
    speed: typeof body.speed === 'number' ? body.speed : Number(body.speed),
    altitude: typeof body.altitude === 'number' ? body.altitude : Number(body.altitude),
    trail: Array.isArray(body.trail) ? body.trail : undefined,
  });

  void emitMapSnapshot();
  return c.json({ ok: true, asset });
});

app.put('/api/map/assets/:id', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.type != null && !isAssetType(body.type)) {
      return c.json({ ok: false, error: `Unsupported asset type '${String(body.type)}'` }, 400);
    }

    const asset = await opsMapStore.update(c.req.param('id'), {
      ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
      ...(isAssetType(body.type) ? { type: body.type } : {}),
      ...(body.lat != null ? { lat: Number(body.lat) || 0 } : {}),
      ...(body.lng != null ? { lng: Number(body.lng) || 0 } : {}),
      ...(typeof body.sourceUrl === 'string' ? { sourceUrl: body.sourceUrl } : {}),
      ...(typeof body.streamUrl === 'string' ? { streamUrl: body.streamUrl } : {}),
      ...(typeof body.thumbnailUrl === 'string' ? { thumbnailUrl: body.thumbnailUrl } : {}),
      ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.map((tag) => String(tag)) } : {}),
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(typeof body.linkedSessionId === 'string' ? { linkedSessionId: body.linkedSessionId } : {}),
      ...(typeof body.sourceId === 'string' ? { sourceId: body.sourceId } : {}),
      ...(typeof body.sourceName === 'string' ? { sourceName: body.sourceName } : {}),
      ...(isSeverity(body.severity) ? { severity: body.severity } : {}),
      ...(isConfidence(body.confidence) ? { confidence: body.confidence } : {}),
      ...(typeof body.observedAt === 'string' ? { observedAt: body.observedAt } : {}),
      ...(typeof body.live === 'boolean' ? { live: body.live } : {}),
      ...(typeof body.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
      ...(typeof body.heading === 'number' || typeof body.heading === 'string' ? { heading: Number(body.heading) } : {}),
      ...(typeof body.speed === 'number' || typeof body.speed === 'string' ? { speed: Number(body.speed) } : {}),
      ...(typeof body.altitude === 'number' || typeof body.altitude === 'string' ? { altitude: Number(body.altitude) } : {}),
      ...(Array.isArray(body.trail) ? { trail: body.trail } : {}),
    });
    void emitMapSnapshot();
    return c.json({ ok: true, asset });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 404);
  }
});

app.delete('/api/map/assets/:id', async (c) => {
  await opsMapStore.remove(c.req.param('id'));
  void emitMapSnapshot();
  return c.json({ ok: true });
});

export default app;
