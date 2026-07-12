/**
 * ROBIN Gateway v1 - Local-first gateway server.
 *
 * A lightweight HTTP server providing local Robin-Ops tool execution endpoints.
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { config as serverConfig } from './config.js';
import type { ExecuteResult } from './gateway-execution.js';
import { executeBash, executePowerShell } from './gateway-execution.js';
import type { ExecuteCommandOptions } from './gateway-execution.js';
import { listFiles, readFile, fileInfo } from './gateway-files.js';

const HOME = process.env.HOME || os.homedir();
const ROBIN_DIR = path.join(HOME, '.robin');
const GATEWAY_CONFIG_PATH = path.join(ROBIN_DIR, 'gateway.json');
let gatewayStarted = false;

interface GatewayConfig {
  gateway?: {
    port: number;
    bind: string;
    auth?: { mode?: 'token' | 'none'; token?: string };
  };
}

function loadGatewayConfig(): GatewayConfig {
  if (!existsSync(GATEWAY_CONFIG_PATH)) {
    return { gateway: { port: 18789, bind: '127.0.0.1' } };
  }
  try {
    const raw = readFileSync(GATEWAY_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as GatewayConfig;
  } catch (err) {
    console.warn('[gateway] Failed to load config:', (err as Error).message);
    return { gateway: { port: 18789, bind: '127.0.0.1' } };
  }
}

function saveGatewayConfig(cfg: GatewayConfig): void {
  mkdirSync(ROBIN_DIR, { recursive: true });
  writeFileSync(GATEWAY_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function getCommand(body: unknown): string {
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    // Direct command field
    if ('command' in r && typeof r.command === 'string') return r.command;
    // Tool args format
    if (r.args && typeof r.args === 'object' && 'command' in r.args) {
      const argsCmd = (r.args as Record<string, unknown>).command;
      if (typeof argsCmd === 'string') return argsCmd;
    }
  }
  throw new Error('Missing required field: command');
}

export function createGatewayApp(): Hono {
  const app = new Hono();
  app.use('*', logger());

  // Health check
  app.get('/health', (c) => c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }));

  // Token management
  app.post('/init', async (c) => {
    try {
      const body = await c.req.json() as { security?: 'none' | 'token' };
      let cfg = loadGatewayConfig();
      if (!cfg.gateway) cfg.gateway = { port: 18789, bind: '127.0.0.1' };

      const sec = body.security || 'token';
      // Ensure gateway and auth exist
      if (!cfg.gateway) {
        cfg.gateway = { port: 18789, bind: '127.0.0.1' };
      }
      if (sec === 'none') {
        delete cfg.gateway.auth;
      } else if (!cfg.gateway.auth) {
        cfg.gateway.auth = { mode: 'token', token: '' };
      }
      // Safe access since we checked auth exists above
      if (cfg.gateway.auth) {
        cfg.gateway.auth.token = crypto.randomBytes(32).toString('base64url');
      }
      saveGatewayConfig(cfg);

      const token = cfg.gateway?.auth?.token;
      return c.json({
        ok: true,
        message: 'Gateway initialized',
        configPath: GATEWAY_CONFIG_PATH,
        authEnabled: sec !== 'none',
        tokenHint: `Use GATEWAY_TOKEN=${token} in .env`,
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.get('/config', (c) => {
    const cfg = loadGatewayConfig();
    return c.json({ ok: true, gateway: cfg.gateway });
  });

  // Execute routes - direct local execution
  app.post('/execute/bash', async (c) => {
    const body = await c.req.json() as { command: string; timeoutMs?: number };
    if (!body || !body.command) {
      return c.json({ ok: false, error: 'Missing command' }, 400);
    }

    try {
      const result = await executeBash(body.command, {
        timeoutMs: body.timeoutMs || 30_000,
        cwd: process.cwd(),
      });
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/execute/powershell', async (c) => {
    const body = await c.req.json() as { command: string; timeoutMs?: number };
    if (!body || !body.command) {
      return c.json({ ok: false, error: 'Missing command' }, 400);
    }

    try {
      const result = await executePowerShell(body.command, {
        timeoutMs: body.timeoutMs || 60_000,
        cwd: process.cwd(),
      });
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // Tools invoke for compatibility
  app.post('/tools/invoke', async (c) => {
    const body = await c.req.json();
    const tool = String(body?.tool || '');

    try {
      let result: ExecuteResult | { success: boolean; error?: string | null; content?: string | null; files?: Array<{ name: string; path: string }> };

      switch (tool) {
        case 'bash': {
          const cmd = getCommand(body.args);
          if (typeof cmd !== 'string') throw new Error('Invalid command');
          result = await executeBash(cmd, {
            timeoutMs: Number(body.args?.timeoutMs) || 30_000,
            cwd: process.cwd(),
          });
          break;
        }
        case 'powershell': {
          const cmd = getCommand(body.args);
          if (typeof cmd !== 'string') throw new Error('Invalid command');
          result = await executePowerShell(cmd, {
            timeoutMs: Number(body.args?.timeoutMs) || 60_000,
            cwd: process.cwd(),
          });
          break;
        }
        case 'files_list': {
          const directory = body.args?.directory ? String(body.args.directory) : undefined;
          const pattern = body.args?.pattern ? String(body.args.pattern) : undefined;
          const listResult = await listFiles(directory, pattern);
          result = { success: listResult.success, error: listResult.error || null, files: listResult.files };
          break;
        }
        case 'files_read': {
          // Support both 'path' (ROBIN native) and 'file_path' (Atlas Code compatibility)
          const pathArg = body.args?.path ?? body.args?.file_path;
          if (!pathArg) {
            return c.json({ ok: false, error: 'Missing required argument: path' }, 400);
          }
          const fileResult = await readFile(String(pathArg));
          result = { success: fileResult.success, error: fileResult.error || null, content: fileResult.content };
          break;
        }
        case 'files_info': {
          // Support both 'path' (ROBIN native) and 'file_path' (Atlas Code compatibility)
          const pathArg = body.args?.path ?? body.args?.file_path;
          if (!pathArg) {
            return c.json({ ok: false, error: 'Missing required argument: path' }, 400);
          }
          const infoResult = await fileInfo(String(pathArg));
          result = { success: infoResult.success, error: infoResult.error || null, files: infoResult.info ? [infoResult.info] : undefined };
          break;
        }
        case 'files_read_docx': {
          // Support both 'path' (ROBIN native) and 'file_path' (Atlas Code compatibility)
          const pathArg = body.args?.path ?? body.args?.file_path;
          if (!pathArg) {
            return c.json({ ok: false, error: 'Missing required argument: path' }, 400);
          }
          const docxResult = await readFile(String(pathArg));
          result = { success: docxResult.success, error: docxResult.error || null, content: docxResult.content };
          break;
        }
        case 'memories_get': {
          // Support both 'path' (ROBIN native) and 'file_path' (Atlas Code compatibility)
          const pathArg = body.args?.path ?? body.args?.file_path ?? '.robin/memories';
          const fileResult = await readFile(String(pathArg));
          result = { success: fileResult.success, error: fileResult.error || null, content: fileResult.content };
          break;
        }
        case 'sessions_spawn': {
          return c.json({ ok: false, error: 'sessions_spawn requires the higher-level Robin-Ops session bridge' }, 501);
        }
        default: {
          // Provide helpful error with list of valid tools for ROBIN Gateway v1
          const validTools = ['bash', 'powershell', 'files_list', 'files_read', 'files_read_docx', 'files_info', 'memories_get'];
          return c.json({
            ok: false,
            error: `Unknown tool: ${tool}. For ROBIN Gateway v1 (local operations), use one of these tools: ${validTools.join(', ')}`,
            available_tools: validTools
          }, 400);
        }
      }

      // Convert result to expected format (using ExecuteResult structure)
      let output = '';
      if (typeof result === 'object' && 'content' in result) {
        output = String(result.content || '');
      } else if (typeof result === 'object' && 'files' in result && Array.isArray((result as any).files)) {
        output = JSON.stringify((result as any).files, null, 2);
      } else if (typeof result === 'object' && 'error' in result) {
        output = String(result.error || '');
      }

      const resultObj: { success: boolean; output: string; error?: string; files?: Array<{ name: string; path: string }> } = {
        success: typeof result === 'object' && 'success' in result ? Boolean((result as any).success) : true,
        output: output,
        error: typeof result === 'object' && 'error' in result ? String((result as any).error || '') : '',
      };

      if (typeof result === 'object' && Array.isArray((result as any).files)) {
        resultObj.files = (result as any).files;
      }

      return c.json({ ok: true, result: resultObj });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // File system tools
  app.post('/files/list', async (c) => {
    const body = await c.req.json() as { directory?: string; pattern?: string };

    try {
      const result = await listFiles(body.directory, body.pattern);
      return c.json({ ok: result.success, result });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/files/read', async (c) => {
    const body = await c.req.json() as { path: string };

    try {
      if (!body.path) {
        return c.json({ ok: false, error: 'Missing required field: path' }, 400);
      }

      const result = await readFile(body.path);
      return c.json({ ok: result.success, content: result.content, error: result.error });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // Special endpoint for reading .docx files - auto-extracts text
  app.post('/files/read-docx', async (c) => {
    const body = await c.req.json() as { path: string };

    try {
      if (!body.path) {
        return c.json({ ok: false, error: 'Missing required field: path' }, 400);
      }

      const result = await readFile(body.path);
      return c.json({
        ok: result.success,
        content: result.content || '',
        error: result.error,
        source: '.docx extracted text'
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  app.post('/files/info', async (c) => {
    const body = await c.req.json() as { path: string };

    try {
      if (!body.path) {
        return c.json({ ok: false, error: 'Missing required field: path' }, 400);
      }

      const result = await fileInfo(body.path);
      return c.json({ ok: result.success, info: result.info, error: result.error });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // Tools listing endpoint for model to discover available tools
  app.get('/tools', (c) => {
    const tools = [
      {
        name: 'bash',
        description: 'Execute a bash shell command. Use this for Linux/macOS terminal commands, file operations, and system tasks.',
        args_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
          },
          required: ['command']
        }
      },
      {
        name: 'powershell',
        description: 'Execute a PowerShell command. Use this for Windows-specific tasks, registry operations, and .NET framework interactions.',
        args_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The PowerShell command to execute' },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' }
          },
          required: ['command']
        }
      },
      {
        name: 'files_list',
        description: 'List files and directories in a specified path. Use this to explore directory contents.',
        args_schema: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'The directory path to list (default: current working directory)' },
            pattern: { type: 'string', description: 'Optional regex pattern to filter files by name' }
          }
        }
      },
      {
        name: 'files_read',
        description: 'Read the contents of a text file. Use this to read document content, source code, or any readable text file (<10MB). Supports both `path` and `file_path` arguments.',
        args_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute path to the file (also accepts file_path for compatibility)' }
          },
          required: ['path']
        }
      },
      {
        name: 'files_read_docx',
        description: 'Extract text content from a .docx document. Use this for Word documents that require parsing (ZIP/XML format). Returns plain text only - supports both `path` and `file_path` arguments.',
        args_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute path to the .docx file (also accepts file_path for compatibility)' }
          },
          required: ['path']
        }
      },
      {
        name: 'files_info',
        description: 'Get file metadata (size, modification time, etc.) without reading content.',
        args_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute path to the file' }
          },
          required: ['path']
        }
      },
      {
        name: 'memories_get',
        description: 'Retrieve stored memories from the workspace.',
        args_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the memory file' }
          }
        }
      },
      {
        name: 'sessions_spawn',
        description: 'Spawn a new sub-agent session with a specific task.',
        args_schema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Label for the new session' },
            task: { type: 'string', description: 'Task description for the sub-agent' }
          },
          required: ['task']
        }
      }
    ];
    return c.json({ ok: true, tools });
  });

  return app;
}

/**
 * WebSocket server for gateway-v1.
 *
 * Provides WebSocket endpoint at /ws that:
 * - Emits connect.challenge with nonce for handshake
 * - Handles connect requests
 * - Routes RPC methods to HTTP endpoints
 */
let gatewayWss: WebSocketServer | null = null;

/** Generate a challenge nonce for WebSocket connect */
function generateChallengeNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Active challenge nonces with expiration */
const challengeNonces = new Map<string, number>();

/** Purge expired nonces */
function purgeExpiredNonces() {
  const now = Date.now();
  for (const [nonce, expires] of challengeNonces.entries()) {
    if (now > expires) challengeNonces.delete(nonce);
  }
}

/** Interval to purge expired nonces every 60s */
setInterval(purgeExpiredNonces, 60_000);

/** Start WebSocket server on the same HTTP server */
function setupWebSocketServer(server: Awaited<ReturnType<typeof serve>>): void {
  const wss = new WebSocketServer({ noServer: true });
  gatewayWss = wss;

  // Type assertion for node:http.Server which has .on('upgrade')
  const httpServer = server as import('node:http').Server;

  // Get port safely
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 18789;

  httpServer.on('upgrade', (req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    if (req.url?.startsWith('/ws')) {
      // Basic auth check - allow loopback connections without token for local mode
      // The client is loopback if their remote address is 127.0.0.1, ::1, or ::ffff:127.0.0.1
      const remoteAddr = socket.remoteAddress || '';
      const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

      if (!isLoopback) {
        const gatewayCfg = loadGatewayConfig();
        if (gatewayCfg.gateway?.auth?.mode === 'token') {
          const authHeader = req.headers.authorization;
          const token = gatewayCfg.gateway?.auth?.token;
          if (!authHeader || !token || authHeader !== `Bearer ${token}`) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nAuthentication required');
            socket.destroy();
            return;
          }
        }
      }

      gatewayWss!.handleUpgrade(req, socket, head, (ws) => {
        gatewayWss!.emit('connection', ws, req);
      });
    }
  });

  gatewayWss.on('connection', (ws, req) => {
    const connId = crypto.randomBytes(4).toString('hex');
    const tag = `[ws-gw:${connId}]`;

    console.log(`${tag} WebSocket connection established`);

    // Generate and send challenge nonce
    const nonce = generateChallengeNonce();
    const expires = Date.now() + 30_000; // 30s expiration
    challengeNonces.set(nonce, expires);

    ws.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce },
    }));

    console.log(`${tag} Sent connect.challenge with nonce`);

    ws.on('message', (data) => {
      let msg: { type: string; method?: string; params?: any; id?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.log(`${tag} Received non-JSON message`);
        return;
      }

      // Handle connect request
      if (msg.type === 'req' && msg.method === 'connect') {
        console.log(`${tag} Received connect request`);
        ws.send(JSON.stringify({
          type: 'res',
          id: msg.id,
          ok: true,
          payload: { message: 'Connected to ROBIN Gateway v1' },
        }));
        return;
      }

      // Handle other RPC methods - route to HTTP endpoints
      if (msg.type === 'req') {
        handleRpcMethod(msg, ws, tag);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`${tag} Connection closed: code=${code}, reason=${reason?.toString()}`);
    });

    ws.on('error', (err) => {
      console.error(`${tag} WebSocket error:`, err.message);
    });
  });

  console.log(`  WebSocket: ws://127.0.0.1:${port}/ws`);
}

/** Handle RPC methods by routing to HTTP endpoints */
function handleRpcMethod(msg: { type: string; method?: string; params?: any; id?: string }, ws: WebSocket, tag: string): void {
  const method = msg.method || '';
  const id = msg.id || 'unknown';

  // Route common methods to HTTP tools
  const httpUrl = serverConfig.gatewayUrl.replace(/^http/, 'http'); // Already http

  if (method === 'tools.list' || method === 'tool.list') {
    // Return tools list directly (same as /tools GET)
    const tools = [
      { name: 'bash', description: 'Execute bash shell command', args_schema: {} },
      { name: 'powershell', description: 'Execute PowerShell command', args_schema: {} },
      { name: 'files_list', description: 'List files in directory', args_schema: {} },
      { name: 'files_read', description: 'Read text file content', args_schema: {} },
    ];
    ws.send(JSON.stringify({ type: 'res', id, ok: true, payload: { tools } }));
  } else if (method.startsWith('files.') || method.startsWith('tool.')) {
    // Forward to /tools/invoke
    const toolName = method.replace(/^files\./, '').replace(/^tool\./, '');
    fetch(`${httpUrl}/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, args: msg.params || {} }),
    }).then(async (res) => {
      const result = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
      ws.send(JSON.stringify({ type: 'res', id, ok: result.ok ?? false, payload: result.result, error: result.error ? { message: result.error } : undefined }));
    }).catch((err) => {
      ws.send(JSON.stringify({ type: 'res', id, ok: false, error: { message: err.message } }));
    });
  } else {
    // Unknown method - return error
    ws.send(JSON.stringify({ type: 'res', id, ok: false, error: { message: `Unknown method: ${method}` } }));
  }
}

export async function startGatewayServer(port = 18789, host = '127.0.0.1'): Promise<void> {
  if (gatewayStarted) return;
  gatewayStarted = true;
  const app = createGatewayApp();

  console.log(`\n\x1b[36mROBIN Gateway v1\x1b[0m`);
  console.log(`  Listening on: http://${host}:${port}`);
  console.log(`  Config path: ${GATEWAY_CONFIG_PATH}\n`);

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: host,
    },
    (info) => {
      console.log(`\x1b[32m✓ Gateway ready\x1b[0m`);
      console.log(`  HTTP: http://${host}:${info.port}\n`);
      // Start WebSocket server on the same HTTP server
      setupWebSocketServer(server);
    }
  );

  const cleanup = () => {
    console.log('\n[Gateway] Shutting down...');
    if (gatewayWss) {
      gatewayWss.close();
      gatewayWss = null;
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return new Promise((resolve, reject) => {
    server.on('error', (err: Error) => {
      gatewayStarted = false;
      reject(err);
    });
  });
}

const isDirectRun = (() => {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    return path.resolve(entryArg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const port = parseInt(process.env.PORT || '18789', 10);
  const host = process.env.HOST || '127.0.0.1';
  startGatewayServer(port, host).catch((err) => {
    console.error('Failed to start gateway:', err);
    process.exit(1);
  });
}
