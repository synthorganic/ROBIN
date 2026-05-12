export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt: string;
  reasoning?: string[];
  toolCalls?: AgentToolCall[];
}

export interface AgentToolCall {
  type: string;
  name: string;
  arguments?: string;
}

export interface AgentSession {
  id: string;
  label: string;
  status: string;
  history: AgentMessage[];
  updatedAt: string;
}

export interface TerminalState {
  id: 'cli' | 'support' | 'logs';
  label: string;
  role: 'cli-agent' | 'support-shell' | 'bridge-log';
  running: boolean;
  cols: number;
  rows: number;
  readonly: boolean;
  lastUpdated: number;
  pid: number | null;
  buffer: string[];
}

export interface BridgeJob {
  id: string;
  sessionId: string;
  targetTerminalId: 'cli';
  state: 'idle' | 'sent' | 'returned' | 'cancelled';
  prompt: string;
  transcriptRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeStatus {
  activeJob: BridgeJob | null;
  recentJobs: BridgeJob[];
}

export interface MapAsset {
  id: string;
  title: string;
  type: 'document' | 'video' | 'note' | 'link';
  lat: number;
  lng: number;
  sourceUrl: string;
  streamUrl?: string;
  thumbnailUrl?: string;
  notes?: string;
  tags: string[];
  status?: string;
  linkedSessionId?: string;
  sourceId?: string;
  sourceName?: string;
  severity?: 'info' | 'watch' | 'warning' | 'critical';
  confidence?: 'low' | 'medium' | 'high';
  observedAt?: string;
  live?: boolean;
  createdAt?: string;
  updatedAt?: string;
  heading?: number;
  speed?: number;
  altitude?: number;
  trail?: Array<{ lat: number; lng: number; observedAt?: string }>;
}

export interface MapLayer {
  id: string;
  name: string;
  visible: boolean;
  assetIds: string[];
  kind?: 'type' | 'source';
  sourceId?: string;
}

export interface MapSourceStatus {
  id:
    | 'gdelt'
    | 'gdacs'
    | 'usgs'
    | 'nws'
    | 'firms'
    | 'radnet'
    | 'trafficcams'
    | 'trackedflights'
    | 'eurdep'
    | 'safecast'
    | 'gmcmap'
    | 'nrcevents'
    | 'nrcreactorstatus'
    | 'ntad'
    | 'faf'
    | 'marinecadastre'
    | 'mobilitydb'
    | 'tigerline';
  name: string;
  category: 'news' | 'disaster' | 'seismic' | 'weather' | 'fire' | 'nuclear' | 'transport' | 'freight' | 'maritime' | 'mobility' | 'reference';
  enabled: boolean;
  ok: boolean;
  stale: boolean;
  catalogOnly?: boolean;
  itemCount: number;
  refreshSeconds: number;
  lastFetchedAt?: string;
  lastError?: string;
  attribution: string;
  requiresKey?: boolean;
  description?: string;
}

export interface OpsDocument {
  id: string;
  project: string;
  title: string;
  fileName: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  storagePath: string;
  sourceUrl: string;
  uploadedAt: string;
  textPreview?: string;
}

export interface AgentToolCatalogItem {
  id: string;
  directoryName: string;
  displayName: string;
  aliases: string[];
  category: string;
  description: string;
  promptExcerpt: string;
  promptPath?: string;
  toolPath?: string;
}

export interface AgentToolCatalog {
  sourcePath: string;
  tools: AgentToolCatalogItem[];
  generatedAt: string;
}

export interface ApiKeyStatus {
  openaiKeySet: boolean;
  replicateKeySet: boolean;
  xiaomiKeySet: boolean;
}

export type AgentTransport = 'gateway' | 'local';

export interface LocalApiModel {
  id: string;
  name?: string;
  object?: string;
  created?: number;
}

export interface LocalApiStatus {
  baseUrl: string;
  apiKeySet: boolean;
  defaultModelId: string;
  configuredFrom?: string;
}

export interface AgentSendOptions {
  includeDocuments?: boolean;
  includeToolInstructions?: boolean;
  documentIds?: string[];
  toolNames?: string[];
  transport?: AgentTransport;
  localModelId?: string;
  localApiBaseUrl?: string;
  localApiKey?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  });

  if (!response.ok) {
    const raw = await response.text();
    let parsedError = '';
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      parsedError = parsed.error || '';
    } catch {
      // Fall back to raw text when the error body is not JSON.
    }
    throw new Error(parsedError || raw || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function uploadRequest<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    body,
  });

  if (!response.ok) {
    const raw = await response.text();
    let parsedError = '';
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      parsedError = parsed.error || '';
    } catch {
      // Fall back to raw text when the error body is not JSON.
    }
    throw new Error(parsedError || raw || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const opsApi = {
  createSession: (sessionKey?: string, transport?: AgentTransport) =>
    request<{ ok: true; session: AgentSession }>('/api/agent/session', {
      method: 'POST',
      body: JSON.stringify({ ...(sessionKey ? { sessionKey } : {}), ...(transport ? { transport } : {}) }),
    }),
  getSession: (sessionId: string) =>
    request<{ ok: true; session: AgentSession }>(`/api/agent/session/${encodeURIComponent(sessionId)}`),
  sendMessage: (sessionId: string, text: string, options?: AgentSendOptions) =>
    request<{ ok: true; session: AgentSession }>(`/api/agent/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ text, ...options }),
    }),
  abortSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/agent/session/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listTerminals: () =>
    request<{ ok: true; terminals: TerminalState[] }>('/api/terminals'),
  startTerminal: (terminalId: TerminalState['id']) =>
    request<{ ok: true; terminal: TerminalState }>(`/api/terminals/${terminalId}/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  stopTerminal: (terminalId: TerminalState['id']) =>
    request<{ ok: true; terminal: TerminalState }>(`/api/terminals/${terminalId}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  writeTerminal: (terminalId: TerminalState['id'], input: string) =>
    request<{ ok: true; terminal: TerminalState }>(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    }),
  resizeTerminal: (terminalId: TerminalState['id'], cols: number, rows: number) =>
    request<{ ok: true; terminal: TerminalState }>(`/api/terminals/${terminalId}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),
  ctrlCTerminal: (terminalId: Exclude<TerminalState['id'], 'logs'>) =>
    request<{ ok: true; terminal: TerminalState }>(`/api/terminals/${terminalId}/ctrl-c`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getBridgeStatus: () =>
    request<{ ok: true } & BridgeStatus>('/api/bridge/status'),
  handoffToCli: (sessionId: string, prompt: string, context?: string) =>
    request<{ ok: true } & BridgeStatus>('/api/bridge/handoff-to-cli', {
      method: 'POST',
      body: JSON.stringify({ sessionId, prompt, context }),
    }),
  returnToAgent: (sessionId: string, text: string) =>
    request<{ ok: true } & BridgeStatus>('/api/bridge/return-to-agent', {
      method: 'POST',
      body: JSON.stringify({ sessionId, text }),
    }),
  cancelBridge: () =>
    request<{ ok: true } & BridgeStatus>('/api/bridge/cancel', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listAssets: () =>
    request<{ ok: true; assets: MapAsset[] }>('/api/map/assets'),
  listLayers: () =>
    request<{ ok: true; layers: MapLayer[] }>('/api/map/layers'),
  listSources: () =>
    request<{ ok: true; sources: MapSourceStatus[] }>('/api/map/sources'),
  refreshSources: () =>
    request<{ ok: true; assets: MapAsset[]; layers: MapLayer[]; sources: MapSourceStatus[] }>('/api/map/sources/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  createAsset: (asset: Omit<MapAsset, 'id'>) =>
    request<{ ok: true; asset: MapAsset }>('/api/map/assets', {
      method: 'POST',
      body: JSON.stringify(asset),
    }),
  updateAsset: (assetId: string, patch: Partial<Omit<MapAsset, 'id'>>) =>
    request<{ ok: true; asset: MapAsset }>(`/api/map/assets/${encodeURIComponent(assetId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  deleteAsset: (assetId: string) =>
    request<{ ok: true }>(`/api/map/assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    }),
  listDocuments: () =>
    request<{ ok: true; documents: OpsDocument[] }>('/api/documents'),
  uploadDocument: (file: File, project: string, title?: string) => {
    const body = new FormData();
    body.set('file', file);
    body.set('project', project);
    if (title) body.set('title', title);
    return uploadRequest<{ ok: true; document: OpsDocument; documents: OpsDocument[] }>('/api/documents/upload', body);
  },
  deleteDocument: (documentId: string) =>
    request<{ ok: true; documents: OpsDocument[] }>(`/api/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    }),
  getAgentToolCatalog: (refresh = false) =>
    request<{ ok: true; catalog: AgentToolCatalog }>(`/api/agent-tools/catalog${refresh ? '?refresh=true' : ''}`),
  getApiKeyStatus: () =>
    request<ApiKeyStatus>('/api/keys'),
  saveApiKeys: (payload: { openaiKey?: string; replicateToken?: string; mimoApiKey?: string }) =>
    request<{ ok: true; message: string } & ApiKeyStatus>('/api/keys', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getLocalApiStatus: () =>
    request<{ ok: true; localApi: LocalApiStatus }>('/api/agent/local-api'),
  saveLocalApiConfig: (payload: { baseUrl: string; apiKey?: string; defaultModelId?: string }) =>
    request<{ ok: true; localApi: LocalApiStatus }>('/api/agent/local-api', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  pollLocalApiModels: (payload: { baseUrl: string; apiKey?: string }) =>
    request<{ ok: true; connected: true; baseUrl: string; models: LocalApiModel[] }>('/api/agent/local-api/models', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
