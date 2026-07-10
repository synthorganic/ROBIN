/**
 * ROBIN MCP Server — shared transport-agnostic server definition.
 *
 * This is a standards-based MCP surface for ROBIN resources/tools/prompts. It
 * intentionally does not use gateway-v1 chat/session RPC and does not pretend to
 * be OpsApp local agent transport.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MCP_SERVER_NAME = "robin-ops-server";
export const MCP_RESOURCE_URI_PREFIX = "robin://";

export const SRC_ROOT = path.resolve(
  process.env.ROBIN_MCP_SRC_ROOT ??
    process.env.CLAUDE_CODE_SRC_ROOT ??
    path.join(__dirname, "..", "..", "src")
);

async function dirExists(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function fileExists(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .sort();
  } catch { return []; }
}

async function walkFiles(root: string, rel = ""): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch { return results; }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) results.push(...(await walkFiles(root, child)));
    else results.push(child);
  }
  return results;
}

function safePath(relPath: string): string | null {
  const resolved = path.resolve(SRC_ROOT, relPath);
  if (!resolved.startsWith(SRC_ROOT)) return null;
  return resolved;
}

interface ToolInfo {
  name: string;
  directory: string;
  files: string[];
}

async function getToolList(): Promise<ToolInfo[]> {
  const toolsDir = path.join(SRC_ROOT, "tools");
  const entries = await fs.readdir(toolsDir, { withFileTypes: true });
  const tools: ToolInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "shared" || e.name === "testing") continue;
    const files = await listDir(path.join(toolsDir, e.name));
    tools.push({ name: e.name, directory: `tools/${e.name}`, files });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

async function getCommandList(): Promise<ToolInfo[]> {
  const cmdsDir = path.join(SRC_ROOT, "commands");
  const entries = await fs.readdir(cmdsDir, { withFileTypes: true });
  const commands: ToolInfo[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const files = await listDir(path.join(cmdsDir, e.name));
      commands.push({ name: e.name, directory: `commands/${e.name}`, files });
    } else {
      commands.push({ name: e.name.replace(/\.(ts|tsx)$/, ""), directory: `commands/${e.name}`, files: [] });
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function createServer(): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: "1.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: `${MCP_RESOURCE_URI_PREFIX}architecture`,
        name: "ROBIN Architecture Overview",
        description: "High-level overview of ROBIN OpsApp, gateway-v1, and MCP surfaces.",
        mimeType: "text/markdown",
      },
      {
        uri: `${MCP_RESOURCE_URI_PREFIX}tools`,
        name: "Tool Registry",
        description: "List of agent tools with their source files.",
        mimeType: "application/json",
      },
      {
        uri: `${MCP_RESOURCE_URI_PREFIX}commands`,
        name: "Command Registry",
        description: "List of slash commands with their source files.",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${MCP_RESOURCE_URI_PREFIX}source/{path}`,
        name: "Source file",
        description: "Read a source file from the ROBIN src/ directory.",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request: { params: { uri: string } }) => {
    const { uri } = request.params;

    if (uri === `${MCP_RESOURCE_URI_PREFIX}architecture`) {
      let text = "ROBIN Architecture Overview\n\n## Transport contracts\n- OpsApp local agent chat uses /api/agent/session, /api/agent/session/:id/message, and /api/agent/session/:id/stream.\n- gateway-v1 is a legacy/local command/file/tool execution surface; it does not provide ROBIN chat.session RPC.\n- ROBIN MCP Server is an optional standards-based MCP surface exposing resources/tools/prompts only.\n\n## Key files\n- src/features/ops/OpsApp.tsx — Ops dashboard and local agent trace rendering.\n- server/routes/gateway.ts — gateway-v1 configuration/status routes.\n- server/routes/files.ts — safe image file serving route.\n- src/features/chat/operations/loadHistory.ts — chat history filtering/splitting/grouping/tagging pipeline.\n";
      try { text = await fs.readFile(path.resolve(SRC_ROOT, "..", "README.md"), "utf-8"); } catch { /* */ }
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    }

    if (uri === `${MCP_RESOURCE_URI_PREFIX}tools`) {
      const tools = await getToolList();
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(tools, null, 2) }] };
    }

    if (uri === `${MCP_RESOURCE_URI_PREFIX}commands`) {
      const commands = await getCommandList();
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(commands, null, 2) }] };
    }

    if (uri.startsWith(`${MCP_RESOURCE_URI_PREFIX}source/`)) {
      const relPath = uri.slice(`${MCP_RESOURCE_URI_PREFIX}source/`.length);
      const abs = safePath(relPath);
      if (!abs || !(await fileExists(abs))) throw new Error(`File not found: ${relPath}`);
      return { contents: [{ uri, mimeType: "text/plain", text: await fs.readFile(abs, "utf-8") }] };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_tools",
        description: "List all ROBIN agent tools with their source files.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "list_commands",
        description: "List all ROBIN slash commands with their source files.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "get_tool_source",
        description: "Read the full source code of a specific ROBIN agent tool implementation.",
        inputSchema: {
          type: "object" as const,
          properties: { toolName: { type: "string", description: "Tool directory name, e.g. 'BashTool'" }, fileName: { type: "string", description: "Specific file within the tool directory. Omit for the main file." } },
          required: ["toolName"],
        },
      },
      {
        name: "get_command_source",
        description: "Read the source code of a specific ROBIN slash command.",
        inputSchema: {
          type: "object" as const,
          properties: { commandName: { type: "string", description: "Command name, e.g. 'commit', 'review'" }, fileName: { type: "string", description: "Specific file within the command directory. Omit for the main file." } },
          required: ["commandName"],
        },
      },
      {
        name: "read_source_file",
        description: "Read a source file from the ROBIN src/ directory.",
        inputSchema: {
          type: "object" as const,
          properties: { path: { type: "string", description: "Relative path under src/, e.g. 'features/chat/loadHistory.ts'" } },
          required: ["path"],
        },
      },
      {
        name: "search_source",
        description: "Search source files for a regex pattern.",
        inputSchema: {
          type: "object" as const,
          properties: { pattern: { type: "string", description: "Regex to search across src/" }, filePattern: { type: "string", description: "Optional extension filter, e.g. '.ts' or '.tsx'" } },
          required: ["pattern"],
        },
      },
      {
        name: "list_directory",
        description: "List files and subdirectories under a ROBIN src/ directory.",
        inputSchema: {
          type: "object" as const,
          properties: { path: { type: "string", description: "Relative path under src/, e.g. 'features/chat'" } },
          required: ["path"],
        },
      },
      {
        name: "get_architecture",
        description: "Return the ROBIN architecture overview.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const args = request.params.arguments ?? {};

    if (request.params.name === "list_tools") {
      return { content: [{ type: "text", text: JSON.stringify(await getToolList(), null, 2) }] };
    }

    if (request.params.name === "list_commands") {
      return { content: [{ type: "text", text: JSON.stringify(await getCommandList(), null, 2) }] };
    }

    if (request.params.name === "get_tool_source") {
      const toolName = String(args.toolName ?? "");
      if (!toolName) throw new Error("Missing toolName argument");
      const filesDir = path.join(SRC_ROOT, "tools", toolName);
      if (!(await dirExists(filesDir))) throw new Error(`Tool directory not found: ${toolName}`);
      const fileName = String(args.fileName ?? "");
      const abs = safePath(path.join("tools", toolName, fileName));
      if (!abs || !(await fileExists(abs))) throw new Error(`File not found: tools/${toolName}/${fileName}`);
      return { content: [{ type: "text", text: await fs.readFile(abs, "utf-8") }] };
    }

    if (request.params.name === "get_command_source") {
      const commandName = String(args.commandName ?? "");
      if (!commandName) throw new Error("Missing commandName argument");
      const filesDir = path.join(SRC_ROOT, "commands", commandName);
      if (!(await dirExists(filesDir))) throw new Error(`Command directory not found: ${commandName}`);
      const fileName = String(args.fileName ?? "");
      const abs = safePath(path.join("commands", commandName, fileName));
      if (!abs || !(await fileExists(abs))) throw new Error(`File not found: commands/${commandName}/${fileName}`);
      return { content: [{ type: "text", text: await fs.readFile(abs, "utf-8") }] };
    }

    if (request.params.name === "read_source_file") {
      const relPath = String(args.path ?? "");
      if (!relPath) throw new Error("Missing path argument");
      const abs = safePath(relPath);
      if (!abs || !(await fileExists(abs))) throw new Error(`File not found: ${relPath}`);
      return { content: [{ type: "text", text: await fs.readFile(abs, "utf-8") }] };
    }

    if (request.params.name === "search_source") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("Missing pattern argument");
      const filePattern = String(args.filePattern ?? "");
      const files = await walkFiles(SRC_ROOT);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const rel of files) {
        if (filePattern && !rel.endsWith(filePattern)) continue;
        const abs = safePath(rel);
        if (!abs || !(await fileExists(abs))) continue;
        const lines = await fs.readFile(abs, "utf-8").then((text) => text.split(/\r?\n/));
        for (let i = 0; i < lines.length; i++) {
          if (new RegExp(pattern).test(lines[i])) matches.push({ path: rel, line: i + 1, text: lines[i] });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    }

    if (request.params.name === "list_directory") {
      const relPath = String(args.path ?? "");
      if (!relPath) throw new Error("Missing path argument");
      const abs = safePath(relPath);
      if (!abs || !(await dirExists(abs))) throw new Error(`Directory not found: ${relPath}`);
      return { content: [{ type: "text", text: JSON.stringify(await listDir(abs), null, 2) }] };
    }

    if (request.params.name === "get_architecture") {
      let text = "ROBIN Architecture Overview\n\n## Transport contracts\n- OpsApp local agent chat uses /api/agent/session, /api/agent/session/:id/message, and /api/agent/session/:id/stream.\n- gateway-v1 is a legacy/local command/file/tool execution surface; it does not provide ROBIN chat.session RPC.\n- ROBIN MCP Server is an optional standards-based MCP surface exposing resources/tools/prompts only.\n\n## Key files\n- src/features/ops/OpsApp.tsx — Ops dashboard and local agent trace rendering.\n- server/routes/gateway.ts — gateway-v1 configuration/status routes.\n- server/routes/files.ts — safe image file serving route.\n- src/features/chat/operations/loadHistory.ts — chat history filtering/splitting/grouping/tagging pipeline.\n";
      try { text = await fs.readFile(path.resolve(SRC_ROOT, "..", "README.md"), "utf-8"); } catch { /* */ }
      return { content: [{ type: "text", text }] };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "explain_tool",
        description: "Explain a ROBIN agent tool implementation and its source files.",
        inputSchema: { type: "object" as const, properties: { toolName: { type: "string" } }, required: ["toolName"] },
      },
      {
        name: "explain_command",
        description: "Explain a ROBIN slash command implementation and its source files.",
        inputSchema: { type: "object" as const, properties: { commandName: { type: "string" } }, required: ["commandName"] },
      },
      {
        name: "architecture_overview",
        description: "Explain ROBIN transport contracts and MCP/gateway separation.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "how_does_it_work",
        description: "Walk through how a ROBIN feature works from source to UI/runtime behavior.",
        inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "compare_tools",
        description: "Compare ROBIN agent tools by directory and source files.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "ops_analysis_prompt",
        description: "Analyze ROBIN OpsApp architecture for transport separation and operational risks.",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "source_triage_prompt",
        description: "Triage source files for a feature or bug report.",
        inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "incident_summary_prompt",
        description: "Summarize an incident or regression in ROBIN OpsApp terms.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const args = request.params.arguments ?? {};

    if (request.params.name === "explain_tool") {
      const toolName = String(args.toolName ?? "");
      return { prompt: `Explain the ROBIN agent tool ${toolName}. Read its source files under src/tools/${toolName}, summarize responsibilities, entrypoints, dependencies, and any transport boundaries.` };
    }

    if (request.params.name === "explain_command") {
      const commandName = String(args.commandName ?? "");
      return { prompt: `Explain the ROBIN slash command ${commandName}. Read its source files under src/commands/${commandName}, summarize responsibilities, entrypoints, dependencies, and any transport boundaries.` };
    }

    if (request.params.name === "architecture_overview") {
      return { prompt: "Explain ROBIN's transport contracts. Keep OpsApp local agent chat separate from gateway-v1 tool execution and describe the optional standards-based ROBIN MCP Server surface." };
    }

    if (request.params.name === "how_does_it_work") {
      const pathArg = String(args.path ?? "");
      return { prompt: `Walk through how ${pathArg} works in ROBIN. Read the relevant source files, identify runtime behavior, UI rendering, data flow, and edge cases.` };
    }

    if (request.params.name === "compare_tools") {
      return { prompt: "Compare all ROBIN agent tools by directory name, source file list, responsibilities, dependencies, and transport boundaries." };
    }

    if (request.params.name === "ops_analysis_prompt") {
      return { prompt: "Analyze ROBIN OpsApp architecture for local-agent default behavior, gateway-v1 quarantine rules, MCP separation, tool-call rendering, streaming events, and operational risks." };
    }

    if (request.params.name === "source_triage_prompt") {
      const pathArg = String(args.path ?? "");
      return { prompt: `Triage source files for ${pathArg}. Identify the smallest set of files to read first, likely failure points, tests, and related UI/runtime surfaces.` };
    }

    if (request.params.name === "incident_summary_prompt") {
      return { prompt: "Summarize an incident or regression in ROBIN OpsApp terms. Separate chat transport behavior from gateway-v1 tool execution and MCP surface behavior." };
    }

    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  return server;
}

export async function validateSrcRoot(): Promise<void> {
  if (!(await dirExists(SRC_ROOT))) {
    throw new Error(`ROBIN MCP source root not found: ${SRC_ROOT}`);
  }
}
