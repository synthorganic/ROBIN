/**
 * Health check and monitoring endpoint for ROBIN
 */
import { Hono } from 'hono';

const app = new Hono();

app.get('/api/health', (c) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.5.2',
  };
  return c.json(health);
});

app.get('/api/health/details', async (c) => {
  const details = {
    routes: ['agent', 'bridge', 'workspace'],
    gatewaysConnected: true,
    lastHealthCheck: new Date().toISOString(),
    features: {
      voiceInput: true,
      fileBrowser: true,
      kanban: true,
      sessions: true,
    },
  };
  return c.json(details);
});

export default app;
