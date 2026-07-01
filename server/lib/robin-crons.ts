import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { opsAgentService } from './ops-agent.js';
import {
  ROBIN_CRON_RUNS_DIR,
  readRobinCronsStore,
  writeRobinCronsStore,
} from './robin-config-store.js';

export type RobinCronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

export type RobinCronPayload =
  | { kind: 'systemEvent'; text: string }
  | {
    kind: 'agentTurn';
    message: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
  };

export interface RobinCronDelivery {
  mode?: 'none' | 'announce';
  channel?: string;
  to?: string;
  bestEffort?: boolean;
}

export interface RobinCronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
  lastDeliveryStatus?: string;
}

export interface RobinCronJob {
  id: string;
  name?: string;
  enabled: boolean;
  schedule: RobinCronSchedule;
  payload: RobinCronPayload;
  delivery?: RobinCronDelivery;
  sessionTarget?: 'main' | 'isolated';
  sessionKey?: string;
  agentId?: string;
  notify?: boolean;
  createdAt: string;
  updatedAt: string;
  state: RobinCronJobState;
}

export interface RobinCronRunEntry {
  ts: number;
  timestamp: string;
  jobId: string;
  status: string;
  summary?: string;
  error?: string;
  durationMs?: number;
  nextRunAtMs?: number;
  manual?: boolean;
}

interface RobinCronStoreShape {
  jobs: RobinCronJob[];
}

const DEFAULT_STORE: RobinCronStoreShape = { jobs: [] };
const MAX_CRON_LOOKAHEAD_MINUTES = 366 * 24 * 60;
const MAX_TIMER_MS = 60_000;

function nowIso() {
  return new Date().toISOString();
}

function safeJsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function runHistoryPath(jobId: string) {
  return path.join(ROBIN_CRON_RUNS_DIR, `${jobId}.jsonl`);
}

function normalizeDelivery(value: RobinCronDelivery | undefined): RobinCronDelivery | undefined {
  if (!value) return undefined;
  const next: RobinCronDelivery = {};
  if (value.mode === 'announce' || value.mode === 'none') next.mode = value.mode;
  if (typeof value.channel === 'string' && value.channel.trim()) next.channel = value.channel.trim();
  if (typeof value.to === 'string' && value.to.trim()) next.to = value.to.trim();
  if (typeof value.bestEffort === 'boolean') next.bestEffort = value.bestEffort;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeSchedule(schedule: RobinCronSchedule): RobinCronSchedule {
  if (schedule.kind === 'at') {
    return { kind: 'at', at: new Date(schedule.at).toISOString() };
  }
  if (schedule.kind === 'every') {
    const everyMs = Math.max(60_000, Math.floor(schedule.everyMs));
    const anchorMs = typeof schedule.anchorMs === 'number' && Number.isFinite(schedule.anchorMs)
      ? Math.floor(schedule.anchorMs)
      : undefined;
    return anchorMs ? { kind: 'every', everyMs, anchorMs } : { kind: 'every', everyMs };
  }
  return {
    kind: 'cron',
    expr: schedule.expr.trim(),
    ...(schedule.tz?.trim() ? { tz: schedule.tz.trim() } : {}),
  };
}

function scheduleWithAnchor(schedule: RobinCronSchedule, anchorMs: number): RobinCronSchedule {
  if (schedule.kind !== 'every' || typeof schedule.anchorMs === 'number') return schedule;
  return { ...schedule, anchorMs };
}

function normalizePayload(payload: RobinCronPayload): RobinCronPayload {
  if (payload.kind === 'systemEvent') {
    return { kind: 'systemEvent', text: payload.text.trim() };
  }
  return {
    kind: 'agentTurn',
    message: payload.message.trim(),
    ...(payload.model?.trim() ? { model: payload.model.trim() } : {}),
    ...(payload.thinking?.trim() ? { thinking: payload.thinking.trim() } : {}),
    ...(typeof payload.timeoutSeconds === 'number' && Number.isFinite(payload.timeoutSeconds)
      ? { timeoutSeconds: payload.timeoutSeconds }
      : {}),
  };
}

function normalizeJob(job: RobinCronJob): RobinCronJob {
  return {
    ...job,
    enabled: job.enabled !== false,
    schedule: normalizeSchedule(job.schedule),
    payload: normalizePayload(job.payload),
    delivery: normalizeDelivery(job.delivery),
    createdAt: job.createdAt || nowIso(),
    updatedAt: job.updatedAt || nowIso(),
    state: job.state || {},
  };
}

function parseCronPart(part: string, min: number, max: number): Set<number> | null {
  const raw = part.trim();
  if (!raw || raw === '*') return null;

  const values = new Set<number>();
  const segments = raw.split(',');

  for (const segment of segments) {
    const [base, stepRaw] = segment.split('/');
    const step = stepRaw ? Math.max(1, Number.parseInt(stepRaw, 10) || 1) : 1;

    if (base === '*') {
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }

    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      for (let value = start; value <= end; value += step) {
        if (value >= min && value <= max) values.add(value);
      }
      continue;
    }

    const single = Number.parseInt(base, 10);
    if (Number.isFinite(single) && single >= min && single <= max) {
      values.add(single);
    }
  }

  return values.size > 0 ? values : null;
}

function matchesCron(schedule: Extract<RobinCronSchedule, { kind: 'cron' }>, date: Date): boolean {
  const parts = schedule.expr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekDayExpr] = parts;
  const minutes = parseCronPart(minuteExpr, 0, 59);
  const hours = parseCronPart(hourExpr, 0, 23);
  const days = parseCronPart(dayExpr, 1, 31);
  const months = parseCronPart(monthExpr, 1, 12);
  const weekDays = parseCronPart(weekDayExpr, 0, 7);

  const minuteOk = minutes ? minutes.has(date.getMinutes()) : true;
  const hourOk = hours ? hours.has(date.getHours()) : true;
  const monthOk = months ? months.has(date.getMonth() + 1) : true;
  const dayOfMonthOk = days ? days.has(date.getDate()) : true;
  const normalizedWeekDay = date.getDay() === 0 ? 0 : date.getDay();
  const dayOfWeekOk = weekDays
    ? (weekDays.has(normalizedWeekDay) || (normalizedWeekDay === 0 && weekDays.has(7)))
    : true;

  let dayOk = true;
  if (days && weekDays) dayOk = dayOfMonthOk || dayOfWeekOk;
  else if (days) dayOk = dayOfMonthOk;
  else if (weekDays) dayOk = dayOfWeekOk;

  return minuteOk && hourOk && monthOk && dayOk;
}

function nextRunAt(schedule: RobinCronSchedule, fromMs: number): number | null {
  if (schedule.kind === 'at') {
    const atMs = new Date(schedule.at).getTime();
    return Number.isFinite(atMs) && atMs > fromMs ? atMs : null;
  }

  if (schedule.kind === 'every') {
    const anchor = typeof schedule.anchorMs === 'number' ? schedule.anchorMs : fromMs;
    if (fromMs < anchor) return anchor;
    const elapsed = fromMs - anchor;
    const steps = Math.floor(elapsed / schedule.everyMs) + 1;
    return anchor + (steps * schedule.everyMs);
  }

  const next = new Date(fromMs);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  for (let offset = 0; offset < MAX_CRON_LOOKAHEAD_MINUTES; offset += 1) {
    if (matchesCron(schedule, next)) return next.getTime();
    next.setMinutes(next.getMinutes() + 1);
  }

  return null;
}

async function loadStore(): Promise<RobinCronStoreShape> {
  const store = await readRobinCronsStore<RobinCronStoreShape>(DEFAULT_STORE);
  return {
    jobs: Array.isArray(store.jobs) ? store.jobs.map((job) => normalizeJob(job)) : [],
  };
}

async function saveStore(store: RobinCronStoreShape): Promise<void> {
  await writeRobinCronsStore({
    jobs: store.jobs.map((job) => normalizeJob(job)),
  });
}

async function appendRunEntry(jobId: string, entry: RobinCronRunEntry): Promise<void> {
  await fs.mkdir(ROBIN_CRON_RUNS_DIR, { recursive: true });
  await fs.appendFile(runHistoryPath(jobId), `${JSON.stringify(entry)}\n`, 'utf8');
}

async function readRunEntries(jobId: string): Promise<RobinCronRunEntry[]> {
  try {
    const raw = await fs.readFile(runHistoryPath(jobId), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RobinCronRunEntry)
      .sort((left, right) => right.ts - left.ts);
  } catch {
    return [];
  }
}

class RobinCronManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private mutation = Promise.resolve();
  private running = new Set<string>();

  constructor() {
    queueMicrotask(() => {
      void this.scheduleNextTick();
    });
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(task, task);
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async scheduleNextTick(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);

    const store = await loadStore();
    let nearest: number | null = null;
    let changed = false;
    const now = Date.now();

    for (const job of store.jobs) {
      if (!job.enabled) continue;
      const next = nextRunAt(job.schedule, job.state.nextRunAtMs && job.state.nextRunAtMs > now - 1000
        ? job.state.nextRunAtMs - 1000
        : now);
      if (next !== job.state.nextRunAtMs) {
        job.state.nextRunAtMs = next ?? undefined;
        changed = true;
      }
      if (typeof next === 'number' && (nearest == null || next < nearest)) nearest = next;
    }

    if (changed) await saveStore(store);

    const delay = nearest == null
      ? MAX_TIMER_MS
      : Math.max(1_000, Math.min(MAX_TIMER_MS, nearest - now));

    this.timer = setTimeout(() => {
      void this.runDueJobs();
    }, delay);
  }

  private async runDueJobs(): Promise<void> {
    const store = await loadStore();
    const now = Date.now();
    const dueJobs = store.jobs.filter((job) => (
      job.enabled
      && typeof job.state.nextRunAtMs === 'number'
      && job.state.nextRunAtMs <= now
    ));

    await Promise.allSettled(dueJobs.map((job) => this.executeJob(job.id, false)));
    await this.scheduleNextTick();
  }

  async listJobs(): Promise<RobinCronJob[]> {
    return this.withLock(async () => {
      const store = await loadStore();
      const now = Date.now();
      let changed = false;

      for (const job of store.jobs) {
        const next = job.enabled ? nextRunAt(job.schedule, now) : null;
        if ((job.state.nextRunAtMs ?? null) !== (next ?? null)) {
          job.state.nextRunAtMs = next ?? undefined;
          changed = true;
        }
      }

      if (changed) await saveStore(store);
      return safeJsonClone(store.jobs);
    });
  }

  async getJob(jobId: string): Promise<RobinCronJob | null> {
    const jobs = await this.listJobs();
    return jobs.find((job) => job.id === jobId) ?? null;
  }

  async addJob(input: Omit<RobinCronJob, 'id' | 'createdAt' | 'updatedAt' | 'state'>): Promise<RobinCronJob> {
    const nextJob: RobinCronJob = normalizeJob({
      ...input,
      id: randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      state: {},
    });

    return this.withLock(async () => {
      const store = await loadStore();
      nextJob.schedule = scheduleWithAnchor(nextJob.schedule, Date.now());
      nextJob.state.nextRunAtMs = nextJob.enabled ? nextRunAt(nextJob.schedule, Date.now()) ?? undefined : undefined;
      store.jobs.push(nextJob);
      await saveStore(store);
      await this.scheduleNextTick();
      return safeJsonClone(nextJob);
    });
  }

  async updateJob(jobId: string, patch: Partial<Omit<RobinCronJob, 'id' | 'createdAt'>>): Promise<RobinCronJob> {
    return this.withLock(async () => {
      const store = await loadStore();
      const job = store.jobs.find((entry) => entry.id === jobId);
      if (!job) throw new Error(`Cron job not found: ${jobId}`);

      const updated: RobinCronJob = normalizeJob({
        ...job,
        ...patch,
        payload: patch.payload ? normalizePayload(patch.payload) : job.payload,
        schedule: patch.schedule ? normalizeSchedule(patch.schedule) : job.schedule,
        delivery: patch.delivery ? normalizeDelivery(patch.delivery) : job.delivery,
        state: { ...job.state },
        updatedAt: nowIso(),
      });
      updated.schedule = scheduleWithAnchor(updated.schedule, job.schedule.kind === 'every' && typeof job.schedule.anchorMs === 'number'
        ? job.schedule.anchorMs
        : Date.now());
      updated.state.nextRunAtMs = updated.enabled ? nextRunAt(updated.schedule, Date.now()) ?? undefined : undefined;

      store.jobs = store.jobs.map((entry) => (entry.id === jobId ? updated : entry));
      await saveStore(store);
      await this.scheduleNextTick();
      return safeJsonClone(updated);
    });
  }

  async removeJob(jobId: string): Promise<{ removed: boolean }> {
    return this.withLock(async () => {
      const store = await loadStore();
      const originalLength = store.jobs.length;
      store.jobs = store.jobs.filter((job) => job.id !== jobId);
      if (store.jobs.length !== originalLength) {
        await saveStore(store);
        await this.scheduleNextTick();
      }
      return { removed: store.jobs.length !== originalLength };
    });
  }

  async readRuns(jobId: string): Promise<RobinCronRunEntry[]> {
    return readRunEntries(jobId);
  }

  async runNow(jobId: string): Promise<RobinCronRunEntry> {
    return this.executeJob(jobId, true);
  }

  private async executeJob(jobId: string, manual: boolean): Promise<RobinCronRunEntry> {
    let jobSnapshot: RobinCronJob | null = null;
    const runStartedAt = Date.now();

    await this.withLock(async () => {
      const store = await loadStore();
      const job = store.jobs.find((entry) => entry.id === jobId);
      if (!job) throw new Error(`Cron job not found: ${jobId}`);
      if (this.running.has(jobId)) throw new Error(`Cron job already running: ${jobId}`);

      this.running.add(jobId);
      job.state = {
        ...job.state,
        lastRunAtMs: runStartedAt,
        lastStatus: 'running',
        lastError: undefined,
      };
      job.updatedAt = nowIso();
      jobSnapshot = safeJsonClone(job);
      await saveStore(store);
    });

    try {
      const summary = await this.executePayload(jobSnapshot!);
      const entry = await this.withLock(async () => {
        const store = await loadStore();
        const job = store.jobs.find((current) => current.id === jobId);
        const nextRunAtMs = jobSnapshot?.enabled && jobSnapshot.schedule.kind !== 'at'
          ? nextRunAt(jobSnapshot.schedule, Date.now()) ?? undefined
          : undefined;
        if (job) {
          job.state = {
            ...job.state,
            nextRunAtMs,
            lastRunAtMs: runStartedAt,
            lastStatus: 'ok',
            lastError: undefined,
            lastDeliveryStatus: job.delivery?.mode === 'announce' ? 'unsupported' : 'none',
          };
          if (job.schedule.kind === 'at') job.enabled = false;
          job.updatedAt = nowIso();
          await saveStore(store);
        }

        return {
          ts: runStartedAt,
          timestamp: new Date(runStartedAt).toISOString(),
          jobId,
          status: 'ok',
          summary,
          durationMs: Date.now() - runStartedAt,
          nextRunAtMs,
          manual,
        } satisfies RobinCronRunEntry;
      });

      await appendRunEntry(jobId, entry);
      return entry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const entry = await this.withLock(async () => {
        const store = await loadStore();
        const job = store.jobs.find((current) => current.id === jobId);
        const nextRunAtMs = jobSnapshot?.enabled && jobSnapshot.schedule.kind !== 'at'
          ? nextRunAt(jobSnapshot.schedule, Date.now()) ?? undefined
          : undefined;
        if (job) {
          job.state = {
            ...job.state,
            nextRunAtMs,
            lastRunAtMs: runStartedAt,
            lastStatus: 'error',
            lastError: message,
            lastDeliveryStatus: 'none',
          };
          if (job.schedule.kind === 'at') job.enabled = false;
          job.updatedAt = nowIso();
          await saveStore(store);
        }

        return {
          ts: runStartedAt,
          timestamp: new Date(runStartedAt).toISOString(),
          jobId,
          status: 'error',
          error: message,
          durationMs: Date.now() - runStartedAt,
          nextRunAtMs,
          manual,
        } satisfies RobinCronRunEntry;
      });

      await appendRunEntry(jobId, entry);
      throw err;
    } finally {
      this.running.delete(jobId);
      await this.scheduleNextTick();
    }
  }

  private async executePayload(job: RobinCronJob): Promise<string> {
    if (job.payload.kind === 'systemEvent') {
      return job.payload.text.trim() || `Cron ${job.name || job.id} fired.`;
    }

    const sessionKey = `local:cron:${job.id}:${randomUUID()}`;
    const snapshot = await opsAgentService.sendMessage(sessionKey, job.payload.message, {
      transport: 'local',
      localModelId: job.payload.model || config.localApiModel,
      localApiBaseUrl: config.localApiBaseUrl,
      localApiKey: config.localApiKey,
    });

    const assistantMessages = snapshot.history.filter((message) => message.role === 'assistant');
    const lastAssistant = assistantMessages.at(-1);
    const summary = lastAssistant?.text?.trim() || 'Completed without a reply.';
    return summary === 'NO_REPLY' ? 'Completed without a return message.' : summary;
  }
}

export const robinCronManager = new RobinCronManager();
