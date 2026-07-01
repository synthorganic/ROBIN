/**
 * Shared gateway RPC client.
 *
 * Makes direct WebSocket RPC calls to the OpenClaw gateway for workspace
 * file access. Uses a single persistent connection that multiplexes all
 * RPC calls, avoiding the overhead and session conflicts of per-request
 * connections.
 *
 * Used as a fallback when the workspace directory is not locally accessible
 * (e.g. ROBIN on DGX host, workspace in OpenShell sandbox).
 * @module
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { config } from './config.js';
import { createDeviceBlock } from './device-identity.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GatewayFileEntry {
  name: string;
  path: string;
  missing: boolean;
  size: number;
  updatedAtMs: number;
}

export interface GatewayFileWithContent extends GatewayFileEntry {
  content: string;
}

// ── Persistent connection ────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

/** Derive the WebSocket URL from the HTTP gateway URL. */
function getGatewayWsUrl(): string {
  const httpUrl = config.gatewayUrl;
  let wsUrl: string;
  if (httpUrl.startsWith('ws://') || httpUrl.startsWith('wss://')) {
    wsUrl = httpUrl;
  } else {
    wsUrl = httpUrl.replace(/^http/, 'ws');
  }
  if (!wsUrl.endsWith('/ws')) {
    wsUrl = wsUrl.replace(/\/$/, '') + '/ws';
  }
  return wsUrl;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let ws: WebSocket | null = null;
let connected = false;
let connecting = false;
const pending = new Map<string, PendingCall>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectPromise: Promise<void> | null = null;
let connectResolve: (() => void) | null = null;
let connectReject: ((err: Error) => void) | null = null;

function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function getGatewayRequestOrigin(): string {
  const configuredPublicOrigin = normalizeOrigin(config.publicOrigin);
  if (configuredPublicOrigin) return configuredPublicOrigin;

  const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => Boolean(value));

  const firstNonLoopbackOrigin = configuredAllowedOrigins.find((origin) => !isLoopbackOrigin(origin));
  if (firstNonLoopbackOrigin) return firstNonLoopbackOrigin;

  const firstAllowedOrigin = configuredAllowedOrigins[0];
  if (firstAllowedOrigin) return firstAllowedOrigin;

  return `http://127.0.0.1:${config.port}`;
}

function buildConnectParams(nonce: string) {
  const clientId = 'openclaw-control-ui';
  const clientMode = 'webchat';
  const role = 'operator';
  const scopes = ['operator.admin', 'operator.read', 'operator.write'];
  const token = config.gatewayToken;

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      version: '0.1.0',
      platform: 'web',
      mode: clientMode,
      instanceId: `robin-rpc-${randomUUID().slice(0, 8)}`,
    },
    role,
    scopes,
    auth: { token },
    device: createDeviceBlock({
      clientId,
      clientMode,
      role,
      scopes,
      token,
      nonce,
    }),
  };
}

/** Send a raw message, ensuring the connection is ready. */
function wsSend(data: string): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    return true;
  }
  return false;
}

/** Clean up all pending calls with an error. */
function rejectAllPending(reason: string): void {
  for (const [id, call] of pending) {
    clearTimeout(call.timer);
    call.reject(new Error(reason));
    pending.delete(id);
  }
}

/** Reject and clear the in-flight connect promise. */
function rejectConnect(reason: string): void {
  if (connectReject) {
    connectReject(new Error(reason));
  }
  connectPromise = null;
  connectResolve = null;
  connectReject = null;
}

/** Check whether the gateway supports WebSocket connections (full OpenClaw vs local v1). */
let isHttpOnlyGateway: boolean | null = null;
async function probeGatewayType(): Promise<boolean> {
  if (isHttpOnlyGateway !== null) return isHttpOnlyGateway;
  try {
    const httpUrl = config.gatewayUrl.replace(/^ws/, 'http');
    const res = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      // Health endpoint exists — now check if /ws works
      // If it's a local gateway-v1, WS will fail quickly. We probe by trying WS.
      const testWs = new WebSocket(getGatewayWsUrl(), { headers: { Origin: getGatewayRequestOrigin() } });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          testWs.close();
          resolve();
        }, 2000);
        testWs.on('open', () => {
          clearTimeout(timeout);
          // Got WS open — wait briefly for connect.challenge
          const challengeTimeout = setTimeout(() => {
            testWs.close();
            resolve();
          }, 1500);
          testWs.once('message', (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.event === 'connect.challenge') {
                // Full OpenClaw gateway with WS support
                isHttpOnlyGateway = false;
                clearTimeout(challengeTimeout);
                testWs.close();
                resolve();
              }
            } catch { /* ignore */ }
          });
          testWs.on('close', () => {
            // Closed without challenge — HTTP-only gateway
            isHttpOnlyGateway = true;
            clearTimeout(challengeTimeout);
            resolve();
          });
        });
        testWs.on('error', () => {
          clearTimeout(timeout);
          isHttpOnlyGateway = true;
          resolve();
        });
      });
    } else {
      // No health endpoint — assume full gateway (might be behind proxy)
      isHttpOnlyGateway = false;
    }
  } catch {
    // Can't probe — assume full gateway and let WS attempt proceed
    isHttpOnlyGateway = false;
  }
  return isHttpOnlyGateway!;
}

/** Establish the persistent gateway connection. */
async function ensureConnection(): Promise<void> {
  if (ws || connecting) return;
  if (!config.gatewayToken) return; // No token = can't connect

  // Check if this is an HTTP-only gateway (local v1)
  const httpOnly = await probeGatewayType();
  if (httpOnly) {
    console.log('[gateway-rpc] Local gateway-v1 detected — WebSocket RPC unavailable, using HTTP fallback');
    // Resolve connect promise so callers don't hang, but mark as not connected
    connecting = false;
    connected = false;
    return;
  }

  connecting = true;
  connectPromise = new Promise<void>((resolve, reject) => {
    connectResolve = resolve;
    connectReject = reject;
  });
  const wsUrl = getGatewayWsUrl();

  const socket = new WebSocket(wsUrl, {
    headers: { Origin: getGatewayRequestOrigin() },
  });

  socket.on('open', () => {
    // Wait for connect.challenge
  });

  socket.on('message', (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      // Handle connect.challenge → send connect
      if (msg.type === 'event' && msg.event === 'connect.challenge' && msg.payload?.nonce) {
        socket.send(JSON.stringify({
          type: 'req',
          id: '__connect__',
          method: 'connect',
          params: buildConnectParams(msg.payload.nonce),
        }));
        return;
      }

      // Handle connect response
      if (msg.type === 'res' && msg.id === '__connect__') {
        connecting = false;
        if (msg.ok) {
          ws = socket;
          connected = true;
          if (connectResolve) {
            connectResolve();
          }
          connectResolve = null;
          connectReject = null;
          console.log('[gateway-rpc] Connected to gateway (persistent)');
        } else {
          const reason = msg.error?.message || 'Gateway connect rejected';
          console.error('[gateway-rpc] Gateway connect rejected:', reason);
          rejectConnect(reason);
          socket.close();
        }
        return;
      }

      // Handle RPC responses
      if (msg.type === 'res' && pending.has(msg.id)) {
        const call = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.ok === false) {
          call.reject(new Error(msg.error?.message || 'RPC error'));
        } else {
          call.resolve(msg.payload ?? msg.result ?? msg);
        }
        return;
      }

      // Ignore other events (chat messages, etc.)
    } catch {
      // Ignore parse errors
    }
  });

  socket.on('error', (err) => {
    console.warn('[gateway-rpc] WebSocket error:', err.message);
  });

  socket.on('close', () => {
    const wasConnected = connected;
    const wasConnecting = connecting;
    ws = null;
    connected = false;
    connecting = false;

    if (!wasConnected && wasConnecting) {
      rejectConnect('Gateway connection closed before connect completed');
    } else {
      connectPromise = null;
      connectResolve = null;
      connectReject = null;
    }

    rejectAllPending('Gateway connection closed');

    // Auto-reconnect after a delay (only if we had a working connection)
    if (wasConnected && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureConnection();
      }, RECONNECT_DELAY_MS);
    }
  });
}

// ── Core RPC call ────────────────────────────────────────────────────

/**
 * Execute a gateway RPC call via HTTP fallback (for local gateway-v1).
 *
 * Gateway-v1 only exposes /tools/invoke for file/exec tools. Session and chat
 * management methods are handled locally here so the server boots cleanly even
 * without a full OpenClaw WebSocket gateway.
 */
async function httpRpcCall(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const httpUrl = config.gatewayUrl.replace(/^ws/, 'http');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.gatewayToken) headers['Authorization'] = `Bearer ${config.gatewayToken}`;

  // ── Methods that have no gateway-v1 equivalent — return safe defaults ──

  // Session listing: return a single local session so the UI doesn't error
  if (method === 'sessions.list') {
    return { sessions: [{ sessionKey: 'local:ops:main', key: 'local:ops:main', label: 'Local Agent', state: 'idle' }] };
  }

  // Session create / send / delete — no-op stubs for local mode (kanban subagent fallback)
  if (method === 'sessions.create') {
    return { sessionKey: `local-sub-${randomUUID().slice(0, 8)}`, ok: true };
  }
  if (method === 'sessions.send' || method === 'sessions.delete') {
    return { ok: true };
  }

  // Chat history: empty for local mode (history lives in ops-agent.ts memory)
  if (method === 'chat.history') {
    return { messages: [] };
  }

  // Chat send / abort — no-op for local mode (handled by ops-agent directly)
  if (method === 'chat.send' || method === 'chat.abort') {
    return { ok: true, runId: `local-${randomUUID().slice(0, 8)}` };
  }

  // Agent file operations — no-op stubs for local mode
  if (method.startsWith('agents.files.')) {
    const sub = method.split('.')[2];
    if (sub === 'list') return { files: [] };
    if (sub === 'get') return { file: { missing: true, name: String(params.name || ''), content: '' } };
    if (sub === 'set') return { ok: true };
  }

  // ── Everything else — try /tools/invoke on gateway-v1 ──

  const response = await fetch(`${httpUrl}/tools/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tool: method, args: params }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP RPC failed: ${response.status} ${text}`);
  }

  const result = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!result.ok) {
    throw new Error(result.error || 'HTTP RPC returned ok=false');
  }
  return result.result;
}

/**
 * Execute a gateway RPC call via the persistent WebSocket connection,
 * falling back to HTTP when WS is unavailable (local gateway-v1).
 */
export async function gatewayRpcCall(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  // Ensure connection exists (now async due to HTTP-only probe)
  await ensureConnection();

  // If WS is not connected and no connect promise pending, use HTTP fallback
  if (!connected && !connectPromise) {
    return httpRpcCall(method, params, timeoutMs);
  }

  // Wait for connection if not yet connected
  if (!connected && connectPromise) {
    await connectPromise;
  }

  // If still not connected after waiting, fall back to HTTP
  if (!connected) {
    return httpRpcCall(method, params, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const reqId = randomUUID();

    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`Gateway RPC timeout after ${timeoutMs}ms calling ${method}`));
    }, timeoutMs);

    pending.set(reqId, { resolve, reject, timer });

    const sent = wsSend(JSON.stringify({ type: 'req', id: reqId, method, params }));
    if (!sent) {
      pending.delete(reqId);
      clearTimeout(timer);
      // Fall back to HTTP on send failure
      resolve(httpRpcCall(method, params, timeoutMs));
    }
  });
}

// ── Typed file RPC wrappers ──────────────────────────────────────────

/**
 * List top-level workspace files for an agent via gateway RPC.
 */
export async function gatewayFilesList(agentId: string): Promise<GatewayFileEntry[]> {
  const result = await gatewayRpcCall('agents.files.list', { agentId }) as {
    files?: GatewayFileEntry[];
  };
  return result.files ?? [];
}

/**
 * Read a top-level workspace file via gateway RPC.
 * Returns null if the file is not found or unsupported.
 *
 * Gateway response shape: `{ agentId, workspace, file: { name, content, ... } }`
 */
export async function gatewayFilesGet(agentId: string, name: string): Promise<GatewayFileWithContent | null> {
  try {
    const result = await gatewayRpcCall('agents.files.get', { agentId, name }) as {
      file?: GatewayFileWithContent;
    } & GatewayFileWithContent;
    const file = result.file ?? result;
    if (!file || file.missing) return null;
    return file;
  } catch (err) {
    console.debug('[gateway-rpc] filesGet error:', (err as Error).message);
    return null;
  }
}

/**
 * Write a top-level workspace file via gateway RPC.
 */
export async function gatewayFilesSet(agentId: string, name: string, content: string): Promise<void> {
  await gatewayRpcCall('agents.files.set', { agentId, name, content });
}
