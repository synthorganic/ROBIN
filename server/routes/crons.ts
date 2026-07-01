/**
 * Cron API Routes — Robin-Ops local scheduler
 *
 * GET    /api/crons            — List all cron jobs
 * POST   /api/crons            — Create a new cron job
 * PATCH  /api/crons/:id        — Update a cron job
 * DELETE /api/crons/:id        — Delete a cron job
 * POST   /api/crons/:id/toggle — Toggle enabled/disabled
 * POST   /api/crons/:id/run    — Run a cron job immediately
 * GET    /api/crons/:id/runs   — Get run history
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { RobinCronDelivery, RobinCronJob, RobinCronPayload, RobinCronSchedule } from '../lib/robin-crons.js';
import { robinCronManager } from '../lib/robin-crons.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';

const scheduleSchema = z.union([
  z.object({ kind: z.literal('at'), at: z.string() }),
  z.object({ kind: z.literal('every'), everyMs: z.number(), anchorMs: z.number().optional() }),
  z.object({ kind: z.literal('cron'), expr: z.string(), tz: z.string().optional() }),
]);

const payloadSchema = z.union([
  z.object({ kind: z.literal('systemEvent'), text: z.string() }),
  z.object({ kind: z.literal('agentTurn'), message: z.string(), model: z.string().optional(), thinking: z.string().optional(), timeoutSeconds: z.number().optional() }),
]);

const deliverySchema = z.object({
  mode: z.enum(['none', 'announce']).optional(),
  channel: z.string().optional(),
  to: z.string().optional(),
  bestEffort: z.boolean().optional(),
}).optional();

const sessionAgentIdSchema = z.string().max(200).optional();

const cronJobSchema = z.object({
  job: z.object({
    name: z.string().min(1).max(200).optional(),
    schedule: scheduleSchema.optional(),
    payload: payloadSchema.optional(),
    delivery: deliverySchema,
    sessionTarget: z.enum(['main', 'isolated']).optional(),
    sessionKey: z.string().max(200).optional(),
    agentId: sessionAgentIdSchema,
    enabled: z.boolean().optional(),
    notify: z.boolean().optional(),
    prompt: z.string().max(10000).optional(),
    model: z.string().max(200).optional(),
    thinkingLevel: z.string().max(50).optional(),
    channel: z.string().max(200).optional(),
  }),
});

const cronPatchSchema = z.object({
  patch: z.object({
    name: z.string().min(1).max(200).optional(),
    schedule: scheduleSchema.optional(),
    payload: payloadSchema.optional(),
    delivery: deliverySchema,
    sessionTarget: z.enum(['main', 'isolated']).optional(),
    sessionKey: z.string().max(200).optional(),
    agentId: sessionAgentIdSchema,
    enabled: z.boolean().optional(),
    notify: z.boolean().optional(),
    prompt: z.string().max(10000).optional(),
    model: z.string().max(200).optional(),
    thinkingLevel: z.string().max(50).optional(),
    channel: z.string().max(200).optional(),
  }),
});

const app = new Hono();

function deriveAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1];
}

function normalizeCronTarget<T extends { sessionKey?: string; agentId?: string }>(job: T): T {
  const agentId = deriveAgentIdFromSessionKey(job.sessionKey);
  if (!agentId) return job;
  return { ...job, agentId };
}

function normalizeDelivery(value: Record<string, unknown> | undefined): RobinCronDelivery | undefined {
  if (!value) return undefined;
  const next: RobinCronDelivery = {};
  if (value.mode === 'announce' || value.mode === 'none') next.mode = value.mode;
  if (typeof value.channel === 'string' && value.channel.trim()) next.channel = value.channel.trim();
  if (typeof value.to === 'string' && value.to.trim()) next.to = value.to.trim();
  if (typeof value.bestEffort === 'boolean') next.bestEffort = value.bestEffort;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizedPayload(
  job: Record<string, unknown>,
  requirePayload: boolean,
): RobinCronPayload {
  if (job.payload && typeof job.payload === 'object') {
    return job.payload as RobinCronPayload;
  }

  if (typeof job.prompt === 'string' && job.prompt.trim()) {
    return {
      kind: 'agentTurn',
      message: job.prompt.trim(),
      ...(typeof job.model === 'string' && job.model.trim() ? { model: job.model.trim() } : {}),
      ...(typeof job.thinkingLevel === 'string' && job.thinkingLevel.trim() ? { thinking: job.thinkingLevel.trim() } : {}),
    };
  }

  if (!requirePayload) {
    return { kind: 'systemEvent', text: '' };
  }

  throw new Error('Cron payload is required');
}

function normalizedSchedule(
  job: Record<string, unknown>,
  requireSchedule: boolean,
): RobinCronSchedule {
  if (job.schedule && typeof job.schedule === 'object') {
    return job.schedule as RobinCronSchedule;
  }

  if (!requireSchedule) {
    return { kind: 'every', everyMs: 60 * 60 * 1000 };
  }

  throw new Error('Cron schedule is required');
}

function buildJobInput(
  rawJob: Record<string, unknown>,
  requireCoreFields: boolean,
): Omit<RobinCronJob, 'id' | 'createdAt' | 'updatedAt' | 'state'> {
  const job = normalizeCronTarget(rawJob);
  const payload = normalizedPayload(job, requireCoreFields);
  const schedule = normalizedSchedule(job, requireCoreFields);
  const delivery = normalizeDelivery((job.delivery as Record<string, unknown> | undefined) || (
    typeof job.channel === 'string' && job.channel.trim()
      ? { mode: 'announce', channel: job.channel.trim() }
      : undefined
  ));

  return {
    ...(typeof job.name === 'string' && job.name.trim() ? { name: job.name.trim() } : {}),
    enabled: job.enabled !== false,
    schedule,
    payload,
    delivery,
    ...(job.sessionTarget === 'main' || job.sessionTarget === 'isolated' ? { sessionTarget: job.sessionTarget } : {}),
    ...(typeof job.sessionKey === 'string' && job.sessionKey.trim() ? { sessionKey: job.sessionKey.trim() } : {}),
    ...(typeof job.agentId === 'string' && job.agentId.trim() ? { agentId: job.agentId.trim() } : {}),
    ...(typeof job.notify === 'boolean' ? { notify: job.notify } : {}),
  };
}

function buildPatchInput(rawPatch: Record<string, unknown>): Partial<Omit<RobinCronJob, 'id' | 'createdAt'>> {
  const patch = normalizeCronTarget(rawPatch);
  const next: Partial<Omit<RobinCronJob, 'id' | 'createdAt'>> = {};

  if (typeof patch.name === 'string') next.name = patch.name.trim();
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.schedule && typeof patch.schedule === 'object') next.schedule = patch.schedule as RobinCronSchedule;
  if (patch.payload && typeof patch.payload === 'object') next.payload = patch.payload as RobinCronPayload;
  if (patch.delivery && typeof patch.delivery === 'object') next.delivery = normalizeDelivery(patch.delivery as Record<string, unknown>);
  if (patch.sessionTarget === 'main' || patch.sessionTarget === 'isolated') next.sessionTarget = patch.sessionTarget;
  if (typeof patch.sessionKey === 'string') next.sessionKey = patch.sessionKey.trim();
  if (typeof patch.agentId === 'string') next.agentId = patch.agentId.trim();
  if (typeof patch.notify === 'boolean') next.notify = patch.notify;

  if (!next.payload && typeof patch.prompt === 'string' && patch.prompt.trim()) {
    next.payload = {
      kind: 'agentTurn',
      message: patch.prompt.trim(),
      ...(typeof patch.model === 'string' && patch.model.trim() ? { model: patch.model.trim() } : {}),
      ...(typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim() ? { thinking: patch.thinkingLevel.trim() } : {}),
    };
  }

  if (!next.delivery && typeof patch.channel === 'string' && patch.channel.trim()) {
    next.delivery = { mode: 'announce', channel: patch.channel.trim() };
  }

  return next;
}

app.get('/api/crons', rateLimitGeneral, async (c) => {
  try {
    const jobs = await robinCronManager.listJobs();
    return c.json({ ok: true, result: { jobs } });
  } catch (err) {
    console.error('[crons] list error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/crons', rateLimitGeneral, async (c) => {
  try {
    const parsed = cronJobSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    const job = await robinCronManager.addJob(buildJobInput(parsed.data.job as Record<string, unknown>, true));
    return c.json({ ok: true, result: job });
  } catch (err) {
    console.error('[crons] add error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.patch('/api/crons/:id', rateLimitGeneral, async (c) => {
  const jobId = c.req.param('id') || '';
  try {
    const parsed = cronPatchSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message || 'Invalid body' }, 400);
    const patch = buildPatchInput(parsed.data.patch as Record<string, unknown>);
    const job = await robinCronManager.updateJob(jobId, patch);
    return c.json({ ok: true, result: job });
  } catch (err) {
    console.error('[crons] update error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.delete('/api/crons/:id', rateLimitGeneral, async (c) => {
  const jobId = c.req.param('id') || '';
  try {
    const result = await robinCronManager.removeJob(jobId);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] remove error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/crons/:id/toggle', rateLimitGeneral, async (c) => {
  const jobId = c.req.param('id') || '';
  try {
    const body = await c.req.json<{ enabled?: boolean }>().catch((): { enabled?: boolean } => ({}));
    const enabled = body.enabled !== false;
    const job = await robinCronManager.updateJob(jobId, { enabled });
    return c.json({ ok: true, result: job });
  } catch (err) {
    console.error('[crons] toggle error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.post('/api/crons/:id/run', rateLimitGeneral, async (c) => {
  const jobId = c.req.param('id') || '';
  try {
    const result = await robinCronManager.runNow(jobId);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error('[crons] run error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.get('/api/crons/:id/runs', rateLimitGeneral, async (c) => {
  const jobId = c.req.param('id') || '';
  try {
    const entries = await robinCronManager.readRuns(jobId);
    return c.json({
      ok: true,
      result: {
        entries,
        total: entries.length,
        offset: 0,
        limit: 10,
        hasMore: false,
        nextOffset: null,
      },
    });
  } catch (err) {
    console.error('[crons] runs error:', (err as Error).message);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

export default app;
