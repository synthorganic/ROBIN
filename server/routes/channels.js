/**
 * GET /api/channels — List messaging channels configured in ROBIN.
 */
import { Hono } from 'hono';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { listRobinChannels } from '../lib/robin-config-store.js';
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;
const app = new Hono();
app.get('/api/channels', rateLimitGeneral, async (c) => {
    const now = Date.now();
    if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
        return c.json({ channels: cache.channels });
    }
    const channels = await listRobinChannels();
    cache = { channels, checkedAt: now };
    return c.json({ channels });
});
export default app;
