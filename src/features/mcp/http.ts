#!/usr/bin/env node
/**
 * ROBIN MCP HTTP/SSE entrypoint � streamable transport and legacy SSE routes.
 *
 * Usage:
 *   node dist/http.js
 *   ROBIN_MCP_PORT=3001 node dist/http.js
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  MCP_SERVER_NAME,
  createServer,
  validateSrcRoot,
  SRC_ROOT,
} from "./server.js";

const PORT = parseInt(
  process.env.ROBIN_MCP_PORT ?? process.env.PORT ?? "3001",
  10,
);
const API_KEY =
  process.env.ROBIN_MCP_API_KEY ?? process.env.MCP_API_KEY;

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next();
  const headerKey = process.env.ROBIN_MCP_AUTH_HEADER ?? "x-robin-mcp-api-key";
  const supplied = req.header(headerKey);
  if (supplied !== API_KEY) {
    res.status(401).json({ error: "Unauthorized MCP request" });
    return;
  }
  next();
}

async function main() {
  await validateSrcRoot();

  const app = express();
  app.use(express.json());
  if (API_KEY) app.use(authMiddleware);

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      const server = createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await server.connect(transport);

      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
    }

    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId && !transports.has(transport.sessionId)) {
      transports.set(transport.sessionId, transport);
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.close();
      transports.delete(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  // Legacy SSE endpoint - now uses StreamableHTTP for all communication
  app.get("/sse", async (req, res) => {
    res.status(501).json({ error: "SSE transport is deprecated. Use /mcp with Streamable HTTP." });
  });

  app.get("/messages/:id", async (req, res) => {
    const sessionId = req.params.id;
    if (!transports.has(sessionId)) {
      res.status(404).json({ error: "Unknown MCP session" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, server: MCP_SERVER_NAME, srcRoot: SRC_ROOT });
  });

  const listener = app.listen(PORT, () => {
    console.error(`ROBIN MCP (HTTP/SSE) started � port: ${PORT} � src: ${SRC_ROOT}`);
  });

  process.on("SIGTERM", () => {
    listener.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
