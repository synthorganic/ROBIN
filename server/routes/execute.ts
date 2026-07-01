/**
 * Execute API Routes — direct local command execution via the embedded gateway.
 *
 * POST /api/execute/bash
 * POST /api/execute/powershell
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { invokeGatewayTool } from '../lib/gateway-client.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const app = new Hono();

const executeOptionsSchema = z.object({
  command: z.string().min(1).max(100_000),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().max(500).optional(),
});

type ExecuteRequest = z.infer<typeof executeOptionsSchema>;

app.post('/api/execute/bash', rateLimitGeneral, async (c) => {
  let body: ExecuteRequest;
  try {
    const parsed = executeOptionsSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: 'Invalid request body' }, 400);
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  try {
    const result = await invokeGatewayTool('bash', {
      command: body.command,
      timeoutMs: body.timeoutMs || 30_000,
      description: body.description,
    }, body.timeoutMs || 30_000);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[execute/bash] command failed:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

app.post('/api/execute/powershell', rateLimitGeneral, async (c) => {
  let body: ExecuteRequest;
  try {
    const parsed = executeOptionsSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: 'Invalid request body' }, 400);
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  try {
    const result = await invokeGatewayTool('powershell', {
      command: body.command,
      timeoutMs: body.timeoutMs || 60_000,
      description: body.description,
    }, body.timeoutMs || 60_000);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[execute/powershell] command failed:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

export default app;
