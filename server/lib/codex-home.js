import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const SEEDED_FILES = ['auth.json', 'config.toml'];
const LINKED_DIRS = ['plugins', 'skills'];
function defaultSourceHome() {
    return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
function defaultTargetHome() {
    return path.resolve(process.env.INERTIAI_OPS_CODEX_HOME || path.join(os.homedir(), '.inertiai-ops', 'codex'));
}
function isDirectory(filePath) {
    try {
        return fs.statSync(filePath).isDirectory();
    }
    catch {
        return false;
    }
}
function ensureDirectory(filePath) {
    fs.mkdirSync(filePath, { recursive: true });
}
function copyFileIfNewer(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath)) {
        return false;
    }
    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
    if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) {
        return false;
    }
    ensureDirectory(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
    return true;
}
function ensureLinkedDir(sourcePath, targetPath) {
    if (!isDirectory(sourcePath) || fs.existsSync(targetPath)) {
        return false;
    }
    ensureDirectory(path.dirname(targetPath));
    try {
        fs.symlinkSync(sourcePath, targetPath, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
    }
    catch (error) {
        console.warn(`[codex-home] failed to link ${targetPath} -> ${sourcePath}: ${error.message}`);
        return false;
    }
}
function readVersionState(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch (error) {
        console.warn(`[codex-home] failed to read ${filePath}: ${error.message}`);
        return {};
    }
}
function compareVersions(left, right) {
    if (!left && !right)
        return 0;
    if (!left)
        return -1;
    if (!right)
        return 1;
    const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
        const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
        if (delta !== 0) {
            return delta;
        }
    }
    return 0;
}
function newestVersion(...versions) {
    return versions.reduce((latest, candidate) => {
        if (!candidate) {
            return latest;
        }
        if (!latest || compareVersions(candidate, latest) > 0) {
            return candidate;
        }
        return latest;
    }, undefined);
}
function syncVersionNoticeState(sourceHome, targetHome) {
    const sourceVersionPath = sourceHome ? path.join(sourceHome, 'version.json') : null;
    const targetVersionPath = path.join(targetHome, 'version.json');
    const sourceState = sourceVersionPath ? readVersionState(sourceVersionPath) : {};
    const targetState = readVersionState(targetVersionPath);
    const latestVersion = newestVersion(sourceState.latest_version, targetState.latest_version);
    if (!latestVersion) {
        return false;
    }
    const nextState = {
        ...targetState,
        ...sourceState,
        latest_version: latestVersion,
        dismissed_version: latestVersion,
        last_checked_at: sourceState.last_checked_at ||
            targetState.last_checked_at ||
            new Date(0).toISOString(),
    };
    ensureDirectory(path.dirname(targetVersionPath));
    fs.writeFileSync(targetVersionPath, JSON.stringify(nextState, null, 2));
    return true;
}
function ensureTrustedWorkspace(configPath, workspacePath) {
    const resolvedWorkspace = path.resolve(workspacePath);
    const variants = process.platform === 'win32'
        ? [resolvedWorkspace, `\\\\?\\${resolvedWorkspace}`]
        : [resolvedWorkspace];
    const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    let nextConfig = existingConfig;
    let changed = false;
    for (const variant of variants) {
        const singleQuotedKey = `[projects.'${variant}']`;
        const doubleQuotedKey = `[projects."${variant.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
        if (nextConfig.includes(singleQuotedKey) || nextConfig.includes(doubleQuotedKey)) {
            continue;
        }
        nextConfig = `${nextConfig.replace(/\s*$/, '\n')}\n${singleQuotedKey}\ntrust_level = "trusted"\n`;
        changed = true;
    }
    if (changed) {
        ensureDirectory(path.dirname(configPath));
        fs.writeFileSync(configPath, nextConfig);
    }
    return changed;
}
export function prepareEmbeddedCodexHome(options = {}) {
    const sourceHome = path.resolve(options.sourceHome || defaultSourceHome());
    const targetHome = path.resolve(options.targetHome || defaultTargetHome());
    const sourceExists = isDirectory(sourceHome);
    const normalizedSourceHome = sourceExists ? sourceHome : null;
    ensureDirectory(targetHome);
    const syncedFiles = [];
    const linkedDirs = [];
    if (normalizedSourceHome && normalizedSourceHome !== targetHome) {
        for (const fileName of SEEDED_FILES) {
            const copied = copyFileIfNewer(path.join(normalizedSourceHome, fileName), path.join(targetHome, fileName));
            if (copied) {
                syncedFiles.push(fileName);
            }
        }
        for (const dirName of LINKED_DIRS) {
            const linked = ensureLinkedDir(path.join(normalizedSourceHome, dirName), path.join(targetHome, dirName));
            if (linked) {
                linkedDirs.push(dirName);
            }
        }
    }
    ensureTrustedWorkspace(path.join(targetHome, 'config.toml'), options.workspacePath || process.cwd());
    const noticeSuppressed = syncVersionNoticeState(normalizedSourceHome, targetHome);
    return {
        sourceHome: normalizedSourceHome,
        targetHome,
        syncedFiles,
        linkedDirs,
        noticeSuppressed,
    };
}
