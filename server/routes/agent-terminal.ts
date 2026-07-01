/**
 * ROBIN Ops Agent Terminal Session Routes
 *
 * WebSocket endpoint at /api/agent-terminal/ws for PTY terminal sessions
 *
 * Protocol:
 *   Server -> Client:
 *     { type: "connected", sessionId: string }
 *     { type: "pong" }
 *     { type: "error", message: string }
 *     { type: "exit", exitCode: number, signal: number | undefined }
 *     { type: "resumed", token: string }
 *     Raw PTY output (plain string)
 *
 *   Client -> Server:
 *     { type: "resize", cols: number, rows: number }
 *     { type: "ping" }
 *     Raw terminal input string
 */

import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { spawn as spawnPty } from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import { config } from '../lib/config.js';
import { SessionManager } from '../lib/terminal-session-manager.js';

const app = new Hono();

// Default workspace path
const DEFAULT_WORKSPACE = process.env.INERTIAI_OPS_TERMINAL_WORKSPACE?.trim() ||
  path.join(os.homedir(), '.robin', 'workspace');

// Document directory for agent access
const DOCUMENT_DIR = path.join(config.home, '.robin', 'inertiai-ops', 'documents');

// PTY spawn function using default shell
function spawnTerminalPty(cols: number, rows: number) {

  // Use shell appropriate for platform
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const shellArgs = process.platform === 'win32' ? ['-NoLogo'] : ['-l'];

  return spawnPty(shell, shellArgs, {
    cols,
    rows,
    cwd: DEFAULT_WORKSPACE,
    env: {
      ...process.env,
      ROBIN_MODE: '1',
      ROBIN_WORKSPACE_DIR: DEFAULT_WORKSPACE,
      ROBIN_DOCUMENT_DIR: DOCUMENT_DIR,
      ROBIN_LLM_BASE_URL: config.localApiBaseUrl || '',
      ROBIN_LLM_API_KEY: config.localApiKey || '',
      ROBIN_MODEL_ID: config.localApiModel || '',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    name: 'xterm-256color',
    ...(process.platform === 'win32' ? { useConpty: false } : {}),
  });
}

const sessionManager = new SessionManager(
  10, // max sessions
  spawnTerminalPty,
  5 * 60_000, // 5 minute grace period
  100 * 1024, // 100KB scrollback
  3, // max per user
);

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  const url = new URL(ws.url || '', 'http://localhost');
  const cols = parseInt(url.searchParams.get('cols') || '80', 10);
  const rows = parseInt(url.searchParams.get('rows') || '24', 10);
  const resumeToken = url.searchParams.get('resume');

  // Try to resume existing session
  if (resumeToken) {
    const resumed = sessionManager.resume(resumeToken, ws, cols, rows);
    if (resumed) return;
  }

  // Create new session
  const token = sessionManager.create(ws, cols, rows);
  if (token) {
    ws.send(JSON.stringify({ type: 'connected', sessionId: token }));
  } else {
    ws.send(JSON.stringify({ type: 'error', message: 'Max sessions reached' }));
    ws.close(1013, 'Max sessions reached');
  }
});

// HTTP routes for session management
app.get('/api/agent-terminal/sessions', async (c) => {
  try {
    const sessions = sessionManager.listSessions();
    return c.json({ ok: true, sessions });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

app.delete('/api/agent-terminal/sessions/:token', async (c) => {
  const { token } = c.req.param();
  try {
    sessionManager.destroySession(token);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 404);
  }
});

// Block-send endpoint for proxy panels
app.post('/api/terminals/:id/block', async (c) => {
  const { id } = c.req.param();
  try {
    const body = await c.req.json().catch(() => ({})) as { text?: string };
    const session = sessionManager.getSession(id);
    
    if (!session || !session.pty) {
      return c.json({ ok: false, error: 'Session not found or not running' }, 404);
    }

    const payload = (body.text || '').replace(/\r?\n/g, '\r') + '\r';
    session.pty.write(payload);

    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
  }
});

export default app;
export { wss, sessionManager, spawnTerminalPty };
