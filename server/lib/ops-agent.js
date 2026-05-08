import { randomUUID } from 'node:crypto';
import { gatewayRpcCall } from './gateway-rpc.js';
import { broadcast } from '../routes/events.js';
import { opsTerminalManager } from './ops-terminals.js';
const SESSION_LIMIT = 200;
const WATCH_POLL_MS = 900;
const WATCH_TIMEOUT_MS = 45_000;
const TOP_LEVEL_SESSION_RE = /^agent:[^:]+:main$/;
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeRole(raw) {
    if (raw === 'assistant' || raw === 'tool' || raw === 'system')
        return raw;
    return 'user';
}
function flattenContent(content) {
    if (typeof content === 'string')
        return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((item) => flattenContent(item))
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (content && typeof content === 'object') {
        const record = content;
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
    if (content == null)
        return '';
    return String(content).trim();
}
function messageTimestamp(raw) {
    const stamp = raw.createdAt ?? raw.timestamp ?? raw.ts;
    if (typeof stamp === 'string')
        return stamp;
    if (typeof stamp === 'number')
        return new Date(stamp).toISOString();
    return new Date().toISOString();
}
function hashHistory(history) {
    return JSON.stringify(history.map((message) => [message.role, message.text, message.createdAt]));
}
class OpsAgentService {
    cache = new Map();
    async ensureSession(sessionKey) {
        const sessions = await this.listSessions();
        const resolvedKey = sessionKey?.trim() || this.pickSessionKey(sessions);
        const history = await this.getHistory(resolvedKey);
        return this.snapshotFromSessions(resolvedKey, sessions, history);
    }
    async getSession(sessionKey) {
        const sessions = await this.listSessions();
        const history = await this.getHistory(sessionKey);
        return this.snapshotFromSessions(sessionKey, sessions, history);
    }
    async getHistory(sessionKey) {
        const response = await gatewayRpcCall('chat.history', { sessionKey, limit: 120 });
        const history = (response.messages ?? [])
            .map((raw, index) => {
            const message = raw && typeof raw === 'object' ? raw : {};
            return {
                id: String(message.id ?? `${index}-${randomUUID().slice(0, 6)}`),
                role: normalizeRole(message.role),
                text: flattenContent(message.content ?? message.text ?? ''),
                createdAt: messageTimestamp(message),
            };
        })
            .filter((message) => message.text);
        this.cache.set(sessionKey, {
            watching: this.cache.get(sessionKey)?.watching ?? false,
            historyHash: hashHistory(history),
        });
        return history;
    }
    async sendMessage(sessionKey, text) {
        const historyBefore = await this.getHistory(sessionKey);
        await gatewayRpcCall('chat.send', {
            sessionKey,
            message: text,
            deliver: false,
            idempotencyKey: `inertiai-ops-${randomUUID()}`,
        });
        opsTerminalManager.appendLog(`[agent] ${sessionKey} <- ${text.slice(0, 160)}`);
        broadcast('ops.agent.status', { sessionKey, status: 'submitted', ts: Date.now() });
        void this.watchForUpdates(sessionKey, historyBefore);
        return this.getSession(sessionKey);
    }
    async abort(sessionKey) {
        await gatewayRpcCall('chat.abort', { sessionKey });
        opsTerminalManager.appendLog(`[agent] aborted ${sessionKey}`);
        broadcast('ops.agent.status', { sessionKey, status: 'aborted', ts: Date.now() });
    }
    async listSessions() {
        const response = await gatewayRpcCall('sessions.list', {
            activeMinutes: 24 * 60,
            limit: SESSION_LIMIT,
        });
        return response.sessions ?? [];
    }
    pickSessionKey(sessions) {
        const explicitMain = sessions.find((session) => String(session.sessionKey ?? session.key ?? '') === 'agent:main:main');
        if (explicitMain)
            return 'agent:main:main';
        const topLevel = sessions.find((session) => TOP_LEVEL_SESSION_RE.test(String(session.sessionKey ?? session.key ?? '')));
        if (topLevel)
            return String(topLevel.sessionKey ?? topLevel.key);
        return 'agent:main:main';
    }
    snapshotFromSessions(sessionKey, sessions, history) {
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
    async watchForUpdates(sessionKey, historyBefore) {
        const entry = this.cache.get(sessionKey);
        if (entry?.watching)
            return;
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
            if (!history)
                continue;
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
