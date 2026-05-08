/**
 * File watcher for workspace files.
 *
 * Watches each known workspace's `MEMORY.md`, `memory/` directory, and
 * optionally the full workspace directory. Broadcasts SSE events so the UI can react:
 * - `memory.changed` — for backward compat (memory panel refresh)
 * - `file.changed` — for file browser (editor reload / AI lock)
 *
 * Per-source debouncing prevents duplicate events from a single save.
 * @module
 */
import path from 'node:path';
import { existsSync, readdirSync, watch } from 'node:fs';
import { broadcast } from '../routes/events.js';
import { config } from './config.js';
import { resolveAgentWorkspace } from './agent-workspace.js';
import { isBinary, isExcluded } from './file-utils.js';
import { isWorkspaceLocal } from './workspace-detect.js';
let rootDirWatcher = null;
const memoryWatchers = new Map();
const memoryDirWatchers = new Map();
const workspaceWatchers = new Map();
// Per-source debounce to avoid multiple events for single save
// (separate timers so MEMORY.md changes don't suppress daily file changes)
const lastBroadcastBySource = new Map();
const DEBOUNCE_MS = 500;
const MAX_SOURCES = 500;
const WORKSPACE_PREFIX = 'workspace-';
function shouldBroadcast(source) {
    const now = Date.now();
    const last = lastBroadcastBySource.get(source) ?? 0;
    if (now - last < DEBOUNCE_MS) {
        return false;
    }
    if (lastBroadcastBySource.size >= MAX_SOURCES) {
        lastBroadcastBySource.clear();
    }
    lastBroadcastBySource.set(source, now);
    return true;
}
function getWatchFilename(filename) {
    if (typeof filename === 'string')
        return filename;
    if (filename)
        return filename.toString();
    return null;
}
function getScopedSourceKey(agentId, source) {
    return `${agentId}:${source}`;
}
function broadcastWorkspaceFileChanged(agentId, filePath) {
    broadcast('file.changed', {
        path: filePath,
        agentId,
    });
}
function broadcastWorkspaceMemoryChanged(agentId, file) {
    broadcast('memory.changed', {
        source: 'file',
        file,
        agentId,
    });
}
function discoverWorkspaces() {
    const workspaces = new Map();
    const mainWorkspace = resolveAgentWorkspace('main');
    workspaces.set(mainWorkspace.agentId, mainWorkspace);
    const openclawDir = path.join(config.home, '.openclaw');
    if (!existsSync(openclawDir)) {
        return [...workspaces.values()];
    }
    for (const entry of readdirSync(openclawDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_PREFIX))
            continue;
        const rawAgentId = entry.name.slice(WORKSPACE_PREFIX.length);
        if (!rawAgentId)
            continue;
        try {
            const workspace = resolveAgentWorkspace(rawAgentId);
            workspaces.set(workspace.agentId, workspace);
        }
        catch {
            // Ignore directories that are not valid agent workspaces.
        }
    }
    return [...workspaces.values()];
}
function closeWatchers(watchers, agentIds) {
    for (const [agentId, watcher] of watchers.entries()) {
        if (agentIds && agentIds.has(agentId))
            continue;
        watcher.close();
        watchers.delete(agentId);
    }
}
function watchWorkspaceMemoryFile(workspace) {
    if (memoryWatchers.has(workspace.agentId) || !existsSync(workspace.memoryPath))
        return;
    try {
        const watcher = watch(workspace.memoryPath, (eventType) => {
            if (eventType !== 'change')
                return;
            if (!shouldBroadcast(getScopedSourceKey(workspace.agentId, 'MEMORY.md')))
                return;
            console.log(`[file-watcher] ${workspace.agentId}: MEMORY.md changed`);
            broadcastWorkspaceMemoryChanged(workspace.agentId, 'MEMORY.md');
            broadcastWorkspaceFileChanged(workspace.agentId, 'MEMORY.md');
        });
        memoryWatchers.set(workspace.agentId, watcher);
        console.log(`[file-watcher] Watching ${workspace.agentId}: MEMORY.md`);
    }
    catch (err) {
        console.error(`[file-watcher] Failed to watch ${workspace.agentId}: MEMORY.md:`, err.message);
    }
}
function watchWorkspaceMemoryDir(workspace) {
    if (memoryDirWatchers.has(workspace.agentId) || !existsSync(workspace.memoryDir))
        return;
    try {
        const watcher = watch(workspace.memoryDir, (_eventType, filename) => {
            const file = getWatchFilename(filename);
            if (!file?.endsWith('.md'))
                return;
            if (!shouldBroadcast(getScopedSourceKey(workspace.agentId, `daily:${file}`)))
                return;
            console.log(`[file-watcher] ${workspace.agentId}: ${file} changed`);
            broadcastWorkspaceMemoryChanged(workspace.agentId, file);
            broadcastWorkspaceFileChanged(workspace.agentId, `memory/${file}`);
        });
        memoryDirWatchers.set(workspace.agentId, watcher);
        console.log(`[file-watcher] Watching ${workspace.agentId}: memory/ directory`);
    }
    catch (err) {
        console.error(`[file-watcher] Failed to watch ${workspace.agentId}: memory/:`, err.message);
    }
}
function watchWorkspaceTree(workspace) {
    if (!config.workspaceWatchRecursive)
        return;
    if (workspaceWatchers.has(workspace.agentId) || !existsSync(workspace.workspaceRoot))
        return;
    try {
        const watcher = watch(workspace.workspaceRoot, { recursive: true }, (_eventType, filename) => {
            const file = getWatchFilename(filename);
            if (!file)
                return;
            const normalized = file.replace(/\\/g, '/');
            const segments = normalized.split('/');
            if (segments.some(seg => seg && (isExcluded(seg) || seg.startsWith('.'))))
                return;
            if (isBinary(normalized))
                return;
            if (normalized === 'MEMORY.md' || normalized.startsWith('memory/'))
                return;
            if (!shouldBroadcast(getScopedSourceKey(workspace.agentId, `workspace:${normalized}`)))
                return;
            console.log(`[file-watcher] ${workspace.agentId}: workspace ${normalized} changed`);
            broadcastWorkspaceFileChanged(workspace.agentId, normalized);
        });
        workspaceWatchers.set(workspace.agentId, watcher);
        console.log(`[file-watcher] Watching ${workspace.agentId}: workspace directory (recursive)`);
    }
    catch (err) {
        console.warn(`[file-watcher] Recursive workspace watch failed for ${workspace.agentId}:`, err.message);
        console.warn('[file-watcher] File browser still works, use manual refresh for non-memory file updates.');
    }
}
function refreshWorkspaceWatchers() {
    const workspaces = discoverWorkspaces();
    const activeAgentIds = new Set(workspaces.map((workspace) => workspace.agentId));
    closeWatchers(memoryWatchers, activeAgentIds);
    closeWatchers(memoryDirWatchers, activeAgentIds);
    closeWatchers(workspaceWatchers, activeAgentIds);
    for (const workspace of workspaces) {
        watchWorkspaceMemoryFile(workspace);
        watchWorkspaceMemoryDir(workspace);
        watchWorkspaceTree(workspace);
    }
}
function startRootWorkspaceWatcher() {
    const openclawDir = path.join(config.home, '.openclaw');
    if (rootDirWatcher || !existsSync(openclawDir))
        return;
    try {
        rootDirWatcher = watch(openclawDir, (_eventType, filename) => {
            const file = getWatchFilename(filename);
            if (!file)
                return;
            if (file === 'workspace' || file.startsWith(WORKSPACE_PREFIX)) {
                refreshWorkspaceWatchers();
            }
        });
    }
    catch (err) {
        console.warn('[file-watcher] Failed to watch workspace root for new agent workspaces:', err.message);
    }
}
/**
 * Start watching workspace files for changes.
 * Call this during server startup.
 *
 * When the workspace is remote (NERVE_WORKSPACE_REMOTE=true or workspace
 * directory is not locally accessible), skips all file watchers since
 * there's nothing local to watch.
 */
export async function startFileWatcher() {
    stopFileWatcher();
    // Check if the main workspace is local before setting up watchers
    const mainWorkspace = resolveAgentWorkspace('main');
    const isLocal = await isWorkspaceLocal(mainWorkspace.workspaceRoot);
    if (!isLocal) {
        console.log('[file-watcher] Workspace is remote — file watching disabled');
        return;
    }
    refreshWorkspaceWatchers();
    startRootWorkspaceWatcher();
    if (!config.workspaceWatchRecursive) {
        console.log('[file-watcher] Workspace recursive watch disabled (default). Set NERVE_WATCH_WORKSPACE_RECURSIVE=true to re-enable SSE file.changed events outside memory/.');
    }
}
/**
 * Stop watching files.
 * Call this during graceful shutdown.
 */
export function stopFileWatcher() {
    rootDirWatcher?.close();
    rootDirWatcher = null;
    closeWatchers(memoryWatchers);
    closeWatchers(memoryDirWatchers);
    closeWatchers(workspaceWatchers);
}
