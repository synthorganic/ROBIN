/**
 * GET /api/channels — List messaging channels configured in ROBIN.
 *
 * Reads channel keys from `~/.robin/gateway.json`. Returns an array
 * of channel names (for example `["whatsapp", "discord"]`).
 * Cached for 5 minutes to avoid repeated disk reads.
 */

import { Hono } from 'hono';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { listRobinChannels } from '../lib/robin-config-store.js';

interface ChannelsCache {
  channels: string[];
  checkedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: ChannelsCache | null = null;

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
