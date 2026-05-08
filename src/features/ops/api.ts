export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt: string;
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
  id: 'gdelt' | 'gdacs' | 'usgs' | 'nws' | 'firms';
  name: string;
  category: 'news' | 'disaster' | 'seismic' | 'weather' | 'fire';
  enabled: boolean;
  ok: boolean;
  stale: boolean;
  itemCount: number;
  refreshSeconds: number;
  lastFetchedAt?: string;
  lastError?: string;
  attribution: string;
  requiresKey?: boolean;
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

export const opsApi = {
  createSession: (sessionKey?: string) =>
    request<{ ok: true; session: AgentSession }>('/api/agent/session', {
      method: 'POST',
      body: JSON.stringify(sessionKey ? { sessionKey } : {}),
    }),
  getSession: (sessionId: string) =>
    request<{ ok: true; session: AgentSession }>(`/api/agent/session/${encodeURIComponent(sessionId)}`),
  sendMessage: (sessionId: string, text: string) =>
    request<{ ok: true; session: AgentSession }>(`/api/agent/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
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
};
