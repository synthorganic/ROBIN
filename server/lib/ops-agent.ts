import { randomUUID } from 'node:crypto';
import { gatewayRpcCall } from './gateway-rpc.js';
import { broadcast } from '../routes/events.js';
import { lmStudioService, type ChatMessage } from './lmstudio-service.js';
import { opsTerminalManager } from './ops-terminals.js';
import { opsDocumentStore } from './ops-documents.js';
import { buildOpsAgentToolContext } from './ops-agent-tool-catalog.js';
import { config } from './config.js';
import path from 'node:path';

export interface OpsAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt: string;
  reasoning?: string[];
  toolCalls?: OpsAgentToolCall[];
  tool_call_phase?: 'request' | 'result' | 'final';
}

export interface OpsAgentToolCall {
  type: string;
  name: string;
  arguments?: string;
  summary?: string;
}

export interface OpsAgentSessionSnapshot {
  id: string;
  label: string;
  status: string;
  history: OpsAgentMessage[];
  updatedAt: string;
}

interface SessionCacheEntry {
  watching: boolean;
  historyHash: string;
}

export interface OpsAgentSendOptions {
  includeDocuments?: boolean;
  includeToolInstructions?: boolean;
  documentIds?: string[];
  toolNames?: string[];
  transport?: 'gateway' | 'local';
  localModelId?: string;
  localApiBaseUrl?: string;
  localApiKey?: string;
}

const SESSION_LIMIT = 200;
const WATCH_POLL_MS = 900;
const WATCH_TIMEOUT_MS = 45_000;
const MAX_TOOL_ITERATIONS = 15;
const TOP_LEVEL_SESSION_RE = /^agent:[^:]+:main$/;
const LOCAL_SESSION_KEY = 'local:ops:main';
const LOCAL_SYSTEM_PROMPT = [
  'You are ROBIN, an operational analysis agent inside the Inertiai Ops interface.',
  'Use the supplied ROBIN document and tool catalog context when it is relevant.',
  '',
  'TOOL USAGE FORMAT:',
  'When you need to use a tool, write your response in this EXACT format:',
  '',
  '```tool_call',
  'TOOL: <exact_tool_name>',
  'SUMMARY: <short plain-English action summary, 3-8 words>',
  'ARGUMENTS:',
  '{',
  '  "<param1>": "<value1>"',
  '}',
  '```',
  '',
  '⚠️ CRITICAL: Use EXACTLY these tool names (case-sensitive, no abbreviations): ⚠️',
  '- bash          (NOT "shell", "terminal", or "command")',
  '- powershell    (NOT "ps", "pwsh", or "powershell.exe")',
  '- files_list    (NOT "list", "dir", or "ls")',
  '- files_read    (NOT "Read", "read_file", or "file_read")',
  '- files_read_docx (NOT "Read", "docx", or "extract_docx")',
  '- files_info    (NOT "stat" or "metadata")',
  '- memories_get  (NOT "memory" or "get_memories")',
  '',
  'Available tools with parameters:',
  '- bash: Run shell commands. Required: { "command": "your bash command here" }',
  '- powershell: Run PowerShell commands. Required: { "command": "your PowerShell command here" }',
  '- files_list: List directory contents. Optional: { "directory": ".", "pattern": "*.ts" }',
  '- files_read: Read a text file. Required: { "path": "C:/path/to/file.txt" } OR { "file_path": "..." }',
  '- files_read_docx: Extract text from Word docs. Required: { "path": "C:/path/to/file.docx" }. Prefer this for .docx files.',
  '- files_info: Get file metadata. Required: { "path": "C:/path/to/file.txt" }',
  '- memories_get: Retrieve stored memories. Optional: { "path": ".robin/memories" }',
  '',
  'CORRECT EXAMPLE - Reading a DOCX file:',
  '```tool_call',
  'TOOL: files_read_docx',
  'SUMMARY: Read the dispute letter',
  'ARGUMENTS:',
  '{',
  '  "path": "C:/Users/docs/report.docx"',
  '}',
  '```',
  '',
  'CORRECT EXAMPLE - Reading a text file:',
  '```tool_call',
  'TOOL: files_read',
  'SUMMARY: Open the README',
  'ARGUMENTS:',
  '{',
  '  "path": "C:/Users/README.md"',
  '}',
  '```',
  '',
  'CORRECT EXAMPLE - Running a bash command:',
  '```tool_call',
  'TOOL: bash',
  'SUMMARY: List the current folder',
  'ARGUMENTS:',
  '{',
  '  "command": "ls -la"',
  '}',
  '```',
  '',
  'WRONG EXAMPLE (DO NOT DO THIS):',
  '```tool_call',
  'TOOL: Read          ❌ WRONG! Use "files_read" instead',
  'SUMMARY: Read a file',
  'ARGUMENTS:',
  '{',
  '  "path": "..."',
  '}',
  '```',
  '',
  'Do not emit XML-style tool tags such as <tool_call>. Use the fenced format above only.',
  'Do not put descriptions inside ARGUMENTS. Put the short action summary on the SUMMARY line.',
  'IMPORTANT: Always use the exact tool names listed above. Do NOT abbreviate or modify them.',
].join('\n');

interface ParsedTextToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  summary?: string;
}

const TOOL_CALL_BLOCK_REGEX = /```tool_call\s*\r?\n([\s\S]*?)```/gi;
const TOOL_CALL_XML_BLOCK_REGEX = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;

function normalizeToolCallSummary(value: string | undefined) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function parseJsonToolArguments(rawArgs: string, summary?: string) {
  const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
  const next = { ...parsed };
  let resolvedSummary = normalizeToolCallSummary(summary);

  if (!resolvedSummary && typeof next.description === 'string') {
    resolvedSummary = normalizeToolCallSummary(next.description);
  }
  if ('description' in next) delete next.description;

  return {
    arguments: JSON.stringify(next, null, 2),
    summary: resolvedSummary,
  };
}

function parseFencedToolCalls(content: string): ParsedTextToolCall[] {
  const parsedCalls: ParsedTextToolCall[] = [];

  for (const match of content.matchAll(TOOL_CALL_BLOCK_REGEX)) {
    const block = match[1] ?? '';
    const toolName = block.match(/^\s*TOOL:\s*(.+?)\s*$/im)?.[1]?.trim();
    if (!toolName) continue;

    const summary = normalizeToolCallSummary(block.match(/^\s*SUMMARY:\s*(.+?)\s*$/im)?.[1]);
    const argsStart = block.search(/^\s*ARGUMENTS:\s*$/im);
    if (argsStart === -1) continue;

    const argsMatch = block.slice(argsStart).match(/^\s*ARGUMENTS:\s*[\r\n]+([\s\S]*?)\s*$/i);
    if (!argsMatch?.[1]) continue;

    try {
      const parsedArgs = parseJsonToolArguments(argsMatch[1].trim(), summary);
      parsedCalls.push({
        id: `tool-${randomUUID().slice(0, 8)}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: parsedArgs.arguments,
        },
        summary: parsedArgs.summary,
      });
    } catch (error) {
      console.error('[ops-agent] Failed to parse fenced tool arguments:', error);
    }
  }

  return parsedCalls;
}

function parseXmlToolCalls(content: string): ParsedTextToolCall[] {
  const parsedCalls: ParsedTextToolCall[] = [];

  for (const match of content.matchAll(TOOL_CALL_XML_BLOCK_REGEX)) {
    const block = match[1] ?? '';
    const toolName = block.match(/<function>\s*([^<]+?)\s*<\/function>/i)?.[1]?.trim();
    if (!toolName) continue;

    const args: Record<string, string> = {};
    let summary = normalizeToolCallSummary(block.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1]);

    for (const paramMatch of block.matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
      const key = paramMatch[1]?.trim();
      const value = paramMatch[2]?.trim();
      if (!key || !value) continue;
      if (key === 'description' && !summary) {
        summary = normalizeToolCallSummary(value);
        continue;
      }
      args[key] = value;
    }

    parsedCalls.push({
      id: `tool-${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(args, null, 2),
      },
      summary,
    });
  }

  return parsedCalls;
}

function parseTextToolCalls(content: string) {
  return [...parseFencedToolCalls(content), ...parseXmlToolCalls(content)];
}

function isStandaloneJsonSnippet(value: string) {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed != null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function isToolMarkupOnly(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (isStandaloneJsonSnippet(trimmed)) return true;
  if (/^(TOOL:\s*.+|SUMMARY:\s*.+|ARGUMENTS:\s*|```tool_call|```|<tool_call>|<\/tool_call>)$/im.test(trimmed)) {
    return trimmed.split(/\r?\n/).every((line) => {
      const part = line.trim();
      return !part
        || /^TOOL:\s*.+$/i.test(part)
        || /^SUMMARY:\s*.+$/i.test(part)
        || /^ARGUMENTS:\s*$/i.test(part)
        || part === '```tool_call'
        || part === '```'
        || part === '<tool_call>'
        || part === '</tool_call>';
    });
  }
  return false;
}

function stripToolCallBlocks(rawText: string) {
  if (!rawText) return '';

  let sanitized = rawText
    .replace(/```tool_call[\s\S]*?```/gi, '')
    .replace(/```tool_call[\s\S]*$/i, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call>[\s\S]*$/i, '')
    .trim();

  if (isToolMarkupOnly(sanitized)) {
    sanitized = '';
  }

  return sanitized;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRole(raw: unknown): OpsAgentMessage['role'] {
  if (raw === 'assistant' || raw === 'tool' || raw === 'system') return raw;
  return 'user';
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => flattenContent(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    const direct = [
      record.text,
      record.content,
      record.arguments,
      record.name,
      record.input ? JSON.stringify(record.input, null, 2) : '',
    ]
      .map((item) => flattenContent(item))
      .filter(Boolean)
      .join('\n')
      .trim();
    return direct;
  }
  if (content == null) return '';
  return String(content).trim();
}

function stringifyArguments(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseContent(content: unknown): Pick<OpsAgentMessage, 'text' | 'reasoning' | 'toolCalls'> {
  if (!Array.isArray(content)) {
    return { text: flattenContent(content) };
  }

  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: OpsAgentToolCall[] = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      const value = flattenContent(item);
      if (value) text.push(value);
      continue;
    }

    const block = item as Record<string, unknown>;
    const type = String(block.type ?? '');
    if (type === 'thinking') {
      const value = flattenContent(block.thinking ?? block.text ?? block.content ?? '');
      if (value) reasoning.push(value);
      continue;
    }

    if (type === 'tool_use' || type === 'toolCall') {
      toolCalls.push({
        type: type || 'tool',
        name: String(block.name ?? 'tool'),
        arguments: stringifyArguments(block.input ?? block.arguments),
        summary: normalizeToolCallSummary(typeof block.summary === 'string' ? block.summary : undefined),
      });
      continue;
    }

    const value = flattenContent(block.text ?? block.content ?? block);
    if (value) text.push(value);
  }

  return {
    text: text.join('\n').trim(),
    reasoning: reasoning.length ? Array.from(new Set(reasoning)) : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function messageTimestamp(raw: Record<string, unknown>) {
  const stamp = raw.createdAt ?? raw.timestamp ?? raw.ts;
  if (typeof stamp === 'string') return stamp;
  if (typeof stamp === 'number') return new Date(stamp).toISOString();
  return new Date().toISOString();
}

function hashHistory(history: OpsAgentMessage[]) {
  return JSON.stringify(history.map((message) => ({
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    reasoning: message.reasoning ?? [],
    toolCalls: (message.toolCalls ?? []).map((toolCall) => ({
      type: toolCall.type,
      name: toolCall.name,
      arguments: toolCall.arguments ?? '',
      summary: toolCall.summary ?? '',
    })),
    toolCallPhase: message.tool_call_phase ?? null,
  })));
}

class OpsAgentService {
  private readonly cache = new Map<string, SessionCacheEntry>();
  private readonly localHistory = new Map<string, OpsAgentMessage[]>();

  async ensureSession(sessionKey?: string, options?: Pick<OpsAgentSendOptions, 'transport'>): Promise<OpsAgentSessionSnapshot> {
    if (options?.transport === 'local' || sessionKey?.startsWith('local:')) {
      return this.ensureLocalSession(sessionKey);
    }
    const sessions = await this.listSessions();
    const resolvedKey = sessionKey?.trim() || this.pickSessionKey(sessions);
    const history = await this.getHistory(resolvedKey);
    return this.snapshotFromSessions(resolvedKey, sessions, history);
  }

  async getSession(sessionKey: string): Promise<OpsAgentSessionSnapshot> {
    if (sessionKey.startsWith('local:')) return this.ensureLocalSession(sessionKey);
    const sessions = await this.listSessions();
    const history = await this.getHistory(sessionKey);
    return this.snapshotFromSessions(sessionKey, sessions, history);
  }

  async getHistory(sessionKey: string): Promise<OpsAgentMessage[]> {
    if (sessionKey.startsWith('local:')) {
      return this.localHistory.get(sessionKey) ?? [];
    }

    const response = await gatewayRpcCall('chat.history', { sessionKey, limit: 120 }) as {
      messages?: unknown[];
    };
    const history = (response.messages ?? [])
      .map((raw, index) => {
        const message = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const parsed = parseContent(message.content ?? message.text ?? '');
        return {
          id: String(message.id ?? `${index}-${randomUUID().slice(0, 6)}`),
          role: normalizeRole(message.role),
          text: parsed.text,
          createdAt: messageTimestamp(message),
          ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
          ...(parsed.toolCalls ? { toolCalls: parsed.toolCalls } : {}),
        } satisfies OpsAgentMessage;
      })
      .filter((message) => message.text || message.reasoning?.length || message.toolCalls?.length);

    this.cache.set(sessionKey, {
      watching: this.cache.get(sessionKey)?.watching ?? false,
      historyHash: hashHistory(history),
    });
    return history;
  }

  async sendMessage(sessionKey: string, text: string, options?: OpsAgentSendOptions): Promise<OpsAgentSessionSnapshot> {
    if (options?.transport === 'local' || sessionKey.startsWith('local:')) {
      return this.sendLocalMessage(sessionKey || LOCAL_SESSION_KEY, text, options);
    }

    const historyBefore = await this.getHistory(sessionKey);
    const message = await this.augmentMessage(text, options);
    await gatewayRpcCall('chat.send', {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: `inertiai-ops-${randomUUID()}`,
    });

    opsTerminalManager.appendLog(`[agent] ${sessionKey} <- ${text.slice(0, 160)}`);
    broadcast('ops.agent.status', { sessionKey, status: 'submitted', ts: Date.now() });
    void this.watchForUpdates(sessionKey, historyBefore);

    return this.getSession(sessionKey);
  }

  async abort(sessionKey: string) {
    if (sessionKey.startsWith('local:')) {
      broadcast('ops.agent.status', { sessionKey, status: 'idle', ts: Date.now() });
      return;
    }

    await gatewayRpcCall('chat.abort', { sessionKey });
    opsTerminalManager.appendLog(`[agent] aborted ${sessionKey}`);
    broadcast('ops.agent.status', { sessionKey, status: 'aborted', ts: Date.now() });
  }

  private ensureLocalSession(sessionKey?: string): OpsAgentSessionSnapshot {
    const resolvedKey = sessionKey?.trim() || LOCAL_SESSION_KEY;
    if (!this.localHistory.has(resolvedKey)) this.localHistory.set(resolvedKey, []);
    return this.snapshotFromLocal(resolvedKey);
  }

  private async sendLocalMessage(sessionKey: string, text: string, options?: OpsAgentSendOptions): Promise<OpsAgentSessionSnapshot> {
    const resolvedKey = sessionKey.startsWith('local:') ? sessionKey : LOCAL_SESSION_KEY;
    const currentHistory = this.localHistory.get(resolvedKey) ?? [];
    const userMessage: OpsAgentMessage = {
      id: `local-user-${randomUUID().slice(0, 10)}`,
      role: 'user',
      text,
      createdAt: new Date().toISOString(),
    };
    const conversationHistory = [...currentHistory, userMessage];
    this.localHistory.set(resolvedKey, conversationHistory);
    broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });
    broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'thinking', ts: Date.now() });

    const augmentedMessage = await this.augmentMessage(text, options);
    let messages = this.localMessagesForCompletion(conversationHistory, augmentedMessage);

    // Build structured tool definitions for the LLM API
    const tools = this.buildLocalTools();

    // Tool execution loop: keep calling the model until it stops requesting tools
    let iteration = 0;
    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      // Get initial assistant message - first broadcast user's message
      const assistantMsgId = `local-assistant-${randomUUID().slice(0, 10)}`;
      const assistantMsg: OpsAgentMessage = {
        id: assistantMsgId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        // tool_call_phase: 'thinking' is invalid, use undefined to indicate placeholder
      };
      conversationHistory.push(assistantMsg);
      this.localHistory.set(resolvedKey, conversationHistory);
      broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });

      // Track content as it streams in
      let streamedContent = '';
      const assistantMessageId = assistantMsgId;
      let announcedStreaming = false;

      const completion = await lmStudioService.createChatCompletion({
        messages,
        modelId: options?.localModelId,
        baseUrl: options?.localApiBaseUrl,
        apiKey: options?.localApiKey,
        temperature: 0.2,
        stream: true, // Enable streaming for real-time token delivery
        tools, // Always send tools for multi-turn tool calling
        onChunk: (content) => {
          if (!announcedStreaming) {
            announcedStreaming = true;
            broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'streaming', ts: Date.now() });
          }
          streamedContent += content;
          // Update the assistant message with current streamed text
          const msgIdx = conversationHistory.findIndex(m => m.id === assistantMessageId);
          if (msgIdx !== -1) {
            conversationHistory[msgIdx].text = stripToolCallBlocks(streamedContent);
            this.localHistory.set(resolvedKey, conversationHistory);
            broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });
          }
        },
      });

      const choice = completion.choices[0]?.message;

      // Try to parse tool calls from text-based format first
      let rawToolCalls: ParsedTextToolCall[] = [];
      const contentText = (choice?.content || streamedContent) || '';

      rawToolCalls = parseTextToolCalls(contentText);

      // Fallback to native tool_calls if text parsing found nothing
      if (rawToolCalls.length === 0 && choice?.tool_calls) {
        rawToolCalls = choice.tool_calls.map((call) => ({
          id: call.id || `tool-${randomUUID().slice(0, 8)}`,
          type: call.type || 'function',
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        }));
      }

      // Remove the placeholder message if it exists (we've been streaming to it)
      const msgIdx = conversationHistory.findIndex(m => m.id === assistantMessageId);
      if (msgIdx !== -1) {
        // Preserve streamed content - only update if no tools were called
        // When tools are called, the model may not have produced final text
        if (!rawToolCalls || rawToolCalls.length === 0) {
          conversationHistory[msgIdx].text = stripToolCallBlocks((choice?.content || '').trim() || streamedContent);
        } else {
          conversationHistory[msgIdx].text = stripToolCallBlocks(streamedContent || (choice?.content || '').trim());
        }
      }

      if (!rawToolCalls || rawToolCalls.length === 0) {
        // No more tool calls — this is the final answer
        this.localHistory.set(resolvedKey, conversationHistory);
        opsTerminalManager.appendLog(`[agent:local] ${resolvedKey} <- ${text.slice(0, 160)}`);
        broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });
        broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'idle', ts: Date.now() });
        return this.snapshotFromLocal(resolvedKey);
      }

      // Model wants to call tools — preserve raw tool calls with ids for proper tool_call_id matching
      const rawToolCallsWithIds = rawToolCalls.map((call) => ({
        id: call.id,
        type: call.type || 'tool_call',
        name: call.function.name,
        arguments: call.function.arguments,
        summary: call.summary,
      }));

      // Update the assistant message with tool calls
      const assistantMessageIdx = conversationHistory.findIndex(m => m.id === assistantMessageId);
      if (assistantMessageIdx !== -1) {
        conversationHistory[assistantMessageIdx].toolCalls = rawToolCallsWithIds;
        conversationHistory[assistantMessageIdx].tool_call_phase = 'request';
        conversationHistory[assistantMessageIdx].text = stripToolCallBlocks(streamedContent || (choice?.content || '').trim());
      }
      // Broadcast updated history with tool calls so UI updates
      this.localHistory.set(resolvedKey, conversationHistory);
      broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });

      // Don't broadcast intermediate tool calls as full replies - broadcast status only
      broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'tool_use', ts: Date.now() });

      // Execute each tool call and collect results
      const toolResults = await Promise.all(
        rawToolCallsWithIds.map(async (tc) => {
          try {
            const result = await this.executeToolCall(tc.name, tc.arguments);
            const toolMessage: OpsAgentMessage = {
              id: `local-tool-${randomUUID().slice(0, 10)}`,
              role: 'tool',
              text: result,
              createdAt: new Date().toISOString(),
              toolCalls: [{
                type: tc.type || 'tool_call',
                name: tc.name,
                arguments: tc.arguments,
                summary: tc.summary,
              }],
              tool_call_phase: 'result',
            };
            conversationHistory.push(toolMessage);
            this.localHistory.set(resolvedKey, conversationHistory);
            broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });
            return { id: tc.id, name: tc.name, output: result };
          } catch (err) {
            const output = `Error executing ${tc.name}: ${(err as Error).message}`;
            const toolMessage: OpsAgentMessage = {
              id: `local-tool-${randomUUID().slice(0, 10)}`,
              role: 'tool',
              text: output,
              createdAt: new Date().toISOString(),
              toolCalls: [{
                type: tc.type || 'tool_call',
                name: tc.name,
                arguments: tc.arguments,
                summary: tc.summary,
              }],
              tool_call_phase: 'result',
            };
            conversationHistory.push(toolMessage);
            this.localHistory.set(resolvedKey, conversationHistory);
            broadcast('ops.agent.history', { sessionKey: resolvedKey, history: conversationHistory, ts: Date.now() });
            return { id: tc.id, name: tc.name, output };
          }
        }),
      );

      // Add tool results back to the conversation for the next iteration
      // tool_call_id must match the original tool_call.id from the assistant message
      const toolResultMessages = toolResults.map((result) => ({
        role: 'tool' as const,
        content: result.output,
        name: result.name,
        tool_call_id: result.id,
      }));

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: choice?.content ?? null,
          tool_calls: rawToolCalls,
        },
        ...toolResultMessages,
      ];
    }

    // If we hit max iterations, return what we have
    opsTerminalManager.appendLog(`[agent:local] ${resolvedKey} <- ${text.slice(0, 160)} (hit max tool iterations)`);
    broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'idle', ts: Date.now() });
    return this.snapshotFromLocal(resolvedKey);
  }

  /** Build structured tool definitions for the LLM API (OpenAI-compatible format). */
  private buildLocalTools(): Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    // For models with weak native tool calling, we'll use text-based parsing
    // This returns an empty array to disable automatic tool passing
    return [];
  }

  /** Execute a single tool call via the gateway-v1 /tools/invoke endpoint. */
  private async executeToolCall(name: string, argsJson?: string): Promise<string> {
    const args = argsJson ? (() => { try { return JSON.parse(argsJson); } catch { return {}; } })() : {};

    // Use gateway-v1 /tools/invoke endpoint for local tool execution
    const gatewayUrl = config.gatewayUrl || 'http://127.0.0.1:18789';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.gatewayToken) headers['Authorization'] = `Bearer ${config.gatewayToken}`;

    // Pass document directory to gateway for file access
    const documentDir = path.join(config.home, '.robin', 'inertiai-ops', 'documents');
    const toolArgs = { ...args, documentDir };

    opsTerminalManager.appendLog(`[agent:local] executing tool: ${name} with args: ${JSON.stringify(toolArgs).slice(0, 200)}`);

    const response = await fetch(`${gatewayUrl}/tools/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tool: name, args: toolArgs }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Tool ${name} failed: HTTP ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
    if (!result.ok) {
      throw new Error(result.error || `Tool ${name} returned ok=false`);
    }

    // Extract output from the result
    const toolResult = result.result as Record<string, unknown> | undefined;
    if (toolResult && typeof toolResult === 'object') {
      if ('success' in toolResult && toolResult.success === false) {
        return typeof toolResult.error === 'string' && toolResult.error.trim()
          ? toolResult.error
          : `Tool ${name} failed`;
      }
      if ('output' in toolResult && typeof toolResult.output === 'string') return toolResult.output;
      if ('content' in toolResult) return String(toolResult.content || '');
      if ('files' in toolResult && Array.isArray(toolResult.files)) return JSON.stringify(toolResult.files, null, 2);
    }

    // Fallback: stringify the entire result
    return typeof result.result === 'string'
      ? result.result as string
      : JSON.stringify(result.result, null, 2);
  }

  private localMessagesForCompletion(history: OpsAgentMessage[], augmentedLatestMessage: string): ChatMessage[] {
    const recent = history.slice(-18);
    const messages: ChatMessage[] = [
      { role: 'system', content: LOCAL_SYSTEM_PROMPT },
      ...recent.map((message, index): ChatMessage => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: index === recent.length - 1 && message.role === 'user'
          ? augmentedLatestMessage
          : message.text,
      })),
    ];
    return messages.filter((message) => (message.content as string)?.trim());
  }

  private async listSessions(): Promise<Record<string, unknown>[]> {
    // ROBIN doesn't use gateway RPC for session management
    // All sessions are managed locally via opsApi
    return [];
  }

  private async augmentMessage(text: string, options?: OpsAgentSendOptions) {
    const contextBlocks: string[] = [];
    if (options?.includeDocuments !== false) {
      contextBlocks.push(await opsDocumentStore.agentContext(options?.documentIds));
    }
    if (options?.includeToolInstructions !== false) {
      contextBlocks.push(await buildOpsAgentToolContext(options?.toolNames));
    }
    const context = contextBlocks.filter(Boolean).join('\n\n');
    if (!context.trim()) return text;

    return [
      '<robin_context>',
      context,
      '</robin_context>',
      '',
      text,
    ].join('\n');
  }

  private pickSessionKey(sessions: Record<string, unknown>[]) {
    const explicitMain = sessions.find((session) => String(session.sessionKey ?? session.key ?? '') === 'agent:main:main');
    if (explicitMain) return 'agent:main:main';

    const topLevel = sessions.find((session) => TOP_LEVEL_SESSION_RE.test(String(session.sessionKey ?? session.key ?? '')));
    if (topLevel) return String(topLevel.sessionKey ?? topLevel.key);

    return 'agent:main:main';
  }

  private snapshotFromSessions(
    sessionKey: string,
    sessions: Record<string, unknown>[],
    history: OpsAgentMessage[],
  ): OpsAgentSessionSnapshot {
    const session = sessions.find((item) => String(item.sessionKey ?? item.key ?? '') === sessionKey);
    const label = String(session?.label ?? session?.displayName ?? 'Central Agent');
    const status = String(session?.agentState ?? session?.state ?? 'IDLE');

    return {
      id: sessionKey,
      label,
      status,
      history,
      updatedAt: new Date().toISOString(),
    };
  }

  private snapshotFromLocal(sessionKey: string): OpsAgentSessionSnapshot {
    const history = this.localHistory.get(sessionKey) ?? [];
    return {
      id: sessionKey,
      label: 'Local API',
      status: 'LOCAL',
      history,
      updatedAt: new Date().toISOString(),
    };
  }

  private async watchForUpdates(sessionKey: string, historyBefore: OpsAgentMessage[]) {
    const entry = this.cache.get(sessionKey);
    if (entry?.watching) return;

    this.cache.set(sessionKey, {
      watching: true,
      historyHash: hashHistory(historyBefore),
    });

    const startedAt = Date.now();
    let stablePolls = 0;
    let previousHash = hashHistory(historyBefore);

    while (Date.now() - startedAt < WATCH_TIMEOUT_MS) {
      await wait(WATCH_POLL_MS);
      const history = await this.getHistory(sessionKey).catch(() => null);
      if (!history) continue;

      const nextHash = hashHistory(history);
      if (nextHash !== previousHash) {
        previousHash = nextHash;
        stablePolls = 0;
        broadcast('ops.agent.history', {
          sessionKey,
          history,
          ts: Date.now(),
        });
        continue;
      }

      stablePolls += 1;
      const last = history.at(-1);
      if (history.length > historyBefore.length && last?.role === 'assistant' && stablePolls >= 2) {
        break;
      }
    }

    this.cache.set(sessionKey, {
      watching: false,
      historyHash: previousHash,
    });
    broadcast('ops.agent.status', { sessionKey, status: 'idle', ts: Date.now() });
  }
}

export const opsAgentService = new OpsAgentService();
