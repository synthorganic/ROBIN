import { Hono } from 'hono';
import { config } from '../lib/config.js';
import { writeEnvKey } from '../lib/env-file.js';
import { lmStudioService, normalizeLocalApiBaseUrl } from '../lib/lmstudio-service.js';

const app = new Hono();

interface LocalApiConfigBody {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
}

function bodyString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function publicStatus() {
  return {
    ...lmStudioService.publicConfig(),
    configuredFrom: 'env',
  };
}

app.get('/api/agent/local-api', (c) => {
  return c.json({ ok: true, localApi: publicStatus() });
});

app.put('/api/agent/local-api', async (c) => {
  const body = await c.req.json().catch(() => ({})) as LocalApiConfigBody;
  const baseUrl = normalizeLocalApiBaseUrl(bodyString(body.baseUrl) || config.localApiBaseUrl);
  const apiKey = body.apiKey === undefined ? config.localApiKey : bodyString(body.apiKey);
  const defaultModelId = body.defaultModelId === undefined ? config.localApiModel : bodyString(body.defaultModelId);

  await writeEnvKey('LOCAL_API_BASE_URL', baseUrl);
  await writeEnvKey('LOCAL_API_KEY', apiKey);
  await writeEnvKey('LOCAL_API_MODEL', defaultModelId);

  (config as Record<string, unknown>).localApiBaseUrl = baseUrl;
  (config as Record<string, unknown>).localApiKey = apiKey;
  (config as Record<string, unknown>).localApiModel = defaultModelId;
  lmStudioService.configure({ baseUrl, apiKey, defaultModelId });

  return c.json({ ok: true, localApi: publicStatus() });
});

app.post('/api/agent/local-api/models', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as LocalApiConfigBody;
    const baseUrl = normalizeLocalApiBaseUrl(bodyString(body.baseUrl) || config.localApiBaseUrl);
    const apiKey = body.apiKey === undefined ? config.localApiKey : bodyString(body.apiKey);
    const models = await lmStudioService.getModels({ baseUrl, apiKey });
    return c.json({
      ok: true,
      connected: true,
      baseUrl,
      models,
    });
  } catch (error) {
    return c.json({
      ok: false,
      connected: false,
      error: (error as Error).message,
      models: [],
    }, 502);
  }
});

export default app;
