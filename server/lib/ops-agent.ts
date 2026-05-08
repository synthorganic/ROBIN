import { randomUUID } from 'node:crypto';
import { gatewayRpcCall } from './gateway-rpc.js';
import { broadcast } from '../routes/events.js';
import { opsTerminalManager } from './ops-terminals.js';
import { opsDocumentStore } from './ops-documents.js';
import { buildOpsAgentToolContext } from './ops-agent-tool-catalog.js';
import { lmStudioService, type ChatMessage } from './lmstudio-service.js';

export interface OpsAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt: string;
  reasoning?: string[];
  toolCalls?: OpsAgentToolCall[];
}

export interface OpsAgentToolCall {
  type: string;
  name: string;
  arguments?: string;
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
const TOP_LEVEL_SESSION_RE = /^agent:[^:]+:main$/;
const LOCAL_SESSION_KEY = 'local:ops:main';
const LOCAL_SYSTEM_PROMPT = [
  'You are ROBIN, an operational analysis agent inside the Inertiai Ops interface.',
  'Use the supplied ROBIN document and tool catalog context when it is relevant.',
  'If a mapped tool is needed, name the exact tool and arguments you would use. Local API mode cannot execute external tools by itself.',
].join(' ');

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
  return JSON.stringify(history.map((message) => [message.role, message.text, message.createdAt]));
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
    const withUser = [...currentHistory, userMessage];
    this.localHistory.set(resolvedKey, withUser);
    broadcast('ops.agent.history', { sessionKey: resolvedKey, history: withUser, ts: Date.now() });
    broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'thinking', ts: Date.now() });

    const augmentedMessage = await this.augmentMessage(text, options);
    const messages = this.localMessagesForCompletion(withUser, augmentedMessage);
    const completion = await lmStudioService.createChatCompletion({
      messages,
      modelId: options?.localModelId,
      baseUrl: options?.localApiBaseUrl,
      apiKey: options?.localApiKey,
      temperature: 0.2,
    });
    const choice = completion.choices[0]?.message;
    const toolCalls = choice?.tool_calls?.map((call) => ({
      type: call.type || 'tool_call',
      name: call.function.name,
      arguments: call.function.arguments,
    }));
    const assistantMessage: OpsAgentMessage = {
      id: `local-assistant-${randomUUID().slice(0, 10)}`,
      role: 'assistant',
      text: choice?.content?.trim() || (toolCalls?.length ? 'Tool call requested.' : ''),
      createdAt: new Date().toISOString(),
      ...(choice?.reasoning_content ? { reasoning: [choice.reasoning_content] } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    };
    const nextHistory = [...withUser, assistantMessage];
    this.localHistory.set(resolvedKey, nextHistory);
    opsTerminalManager.appendLog(`[agent:local] ${resolvedKey} <- ${text.slice(0, 160)}`);
    broadcast('ops.agent.history', { sessionKey: resolvedKey, history: nextHistory, ts: Date.now() });
    broadcast('ops.agent.status', { sessionKey: resolvedKey, status: 'idle', ts: Date.now() });
    return this.snapshotFromLocal(resolvedKey);
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
    return messages.filter((message) => message.content.trim());
  }

  private async listSessions(): Promise<Record<string, unknown>[]> {
    const response = await gatewayRpcCall('sessions.list', {
      activeMinutes: 24 * 60,
      limit: SESSION_LIMIT,
    }) as {
      sessions?: Record<string, unknown>[];
    };
    return response.sessions ?? [];
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
    return {
      id: sessionKey,
      label: 'Local API',
      status: 'LOCAL',
      history: this.localHistory.get(sessionKey) ?? [],
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
