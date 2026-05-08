import { Hono } from 'hono';
import { OPS_MAP_ASSET_TYPES, buildOpsMapLayers, opsMapStore } from '../lib/ops-map-store.js';
import { opsGeoSourceService } from '../lib/ops-geo-sources.js';
import { broadcast } from './events.js';

const app = new Hono();

function isAssetType(value: unknown): value is typeof OPS_MAP_ASSET_TYPES[number] {
  return typeof value === 'string' && OPS_MAP_ASSET_TYPES.includes(value as typeof OPS_MAP_ASSET_TYPES[number]);
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
    thumbnailUrl: typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl : undefined,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag)) : [],
    status: typeof body.status === 'string' ? body.status : undefined,
    linkedSessionId: typeof body.linkedSessionId === 'string' ? body.linkedSessionId : undefined,
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
      ...(typeof body.thumbnailUrl === 'string' ? { thumbnailUrl: body.thumbnailUrl } : {}),
      ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.map((tag) => String(tag)) } : {}),
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(typeof body.linkedSessionId === 'string' ? { linkedSessionId: body.linkedSessionId } : {}),
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
