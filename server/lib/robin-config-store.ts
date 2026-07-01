import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { lmStudioService } from './lmstudio-service.js';

export interface RobinGatewayModelEntry {
  id: string;
  label?: string;
  alias?: string;
  provider?: string;
  role?: 'primary' | 'fallback' | 'allowed';
}

export interface RobinSessionPreferences {
  model?: string;
  thinking?: string;
  instructions?: string;
  updatedAt?: string;
}

export interface RobinGatewayConfig {
  gateway?: {
    port?: number;
    bind?: string;
    auth?: {
      mode?: 'token' | 'none';
      token?: string;
    };
    controlUi?: {
      allowedOrigins?: string[];
    };
    tools?: {
      allow?: string[];
    };
  };
  channels?: Record<string, unknown>;
  models?:
    | RobinGatewayModelEntry[]
    | {
      available?: RobinGatewayModelEntry[];
      default?: string;
    };
  sessions?: Record<string, RobinSessionPreferences | undefined>;
  localApi?: {
    defaultModelId?: string;
  };
  agents?: {
    defaults?: {
      model?: {
        primary?: string;
        fallbacks?: string[];
      };
      models?: Record<string, { alias?: string } | undefined>;
    };
  };
}

export interface RobinGatewayModelInfo {
  id: string;
  label: string;
  provider: string;
  alias?: string;
  configured: true;
  role: 'primary' | 'fallback' | 'allowed';
}

export const ROBIN_DIR = path.join(config.home, '.robin');
export const ROBIN_RUNTIME_DIR = path.join(ROBIN_DIR, 'inertiai-ops');
export const ROBIN_GATEWAY_CONFIG_PATH = path.join(ROBIN_DIR, 'gateway.json');
export const ROBIN_CRONS_PATH = path.join(ROBIN_RUNTIME_DIR, 'crons.json');
export const ROBIN_CRON_RUNS_DIR = path.join(ROBIN_RUNTIME_DIR, 'cron-runs');

function modelLabelFromId(id: string) {
  const [, ...rest] = id.split('/');
  return rest.join('/') || id;
}

function normalizeModelRole(value: unknown): RobinGatewayModelInfo['role'] {
  return value === 'primary' || value === 'fallback' || value === 'allowed' ? value : 'allowed';
}

function normalizeModelEntry(value: unknown): RobinGatewayModelEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const entry: RobinGatewayModelEntry = { id };
  if (typeof raw.label === 'string' && raw.label.trim()) entry.label = raw.label.trim();
  if (typeof raw.alias === 'string' && raw.alias.trim()) entry.alias = raw.alias.trim();
  if (typeof raw.provider === 'string' && raw.provider.trim()) entry.provider = raw.provider.trim();
  if (raw.role === 'primary' || raw.role === 'fallback' || raw.role === 'allowed') entry.role = raw.role;
  return entry;
}

function explicitModelEntries(source: RobinGatewayConfig): RobinGatewayModelEntry[] {
  const directModels = Array.isArray(source.models)
    ? source.models
    : Array.isArray(source.models?.available)
      ? source.models.available
      : [];

  return directModels
    .map((entry) => normalizeModelEntry(entry))
    .filter((entry): entry is RobinGatewayModelEntry => Boolean(entry));
}

function legacyModelEntries(source: RobinGatewayConfig): RobinGatewayModelEntry[] {
  const defaults = source.agents?.defaults;
  const modelDefaults = defaults?.model;
  const allowlist = defaults?.models || {};
  const entries: RobinGatewayModelEntry[] = [];
  const seen = new Set<string>();

  const push = (id: unknown, role: RobinGatewayModelInfo['role']) => {
    if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) return;
    const normalizedId = id.trim();
    seen.add(normalizedId);
    const alias = allowlist[normalizedId]?.alias?.trim();
    entries.push({
      id: normalizedId,
      alias: alias || undefined,
      label: alias || modelLabelFromId(normalizedId),
      provider: normalizedId.split('/')[0] || 'local',
      role,
    });
  };

  push(modelDefaults?.primary, 'primary');
  for (const fallback of modelDefaults?.fallbacks || []) {
    push(fallback, 'fallback');
  }
  for (const id of Object.keys(allowlist).sort((left, right) => left.localeCompare(right))) {
    push(id, 'allowed');
  }

  return entries;
}

function dedupeModelEntries(entries: RobinGatewayModelEntry[]): RobinGatewayModelInfo[] {
  const seen = new Set<string>();
  const models: RobinGatewayModelInfo[] = [];

  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: entry.alias || entry.label || modelLabelFromId(id),
      provider: entry.provider || id.split('/')[0] || 'local',
      ...(entry.alias ? { alias: entry.alias } : {}),
      configured: true,
      role: normalizeModelRole(entry.role),
    });
  }

  return models;
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function loadRobinGatewayConfig(): Promise<RobinGatewayConfig> {
  return readJsonFile<RobinGatewayConfig>(ROBIN_GATEWAY_CONFIG_PATH, {});
}

export async function saveRobinGatewayConfig(next: RobinGatewayConfig): Promise<void> {
  await writeJsonFile(ROBIN_GATEWAY_CONFIG_PATH, next);
}

export async function listRobinChannels(): Promise<string[]> {
  const cfg = await loadRobinGatewayConfig();
  const channels = cfg.channels;
  if (!channels || typeof channels !== 'object') return [];
  return Object.keys(channels)
    .filter((key) => key !== 'webchat')
    .sort((left, right) => left.localeCompare(right));
}

export async function listRobinGatewayModels(): Promise<RobinGatewayModelInfo[]> {
  try {
    const liveModels = await lmStudioService.getModels({
      baseUrl: config.localApiBaseUrl,
      apiKey: config.localApiKey,
    });
    if (liveModels.length > 0) {
      const defaultModelId = config.localApiModel.trim();
      const liveEntries = liveModels.map((model, index) => ({
        id: model.id,
        label: model.name?.trim() || modelLabelFromId(model.id),
        provider: 'local',
        role: defaultModelId
          ? (model.id === defaultModelId ? 'primary' : 'allowed')
          : (index === 0 ? 'primary' : 'allowed'),
      } satisfies RobinGatewayModelEntry));
      return dedupeModelEntries(liveEntries);
    }
  } catch {
    // Fall back to persisted config and env defaults below.
  }

  const cfg = await loadRobinGatewayConfig();
  const entries = [
    ...explicitModelEntries(cfg),
    ...legacyModelEntries(cfg),
  ];

  const configuredDefaultModel = cfg.localApi?.defaultModelId?.trim()
    || (typeof cfg.models === 'object' && !Array.isArray(cfg.models) && typeof cfg.models.default === 'string'
      ? cfg.models.default.trim()
      : '')
    || config.localApiModel.trim();

  if (configuredDefaultModel) {
    entries.unshift({
      id: configuredDefaultModel,
      label: modelLabelFromId(configuredDefaultModel),
      provider: configuredDefaultModel.split('/')[0] || 'local',
      role: 'primary',
    });
  }

  return dedupeModelEntries(entries);
}

export async function readRobinSessionPreferences(sessionKey?: string): Promise<RobinSessionPreferences> {
  const normalizedKey = sessionKey?.trim() || 'agent:main:main';
  const cfg = await loadRobinGatewayConfig();
  const saved = cfg.sessions?.[normalizedKey];
  return saved && typeof saved === 'object' ? { ...saved } : {};
}

export async function writeRobinSessionPreferences(
  sessionKey: string,
  patch: RobinSessionPreferences,
): Promise<RobinSessionPreferences> {
  const normalizedKey = sessionKey.trim() || 'agent:main:main';
  const cfg = await loadRobinGatewayConfig();
  const current = await readRobinSessionPreferences(normalizedKey);

  const next: RobinSessionPreferences = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  if (!next.model) delete next.model;
  if (!next.thinking) delete next.thinking;
  if (!next.instructions) delete next.instructions;

  if (!cfg.sessions) cfg.sessions = {};
  cfg.sessions[normalizedKey] = next;
  await saveRobinGatewayConfig(cfg);
  return next;
}

export async function readRobinCronsStore<T extends object>(fallback: T): Promise<T> {
  return readJsonFile<T>(ROBIN_CRONS_PATH, fallback);
}

export async function writeRobinCronsStore(value: unknown): Promise<void> {
  await writeJsonFile(ROBIN_CRONS_PATH, value);
}
