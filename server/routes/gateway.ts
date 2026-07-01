/**
 * Gateway API Routes
 *
 * GET  /api/gateway/models        — Returns configured Robin-Ops models.
 * GET  /api/gateway/session-info  — Returns stored session preferences.
 * POST /api/gateway/session-patch — Updates model / effort / instructions.
 * POST /api/gateway/agent-configure — Stores Robin-Ops agent instructions.
 * POST /api/gateway/restart       — Reports local gateway restart status.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.js';
import {
  type RobinGatewayModelInfo,
  listRobinGatewayModels,
  readRobinSessionPreferences,
  writeRobinSessionPreferences,
} from '../lib/robin-config-store.js';
import { rateLimitGeneral, rateLimitRestart } from '../middleware/rate-limit.js';

const app = new Hono();
const DEFAULT_SESSION_KEY = 'agent:main:main';
export const MODEL_LIST_TIMEOUT_MS = 15_000;

export interface GatewayModelInfo extends RobinGatewayModelInfo {}

const sessionPatchSchema = z.object({
  sessionKey: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  thinkingLevel: z.string().max(50).nullable().optional(),
  instructions: z.string().max(5000).optional(),
});

const agentConfigureSchema = z.object({
  sessionKey: z.string().max(200).optional(),
  instructions: z.string().max(5000).nullable().optional(),
});

function isLocalGatewayUrl() {
  try {
    const gatewayUrl = new URL(config.gatewayUrl || 'http://127.0.0.1:18789');
    return ['127.0.0.1', 'localhost', '::1'].includes(gatewayUrl.hostname);
  } catch {
    return true;
  }
}

function resolveSessionKey(raw?: string) {
  return raw?.trim() || DEFAULT_SESSION_KEY;
}

async function sessionInfoPayload(sessionKey: string) {
  const [models, prefs] = await Promise.all([
    listRobinGatewayModels(),
    readRobinSessionPreferences(sessionKey),
  ]);

  const fallbackModel = prefs.model?.trim()
    || config.localApiModel.trim()
    || models[0]?.id
    || undefined;

  return {
    ...(fallbackModel ? { model: fallbackModel } : {}),
    ...(prefs.thinking?.trim() ? { thinking: prefs.thinking.trim().toLowerCase() } : {}),
  };
}

app.get('/api/gateway/models', rateLimitGeneral, async (c) => {
  const models = await listRobinGatewayModels();
  return c.json({
    models,
    error: models.length > 0 ? null : 'No configured Robin-Ops models.',
    source: 'robin',
  });
});

app.get('/api/gateway/session-info', rateLimitGeneral, async (c) => {
  const sessionKey = resolveSessionKey(c.req.query('sessionKey'));
  return c.json(await sessionInfoPayload(sessionKey));
});

app.post('/api/gateway/session-patch', rateLimitGeneral, async (c) => {
  let body: z.infer<typeof sessionPatchSchema>;
  try {
    const parsed = sessionPatchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const sessionKey = resolveSessionKey(body.sessionKey);
  const next = await writeRobinSessionPreferences(sessionKey, {
    ...(body.model?.trim() ? { model: body.model.trim() } : {}),
    ...(body.thinkingLevel === null
      ? { thinking: '' }
      : body.thinkingLevel?.trim()
        ? { thinking: body.thinkingLevel.trim().toLowerCase() }
        : {}),
    ...(body.instructions?.trim() ? { instructions: body.instructions.trim() } : {}),
  });

  return c.json({
    ok: true,
    ...(next.model ? { model: next.model } : {}),
    ...(next.thinking ? { thinking: next.thinking } : {}),
  });
});

app.post('/api/gateway/agent-configure', rateLimitGeneral, async (c) => {
  let body: z.infer<typeof agentConfigureSchema>;
  try {
    const parsed = agentConfigureSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const sessionKey = resolveSessionKey(body.sessionKey);
  await writeRobinSessionPreferences(sessionKey, {
    instructions: body.instructions?.trim() || '',
  });

  return c.json({
    ok: true,
    sessionKey,
    message: 'Robin-Ops session preferences updated.',
  });
});

app.post('/api/gateway/restart', rateLimitRestart, async (c) => {
  if (!isLocalGatewayUrl()) {
    return c.json({
      ok: false,
      output: 'Remote gateway restart is not supported from the embedded Robin-Ops runtime.',
    }, 501);
  }

  return c.json({
    ok: true,
    output: 'Embedded Robin-Ops gateway is managed by ROBIN and does not require an external restart.',
  });
});

export default app;
