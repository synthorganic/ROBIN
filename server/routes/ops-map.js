import { Hono } from 'hono';
import { OPS_MAP_ASSET_TYPES, opsMapStore } from '../lib/ops-map-store.js';
const app = new Hono();
function isAssetType(value) {
    return typeof value === 'string' && OPS_MAP_ASSET_TYPES.includes(value);
}
app.get('/api/map/assets', async (c) => c.json({ ok: true, assets: await opsMapStore.list() }));
app.get('/api/map/layers', async (c) => c.json({ ok: true, layers: await opsMapStore.layers() }));
app.post('/api/map/assets', async (c) => {
    const body = await c.req.json().catch(() => ({}));
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
        severity: typeof body.severity === 'string' ? body.severity : undefined,
        confidence: typeof body.confidence === 'string' ? body.confidence : undefined,
        observedAt: typeof body.observedAt === 'string' ? body.observedAt : undefined,
        live: body.live === true,
    });
    return c.json({ ok: true, asset });
});
app.put('/api/map/assets/:id', async (c) => {
    try {
        const body = await c.req.json().catch(() => ({}));
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
            ...(typeof body.severity === 'string' ? { severity: body.severity } : {}),
            ...(typeof body.confidence === 'string' ? { confidence: body.confidence } : {}),
            ...(typeof body.observedAt === 'string' ? { observedAt: body.observedAt } : {}),
            ...(typeof body.live === 'boolean' ? { live: body.live } : {}),
        });
        return c.json({ ok: true, asset });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 404);
    }
});
app.delete('/api/map/assets/:id', async (c) => {
    await opsMapStore.remove(c.req.param('id'));
    return c.json({ ok: true });
});
export default app;
