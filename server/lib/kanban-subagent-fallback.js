/**
 * Server-side Kanban subagent launch helper.
 *
 * Kanban tasks should run as real child sessions under an existing top-level
 * agent root, not as synthetic message conventions that hope the parent will
 * spawn on our behalf.
 *
 * Historical note: the surrounding route code still uses the word “fallback”
 * because assigned-root execution originally existed as a macOS-specific
 * workaround. The transport here is now a first-class session primitive.
 *
 * @module
 */
import { randomUUID } from 'node:crypto';
import { resolveKanbanAssigneeRootSessionKey } from './kanban-assignee.js';
import { gatewayRpcCall } from './gateway-rpc.js';
/**
 * Generate a deterministic Kanban run correlation key from a launch label.
 *
 * Historical note: the run link field is still named `sessionKey`, but for
 * Kanban execution this value is only a stable run correlation key. The real
 * worker session key is attached separately as `childSessionKey`.
 */
export function buildKanbanFallbackRunKey(label) {
    const normalized = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `kanban-root:${normalized}`;
}
/** Resolve the owning top-level worker root session for a task assignee. */
export function resolveKanbanFallbackParentSessionKey(assignee) {
    return resolveKanbanAssigneeRootSessionKey(assignee);
}
function buildChildSessionKey(parentSessionKey) {
    const match = parentSessionKey.match(/^agent:([^:]+):main$/);
    if (!match) {
        throw new Error(`Parent agent session must be a top-level root: ${parentSessionKey}`);
    }
    return `agent:${match[1]}:subagent:${randomUUID()}`;
}
/**
 * Launch a Kanban task as a real child session under an existing top-level
 * agent root.
 */
export async function launchKanbanFallbackSubagentViaRpc(params) {
    const sessionKey = buildKanbanFallbackRunKey(params.label);
    const childSessionKey = buildChildSessionKey(params.parentSessionKey);
    const createResponse = await gatewayRpcCall('sessions.create', {
        key: childSessionKey,
        parentSessionKey: params.parentSessionKey,
        label: params.label,
        ...(params.model ? { model: params.model } : {}),
    });
    const resolvedChildSessionKey = typeof createResponse.key === 'string' && createResponse.key.trim()
        ? createResponse.key
        : typeof createResponse.sessionKey === 'string' && createResponse.sessionKey.trim()
            ? createResponse.sessionKey
            : childSessionKey;
    let sendResponse;
    try {
        sendResponse = await gatewayRpcCall('sessions.send', {
            key: resolvedChildSessionKey,
            message: params.task,
            ...(params.thinking ? { thinking: params.thinking } : {}),
            idempotencyKey: `kanban-subagent-${Date.now()}-${randomUUID().slice(0, 8)}`,
        });
    }
    catch (error) {
        try {
            await gatewayRpcCall('sessions.delete', {
                key: resolvedChildSessionKey,
                deleteTranscript: true,
            });
        }
        catch {
            // Best-effort cleanup only; preserve the original launch failure.
        }
        throw error;
    }
    return {
        sessionKey,
        parentSessionKey: params.parentSessionKey,
        childSessionKey: resolvedChildSessionKey,
        knownSessionKeysBefore: [params.parentSessionKey],
        runId: sendResponse.runId,
    };
}
