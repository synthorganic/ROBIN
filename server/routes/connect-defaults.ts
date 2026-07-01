/**
 * GET /api/connect-defaults — Provides gateway connection defaults for the browser.
 *
 * The ConnectDialog in the frontend needs the WebSocket URL and auth token.
 * Instead of requiring users to enter these manually in the browser,
 * this endpoint exposes the server's configured gateway URL and token
 * so the frontend can pre-fill (or auto-connect).
 *
 * Security: The token field is always null; token injection is handled server-side
 * by the WebSocket proxy for trusted clients (authenticated sessions or loopback).
 */

import { Hono } from 'hono';
import { config } from '../lib/config.js';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { canInjectGatewayToken } from '../lib/trust-utils.js';
import { getConnInfo } from '@hono/node-server/conninfo';

const app = new Hono();

app.get('/api/connect-defaults', rateLimitGeneral, (c) => {
  // The gateway URL without /ws endpoint - the frontend's useWebSocket
  // will prepend /ws and add ?target= to connect through the proxy.
  // This works because: frontend(ws://localhost:3080/ws?target=http://127.0.0.1:18789)
  // -> proxy parses target and connects to ws://127.0.0.1:18789
  const wsUrl = config.gatewayUrl.replace(/^http/, 'ws');

  // Get client IP for trust detection
  let remoteAddress: string | undefined;
  try {
    const info = getConnInfo(c);
    remoteAddress = info.remote.address;
  } catch {
    // getConnInfo may fail in test environments
  }

  return c.json({
    wsUrl,
    token: null, // Token injection handled server-side by ws-proxy.ts
    agentName: config.agentName,
    authEnabled: config.auth,
    serverSideAuth: canInjectGatewayToken({
      socket: { remoteAddress },
      headers: c.req.header(),
    }),
  });
});

export default app;
