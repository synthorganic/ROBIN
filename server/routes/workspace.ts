/**
 * Workspace file API Routes
 *
 * GET  /api/workspace/:key  — Read a workspace file by key
 * PUT  /api/workspace/:key  — Write a workspace file by key
 *
 * Strict allowlist of keys → files. No directory traversal.
 *
 * All file operations are handled locally by the ROBIN ops-agent.
 * No gateway RPC fallback is used.
 */

import { Hono, type Context } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readText } from '../lib/files.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { InvalidAgentIdError, resolveAgentWorkspace } from '../lib/agent-workspace.js';

const app = new Hono();

/** Strict allowlist mapping key → filename */
const FILE_MAP: Record<string, string> = {
  soul: 'SOUL.md',
  tools: 'TOOLS.md',
  identity: 'IDENTITY.md',
  user: 'USER.md',
  agents: 'AGENTS.md',
  heartbeat: 'HEARTBEAT.md',
};

function getWorkspaceRoot(agentId?: string): { agentId: string; workspaceRoot: string } {
  const workspace = resolveAgentWorkspace(agentId);
  return { agentId: workspace.agentId, workspaceRoot: workspace.workspaceRoot };
}

function handleAgentWorkspaceError(c: Context, err: unknown) {
  if (err instanceof InvalidAgentIdError) {
    return c.json({ ok: false, error: err.message }, 400);
  }
  const message = err instanceof Error ? err.message : 'Invalid workspace request';
  return c.json({ ok: false, error: message }, 500);
}

app.get('/api/workspace/:key', rateLimitGeneral, async (c) => {
  let workspace: { agentId: string; workspaceRoot: string };
  try {
    workspace = getWorkspaceRoot(c.req.query('agentId'));
  } catch (err) {
    return handleAgentWorkspaceError(c, err);
  }

  const key = c.req.param('key') as string;
  const filename = FILE_MAP[key];
  if (!filename) return c.json({ ok: false, error: 'Unknown file key' }, 400);

  const filePath = path.join(workspace.workspaceRoot, filename);

  // Try local first
  try {
    await fs.access(filePath);
    const content = await readText(filePath);
    return c.json({ ok: true, content });
  } catch {
    return c.json({ ok: false, error: 'File not found' }, 404);
  }
});

app.put('/api/workspace/:key', rateLimitGeneral, async (c) => {
  let body: { content?: string; agentId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  let workspace: { agentId: string; workspaceRoot: string };
  try {
    workspace = getWorkspaceRoot(body.agentId ?? c.req.query('agentId'));
  } catch (err) {
    return handleAgentWorkspaceError(c, err);
  }

  const key = c.req.param('key') as string;
  const filename = FILE_MAP[key];
  if (!filename) return c.json({ ok: false, error: 'Unknown file key' }, 400);

  if (typeof body.content !== 'string') {
    return c.json({ ok: false, error: 'Missing content field' }, 400);
  }
  if (body.content.length > 100_000) {
    return c.json({ ok: false, error: 'Content too large (max 100KB)' }, 400);
  }

  const filePath = path.join(workspace.workspaceRoot, filename);

  // Write to local workspace
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body.content, 'utf-8');
    return c.json({ ok: true });
  } catch (err) {
    console.error('[workspace] PUT error:', (err as Error).message);
    return c.json({ ok: false, error: 'Failed to write file' }, 500);
  }
});

/** List available workspace file keys and their existence status */
app.get('/api/workspace', rateLimitGeneral, async (c) => {
  let workspace: { agentId: string; workspaceRoot: string };
  try {
    workspace = getWorkspaceRoot(c.req.query('agentId'));
  } catch (err) {
    return handleAgentWorkspaceError(c, err);
  }

  const files: Array<{ key: string; filename: string; exists: boolean }> = [];

  // List files from local workspace
  for (const [key, filename] of Object.entries(FILE_MAP)) {
    const filePath = path.join(workspace.workspaceRoot, filename);
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      // not found
    }
    files.push({ key, filename, exists });
  }

  return c.json({ ok: true, files });
});

export default app;
