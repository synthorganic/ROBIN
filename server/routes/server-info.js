/**
 * GET /api/server-info — Server time and embedded gateway uptime info.
 */
import { Hono } from 'hono';
import { config } from '../lib/config.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
const app = new Hono();
function getGatewayStartedAt() {
    return Math.round(Date.now() - (process.uptime() * 1000));
}
app.get('/api/server-info', rateLimitGeneral, async (c) => {
    return c.json({
        serverTime: Date.now(),
        gatewayStartedAt: getGatewayStartedAt(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        agentName: config.agentName,
    });
});
export default app;
