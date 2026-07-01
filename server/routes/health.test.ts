/** Tests for the GET /api/health endpoint. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

describe('GET /api/health', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function importHealthApp() {
    const mod = await import('./health.js');
    const app = new Hono();
    app.route('/', mod.default);
    return app;
  }

  it('should return status ok and version', async () => {
    const app = await importHealthApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('ok');
    expect(typeof json.version).toBe('string');
    expect(json.timestamp).toBeDefined();
  });

  it('should include uptime in details response', async () => {
    const app = await importHealthApp();
    const res = await app.request('/api/health/details');
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.routes).toBeDefined();
    expect(json.features).toBeDefined();
    expect(json.lastHealthCheck).toBeDefined();
  });

  it('should report voiceInput feature when enabled', async () => {
    const app = await importHealthApp();
    const res = await app.request('/api/health/details');

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.features?.voiceInput).toBe(true);
    expect(json.features?.fileBrowser).toBe(true);
    expect(json.features?.kanban).toBe(true);
    expect(json.features?.sessions).toBe(true);
  });

  it('should return 404 for unknown routes', async () => {
    const app = await importHealthApp();
    const res = await app.request('/api/health/unknown');
    expect(res.status).toBe(404);
  });
});
