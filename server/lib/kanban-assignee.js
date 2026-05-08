/**
 * Shared Kanban assignee normalization helpers.
 * @module
 */
export class InvalidKanbanAssigneeError extends Error {
    constructor(value) {
        super(`Invalid Kanban assignee: ${value}`);
        this.name = 'InvalidKanbanAssigneeError';
    }
}
export function canonicalizeKanbanAssignee(value) {
    if (value == null)
        return undefined;
    if (value === 'operator')
        return 'operator';
    const match = value.match(/^agent:([^:]+)(?::.*)?$/);
    if (!match)
        throw new InvalidKanbanAssigneeError(String(value));
    if (match[1] === 'main')
        throw new InvalidKanbanAssigneeError(value);
    return `agent:${match[1]}`;
}
export function resolveKanbanAssigneeRootSessionKey(value) {
    if (value == null || value === 'operator')
        return null;
    const match = value.match(/^agent:([^:]+)(?::.*)?$/);
    if (!match || match[1] === 'main')
        return null;
    return `agent:${match[1]}:main`;
}
