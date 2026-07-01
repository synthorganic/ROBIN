/**
 * Gateway initialization API routes for ROBIN Gateway v1.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

interface GatewayAuth {
  mode?: 'token' | 'none';
  token?: string;
}
interface GatewayConfig {
  gateway?: {
    port: number;
    bind: string;
    auth?: GatewayAuth;
  };
}

const app = new Hono();

const HOME = process.env.HOME || os.homedir();
const ROBIN_DIR = path.join(HOME, '.robin');
const GATEWAY_CONFIG_PATH = path.join(ROBIN_DIR, 'gateway.json');

/**
 * Load gateway configuration from disk.
 */
function loadConfig(): GatewayConfig {
  if (!existsSync(GATEWAY_CONFIG_PATH)) {
    return { gateway: { port: 18789, bind: '127.0.0.1' } };
  }
  try {
    const raw = readFileSync(GATEWAY_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as GatewayConfig;
  } catch {
    return { gateway: { port: 18789, bind: '127.0.0.1' } };
  }
}

app.post('/api/gateway/init', async (c) => {
  const bodySchema = z.object({
    security: z.enum(['none', 'token']).optional().default('token'),
  });
  
  let body;
  try {
    const parsed = bodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid request' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  try {
    const config = loadConfig();

    if (!config.gateway) {
      config.gateway = { port: 18789, bind: '127.0.0.1' };
    }

    if (body.security === 'none') {
      delete config.gateway.auth;
    } else {
      // Ensure auth exists before setting token
      if (!config.gateway.auth) {
        config.gateway.auth = { mode: 'token', token: '' };
      }
      config.gateway.auth.token = crypto.randomBytes(32).toString('base64url');
    }

    mkdirSync(ROBIN_DIR, { recursive: true });
    writeFileSync(GATEWAY_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

    const token = config.gateway.auth?.token;
    return c.json({
      ok: true,
      message: 'Gateway initialized',
      configPath: GATEWAY_CONFIG_PATH,
      authEnabled: body.security !== 'none',
      tokenHint: `Use GATEWAY_TOKEN=${token} in .env`,
    });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.get('/api/gateway/status', async (c) => {
  try {
    const config = existsSync(GATEWAY_CONFIG_PATH)
      ? JSON.parse(readFileSync(GATEWAY_CONFIG_PATH, 'utf-8'))
      : null;

    return c.json({
      ok: true,
      configured: !!config,
      gateway: config?.gateway || null,
    });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

export default app;
