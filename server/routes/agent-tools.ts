/**
 * Agent Tools API Routes
 *
 * Provides endpoints for the central agent to access tools like glob, grep, sleep, etc.
 */
import { Hono } from 'hono';
import { globTool, type GlobOptions, type GlobResult } from '../lib/tools/tool-glob.js';
import { grepTool } from '../lib/tools/tool-grep.js';
import { sleepTool, type SleepOptions } from '../lib/tools/tool-sleep.js';
import { getOpsAgentToolCatalog } from '../lib/ops-agent-tool-catalog.js';

const app = new Hono();

// ── Glob Tool Routes ────────────────────────────────────────────────

app.get('/api/agent-tools/glob', async (c) => {
  const pattern = c.req.query('pattern') || '**/*';
  const cwd = c.req.query('cwd');

  try {
    const result: GlobResult | { error: string } = await globTool.find({
      pattern,
      cwd: cwd || undefined,
    });

    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json(
      { ok: false, error: (error as Error).message },
      503,
    );
  }
});

app.post('/api/agent-tools/glob', async (c) => {
  const body = await c.req.json().catch(() => ({})) as GlobOptions;

  try {
    const result: GlobResult | { error: string } = await globTool.find(body);

    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json(
      { ok: false, error: (error as Error).message },
      503,
    );
  }
});

// ── Grep Tool Routes ────────────────────────────────────────────────

app.get('/api/agent-tools/grep', async (c) => {
  const pattern = c.req.query('pattern');
  if (!pattern) {
    return c.json({ ok: false, error: 'Pattern is required' }, 400);
  }

  try {
    const result = await grepTool.search({
      pattern,
      cwd: c.req.query('cwd') || undefined,
      caseSensitive: c.req.query('caseSensitive') === 'true',
    });

    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json(
      { ok: false, error: (error as Error).message },
      503,
    );
  }
});

// ── Sleep Tool Routes ───────────────────────────────────────────────

app.post('/api/agent-tools/sleep', async (c) => {
  const body = await c.req.json().catch(() => ({})) as SleepOptions;

  try {
    await sleepTool.sleep(body);
    return c.json({ ok: true, durationMs: body.durationMs });
  } catch (error) {
    return c.json(
      { ok: false, error: (error as Error).message },
      503,
    );
  }
});

// ── Utility Routes ───────────────────────────────────────────────────

app.get('/api/agent-tools', async (c) => {
  const catalog = await getOpsAgentToolCatalog(c.req.query('refresh') === 'true');
  return c.json({
    ok: true,
    tools: ['glob', 'grep', 'sleep'],
    catalog,
    status: 'ready',
  });
});

app.get('/api/agent-tools/catalog', async (c) => {
  const catalog = await getOpsAgentToolCatalog(c.req.query('refresh') === 'true');
  return c.json({ ok: true, catalog });
});

export default app;
