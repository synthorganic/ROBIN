/**
 * File operation pipeline for the file explorer.
 *
 * Single source of truth for rename/move/trash/restore semantics.
 * All operations are constrained to workspace-relative paths.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getWorkspaceRoot, isExcluded, resolveWorkspacePathForRoot, } from './file-utils.js';
import { config } from './config.js';
import { withMutex } from './mutex.js';
const TRASH_DIR = '.trash';
const TRASH_INDEX = '.index.json';
const TRASH_UNDO_TTL_MS = 10_000;
const FILE_OPS_MUTEX_KEY = 'file-ops';
const EMPTY_INDEX = { version: 1, items: {} };
export class FileOpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = 'FileOpError';
        this.status = status;
        this.code = code;
    }
}
async function withFileOpsLock(fn) {
    return withMutex(FILE_OPS_MUTEX_KEY, fn);
}
function toPosix(rel) {
    return rel.replace(/\\/g, '/');
}
function normalizeWorkspaceRoot(workspaceRoot) {
    return getWorkspaceRoot(workspaceRoot);
}
function toWorkspaceRelative(absPath, workspaceRoot) {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    const rel = path.relative(root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new FileOpError(403, 'invalid_path', 'Invalid or excluded path');
    }
    return toPosix(rel || '.');
}
function isInTrash(relPath) {
    return relPath === TRASH_DIR || relPath.startsWith(`${TRASH_DIR}/`);
}
function isTrashRoot(relPath) {
    return relPath === TRASH_DIR;
}
async function exists(absPath) {
    try {
        await fs.access(absPath);
        return true;
    }
    catch {
        return false;
    }
}
async function statOrThrow(absPath) {
    try {
        return await fs.stat(absPath);
    }
    catch {
        throw new FileOpError(404, 'not_found', 'Path not found');
    }
}
function hasControlChars(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || code === 127) {
            return true;
        }
    }
    return false;
}
function assertValidNewName(newName) {
    const trimmed = newName.trim();
    if (!trimmed) {
        throw new FileOpError(400, 'invalid_name', 'Name cannot be empty');
    }
    if (trimmed === '.' || trimmed === '..') {
        throw new FileOpError(400, 'invalid_name', 'Invalid name');
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        throw new FileOpError(400, 'invalid_name', 'Name cannot include path separators');
    }
    if (hasControlChars(trimmed)) {
        throw new FileOpError(400, 'invalid_name', 'Name contains unsupported control characters');
    }
    if (Buffer.byteLength(trimmed, 'utf8') > 255) {
        throw new FileOpError(400, 'invalid_name', 'Name is too long (max 255 bytes)');
    }
    if (isExcluded(trimmed)) {
        throw new FileOpError(403, 'excluded_name', 'Name is not allowed');
    }
}
async function resolvePathAllowNewOrThrow(workspaceRoot, relPath) {
    const resolved = await resolveWorkspacePathForRoot(workspaceRoot, relPath, { allowNonExistent: true });
    if (!resolved) {
        throw new FileOpError(403, 'invalid_path', 'Invalid or excluded path');
    }
    return resolved;
}
function assertNotProtected(relPath) {
    if (isTrashRoot(relPath)) {
        throw new FileOpError(422, 'protected_path', 'This path is protected');
    }
}
function assertNotProtectedTarget(targetRelPath) {
    if (isTrashRoot(targetRelPath)) {
        throw new FileOpError(422, 'protected_path', 'Cannot target reserved .trash root path');
    }
}
function assertNotMovingDirIntoSelf(sourceAbs, targetAbs, sourceIsDirectory) {
    if (!sourceIsDirectory)
        return;
    if (targetAbs === sourceAbs || targetAbs.startsWith(sourceAbs + path.sep)) {
        throw new FileOpError(422, 'invalid_move', 'Cannot move a folder into itself');
    }
}
async function assertTargetNotExists(targetAbs) {
    if (await exists(targetAbs)) {
        throw new FileOpError(409, 'conflict', 'A file or folder with this name already exists');
    }
}
function trashDirAbs(workspaceRoot) {
    return path.join(normalizeWorkspaceRoot(workspaceRoot), TRASH_DIR);
}
function trashIndexAbs(workspaceRoot) {
    return path.join(trashDirAbs(workspaceRoot), TRASH_INDEX);
}
async function ensureTrashInfra(workspaceRoot) {
    const trashDir = trashDirAbs(workspaceRoot);
    try {
        await fs.mkdir(trashDir, { recursive: true });
    }
    catch {
        throw new FileOpError(422, 'trash_path_conflict', 'Reserved .trash path is not a directory');
    }
    const trashStat = await fs.stat(trashDir).catch(() => null);
    if (!trashStat || !trashStat.isDirectory()) {
        throw new FileOpError(422, 'trash_path_conflict', 'Reserved .trash path is not a directory');
    }
    const indexPath = trashIndexAbs(workspaceRoot);
    if (!(await exists(indexPath))) {
        await fs.writeFile(indexPath, JSON.stringify(EMPTY_INDEX, null, 2) + '\n', 'utf-8');
    }
}
function isValidTrashIndexItem(item) {
    return (typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.originalPath === 'string' &&
        typeof item.deletedAtMs === 'number' &&
        (item.type === 'file' || item.type === 'directory'));
}
async function readTrashIndex(workspaceRoot) {
    try {
        const raw = await fs.readFile(trashIndexAbs(workspaceRoot), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && parsed.items && typeof parsed.items === 'object') {
            const validItems = {};
            for (const [key, value] of Object.entries(parsed.items)) {
                if (isValidTrashIndexItem(value)) {
                    validItems[key] = value;
                }
            }
            return {
                version: 1,
                items: validItems,
            };
        }
        return { ...EMPTY_INDEX, items: {} };
    }
    catch {
        return { ...EMPTY_INDEX, items: {} };
    }
}
async function writeTrashIndex(workspaceRoot, index) {
    const indexPath = trashIndexAbs(workspaceRoot);
    const dirPath = path.dirname(indexPath);
    const tempPath = path.join(dirPath, `${TRASH_INDEX}.${process.pid}.${Date.now()}.${randomId()}.tmp`);
    const payload = JSON.stringify(index, null, 2) + '\n';
    let tempHandle = null;
    try {
        tempHandle = await fs.open(tempPath, 'w');
        await tempHandle.writeFile(payload, 'utf-8');
        await tempHandle.sync();
        await tempHandle.close();
        tempHandle = null;
        await fs.rename(tempPath, indexPath);
        try {
            const dirHandle = await fs.open(dirPath, 'r');
            await dirHandle.sync();
            await dirHandle.close();
        }
        catch {
            // Best-effort durability on platforms/filesystems that support dir fsync.
        }
    }
    catch {
        if (tempHandle) {
            await tempHandle.close().catch(() => undefined);
        }
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw new FileOpError(500, 'trash_index_write_failed', 'Failed to persist trash index');
    }
}
function randomId() {
    return crypto.randomBytes(4).toString('hex');
}
async function buildUniqueTrashTarget(workspaceRoot, sourceAbs, sourceIsDirectory) {
    const base = path.basename(sourceAbs);
    const parsed = path.parse(base);
    for (let i = 0; i < 100; i++) {
        const id = randomId();
        const candidateName = sourceIsDirectory
            ? `${base}--${id}`
            : parsed.ext
                ? `${parsed.name}--${id}${parsed.ext}`
                : `${base}--${id}`;
        const candidateAbs = path.join(trashDirAbs(workspaceRoot), candidateName);
        if (!(await exists(candidateAbs))) {
            return candidateAbs;
        }
    }
    throw new FileOpError(500, 'trash_name_generation_failed', 'Failed to allocate trash path');
}
async function updateTrashIndexAfterMove(workspaceRoot, fromRel, toRel) {
    const fromInTrash = isInTrash(fromRel);
    const toInTrash = isInTrash(toRel);
    if (!fromInTrash && !toInTrash)
        return;
    await ensureTrashInfra(workspaceRoot);
    const index = await readTrashIndex(workspaceRoot);
    // Move/rename inside trash => rename key.
    if (fromInTrash && toInTrash) {
        const item = index.items[fromRel];
        if (item) {
            delete index.items[fromRel];
            index.items[toRel] = item;
            await writeTrashIndex(workspaceRoot, index);
        }
        return;
    }
    // Moved out of trash manually => drop index entry.
    if (fromInTrash && !toInTrash) {
        if (index.items[fromRel]) {
            delete index.items[fromRel];
            await writeTrashIndex(workspaceRoot, index);
        }
    }
}
export async function renameEntry(params) {
    return withFileOpsLock(async () => {
        assertValidNewName(params.newName);
        const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
        const sourceRel = toWorkspaceRelative(params.sourceAbs, workspaceRoot);
        assertNotProtected(sourceRel);
        await statOrThrow(params.sourceAbs);
        const targetAbs = await resolvePathAllowNewOrThrow(workspaceRoot, toPosix(path.join(path.dirname(sourceRel), params.newName.trim())));
        const targetRel = toWorkspaceRelative(targetAbs, workspaceRoot);
        assertNotProtectedTarget(targetRel);
        if (params.sourceAbs === targetAbs) {
            return { from: sourceRel, to: targetRel };
        }
        await assertTargetNotExists(targetAbs);
        await fs.rename(params.sourceAbs, targetAbs);
        await updateTrashIndexAfterMove(workspaceRoot, sourceRel, targetRel);
        return { from: sourceRel, to: targetRel };
    });
}
export async function moveEntry(params) {
    return withFileOpsLock(async () => {
        const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
        const sourceRel = toWorkspaceRelative(params.sourceAbs, workspaceRoot);
        assertNotProtected(sourceRel);
        const sourceStat = await statOrThrow(params.sourceAbs);
        const targetDirAbs = params.targetDirAbs || workspaceRoot;
        // Validation-only: this throws if the caller tries to move outside the workspace.
        toWorkspaceRelative(targetDirAbs, workspaceRoot);
        const targetDirStat = await statOrThrow(targetDirAbs);
        if (!targetDirStat.isDirectory()) {
            throw new FileOpError(400, 'target_not_directory', 'Target must be a directory');
        }
        const targetAbs = path.join(targetDirAbs, path.basename(params.sourceAbs));
        const targetRel = toWorkspaceRelative(targetAbs, workspaceRoot);
        assertNotProtectedTarget(targetRel);
        // Allow moves to .trash in custom workspaces (treated as regular directory)
        if (!isInTrash(sourceRel) && isInTrash(targetRel)) {
            const customRoot = (config.fileBrowserRoot || '').trim();
            if (!customRoot) {
                throw new FileOpError(422, 'use_trash_api', 'Use the trash action for deleting items');
            }
        }
        if (params.sourceAbs === targetAbs) {
            return { from: sourceRel, to: targetRel };
        }
        assertNotMovingDirIntoSelf(params.sourceAbs, targetAbs, sourceStat.isDirectory());
        await assertTargetNotExists(targetAbs);
        await fs.rename(params.sourceAbs, targetAbs);
        await updateTrashIndexAfterMove(workspaceRoot, sourceRel, targetRel);
        return { from: sourceRel, to: targetRel };
    });
}
export async function trashEntry(params) {
    return withFileOpsLock(async () => {
        const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
        const sourceRel = toWorkspaceRelative(params.sourceAbs, workspaceRoot);
        assertNotProtected(sourceRel);
        if (isInTrash(sourceRel)) {
            throw new FileOpError(422, 'already_in_trash', 'Path is already in trash');
        }
        const sourceStat = await statOrThrow(params.sourceAbs);
        await ensureTrashInfra(workspaceRoot);
        const targetAbs = await buildUniqueTrashTarget(workspaceRoot, params.sourceAbs, sourceStat.isDirectory());
        const targetRel = toWorkspaceRelative(targetAbs, workspaceRoot);
        await fs.rename(params.sourceAbs, targetAbs);
        const index = await readTrashIndex(workspaceRoot);
        index.items[targetRel] = {
            id: randomId(),
            originalPath: sourceRel,
            deletedAtMs: Date.now(),
            type: sourceStat.isDirectory() ? 'directory' : 'file',
        };
        await writeTrashIndex(workspaceRoot, index);
        return { from: sourceRel, to: targetRel, undoTtlMs: TRASH_UNDO_TTL_MS };
    });
}
export async function restoreEntry(params) {
    return withFileOpsLock(async () => {
        const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
        const sourceRel = toWorkspaceRelative(params.sourceAbs, workspaceRoot);
        if (!isInTrash(sourceRel) || isTrashRoot(sourceRel)) {
            throw new FileOpError(422, 'not_restorable', 'Only trashed items can be restored');
        }
        await ensureTrashInfra(workspaceRoot);
        const index = await readTrashIndex(workspaceRoot);
        const item = index.items[sourceRel];
        if (!item) {
            throw new FileOpError(404, 'restore_metadata_missing', 'Restore metadata not found for this item');
        }
        const targetAbs = await resolvePathAllowNewOrThrow(workspaceRoot, item.originalPath);
        const targetRel = toWorkspaceRelative(targetAbs, workspaceRoot);
        assertNotProtectedTarget(targetRel);
        await assertTargetNotExists(targetAbs);
        await fs.mkdir(path.dirname(targetAbs), { recursive: true });
        await fs.rename(params.sourceAbs, targetAbs);
        delete index.items[sourceRel];
        await writeTrashIndex(workspaceRoot, index);
        return { from: sourceRel, to: targetRel };
    });
}
