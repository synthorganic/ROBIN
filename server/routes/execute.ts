/**
 * Execute API Routes - direct command execution via gateway
 *
 * POST /api/execute/bash      - Execute a bash/shell command
 * POST /api/execute/powershell - Execute a PowerShell command
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { invokeGatewayTool } from '../lib/gateway-client.js';
import { config } from '../lib/config.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const MISSING_TOKEN_MESSAGE =
  'GATEWAY_TOKEN not configured. PowerShell execution requires connecting to OpenClaw gateway.\n' +
  'Run `npm run setup` or set GATEWAY_TOKEN in your .env file.\n' +
  'The token can be found in ~/.openclaw/openclaw.json under gateway.auth.token';

const app = new Hono();

// Common execution options schema
const executeOptionsSchema = z.object({
  command: z.string().min(1).max(100_000),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().max(500).optional(),
});

type ExecuteRequest = z.infer<typeof executeOptionsSchema>;

function getMissingTokenError(): string {
  const home = process.env.HOME || require('os').homedir();
  const configPath = `${home}/.openclaw/openclaw.json`;

  return (
    'GATEWAY_TOKEN not configured. PowerShell execution requires connecting to OpenClaw gateway.\n\n' +
    'To fix:\n' +
    `1. Find your gateway token: ${configPath}\n` +
    '   Look for "gateway" -> "auth" -> "token"\n\n' +
    '2. Add to your .env file:\n' +
    `   GATEWAY_TOKEN=your_token_here\n\n` +
    '3. Restart ROBIN server\n\n' +
    'Alternatively, run: npm run setup'
  );
}

// ── Bash/Shell Execution ─────────────────────────────────────────────

app.post('/api/execute/bash', rateLimitGeneral, async (c) => {
  let body: ExecuteRequest;
  try {
    const parsed = executeOptionsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid request body' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  try {
    if (!config.gatewayToken) {
      return c.json({ ok: false, error: getMissingTokenError() }, 401);
    }

    // Use the gateway's cron tool with a one-time command
    const result = await invokeGatewayTool('cron', {
      action: 'run',
      jobId: `robin-${Date.now()}`,
      job: {
        name: body.description || 'One-time bash command',
        payload: {
          kind: 'systemEvent' as const,
          text: body.command,
        },
      },
    }, body.timeoutMs || 30_000);

    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[execute/bash] command failed:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

// ── PowerShell Execution ─────────────────────────────────────────────

app.post('/api/execute/powershell', rateLimitGeneral, async (c) => {
  let body: ExecuteRequest;
  try {
    const parsed = executeOptionsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Invalid request body' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  try {
    if (!config.gatewayToken) {
      return c.json({ ok: false, error: getMissingTokenError() }, 401);
    }

    // Use the gateway's cron tool with PowerShell
    const result = await invokeGatewayTool('cron', {
      action: 'run',
      jobId: `robin-powershell-${Date.now()}`,
      job: {
        name: body.description || 'One-time PowerShell command',
        payload: {
          kind: 'systemEvent' as const,
          text: `powershell -Command "${body.command.replace(/"/g, '\\"')}"`,
        },
      },
    }, body.timeoutMs || 60_000);

    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[execute/powershell] command failed:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

export default app;
