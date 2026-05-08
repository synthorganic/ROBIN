import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node-pty';
import { config } from './config.js';
import { prepareEmbeddedCodexHome } from './codex-home.js';
import { broadcast } from '../routes/events.js';
const BUFFER_LIMIT = 600;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 28;
function now() {
    return Date.now();
}
function defaultTerminalWorkspace() {
    const configured = process.env.INERTIAI_OPS_TERMINAL_WORKSPACE?.trim();
    return path.resolve(configured || os.homedir());
}
function defaultShell() {
    if (process.platform === 'win32') {
        return {
            file: 'powershell.exe',
            args: ['-NoLogo'],
        };
    }
    return {
        file: process.env.SHELL || '/bin/bash',
        args: ['-l'],
    };
}
function resolveCliAgentRoot(baseDir) {
    const candidates = [
        path.resolve(baseDir, 'vendor', 'cli-agent'),
    ];
    return candidates.find((candidate) => (fs.existsSync(path.join(candidate, 'cli.js'))
        && fs.existsSync(path.join(candidate, 'package.json')))) ?? null;
}
function resolveCliLaunchScript(baseDir) {
    const candidate = path.resolve(baseDir, 'scripts', 'embedded-cli.mjs');
    return fs.existsSync(candidate) ? candidate : null;
}
function resolveExecutable(candidates) {
    const pathEntries = (process.env.PATH ?? '')
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
    for (const entry of pathEntries) {
        for (const candidate of candidates) {
            const resolved = path.join(entry, candidate);
            if (fs.existsSync(resolved)) {
                return resolved;
            }
        }
    }
    return null;
}
export class OpsTerminalManager {
    states = new Map();
    ptys = new Map();
    workspacePath = defaultTerminalWorkspace();
    cliAgentRoot = resolveCliAgentRoot(path.resolve(process.cwd()));
    cliLaunchScript = resolveCliLaunchScript(path.resolve(process.cwd()));
    codexExecutable = resolveExecutable(process.platform === 'win32'
        ? ['codex.cmd', 'codex.exe', 'codex.ps1', 'codex']
        : ['codex']);
    constructor() {
        const base = [
            { id: 'cli', label: 'ROBIN CLI Agent', role: 'cli-agent', readonly: false },
            { id: 'support', label: 'Support Shell', role: 'support-shell', readonly: false },
            { id: 'logs', label: 'Bridge / Logs', role: 'bridge-log', readonly: true },
        ];
        for (const item of base) {
            this.states.set(item.id, {
                id: item.id,
                label: item.label,
                role: item.role,
                running: false,
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                readonly: item.readonly,
                lastUpdated: now(),
                pid: null,
                buffer: [],
            });
        }
    }
    list() {
        return Array.from(this.states.values()).map((state) => ({ ...state, buffer: [...state.buffer] }));
    }
    status(id) {
        return this.clone(this.require(id));
    }
    getWorkspace() {
        return this.workspacePath;
    }
    setWorkspace(nextPath, options) {
        if (!nextPath?.trim()) {
            throw new Error('Workspace path is required');
        }
        const resolvedPath = path.resolve(nextPath.trim());
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
            throw new Error(`Workspace directory not found: ${resolvedPath}`);
        }
        const previousPath = this.workspacePath;
        const restartMode = options?.restart ?? 'running';
        const runningBefore = new Set(this.ptys.keys());
        const restartedTerminals = [];
        this.workspacePath = resolvedPath;
        process.env.INERTIAI_OPS_TERMINAL_WORKSPACE = resolvedPath;
        if (restartMode === 'running') {
            for (const id of ['cli', 'support']) {
                if (!runningBefore.has(id))
                    continue;
                this.stop(id);
                this.start(id);
                restartedTerminals.push(id);
            }
        }
        if (resolvedPath !== previousPath) {
            const restartLabel = restartedTerminals.length > 0
                ? `; restarted ${restartedTerminals.join(', ')}`
                : '';
            this.appendLog(`[workspace] switched terminal workspace -> ${resolvedPath}${restartLabel}`);
            broadcast('ops.terminal.workspace', {
                path: resolvedPath,
                previousPath,
                restartedTerminals,
                ts: now(),
            });
        }
        return {
            path: resolvedPath,
            previousPath,
            restartedTerminals,
            terminals: this.list(),
        };
    }
    start(id) {
        const state = this.require(id);
        if (id === 'logs') {
            state.running = true;
            state.lastUpdated = now();
            this.emitStatus(state);
            return this.clone(state);
        }
        if (this.ptys.has(id)) {
            return this.clone(state);
        }
        const spec = this.launchSpec(id);
        const pty = spawn(spec.file, spec.args, {
            cols: state.cols,
            rows: state.rows,
            cwd: spec.cwd,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                INERTIAI_OPS_TERMINAL: id,
                INERTIAI_OPS_TERMINAL_WORKSPACE: this.workspacePath,
                ...spec.env,
            },
            name: 'xterm-color',
            ...(process.platform === 'win32' ? { useConpty: false } : {}),
        });
        pty.onData((chunk) => this.pushOutput(id, chunk));
        const currentPty = pty;
        pty.onExit(({ exitCode }) => {
            if (this.ptys.get(id) !== currentPty)
                return;
            this.ptys.delete(id);
            state.running = false;
            state.pid = null;
            state.lastUpdated = now();
            this.pushOutput(id, `\r\n[process exited ${exitCode}]\r\n`);
            this.emitStatus(state);
        });
        this.ptys.set(id, pty);
        state.running = true;
        state.pid = pty.pid;
        state.lastUpdated = now();
        this.pushOutput(id, `${spec.banner}\r\n`);
        this.emitStatus(state);
        return this.clone(state);
    }
    stop(id) {
        const state = this.require(id);
        if (id === 'logs') {
            state.running = false;
            state.pid = null;
            state.lastUpdated = now();
            this.emitStatus(state);
            return this.clone(state);
        }
        const pty = this.ptys.get(id);
        if (pty) {
            pty.kill();
            this.ptys.delete(id);
        }
        state.running = false;
        state.pid = null;
        state.lastUpdated = now();
        this.emitStatus(state);
        return this.clone(state);
    }
    write(id, input) {
        const state = this.require(id);
        if (state.readonly) {
            throw new Error(`${state.label} is read-only`);
        }
        const pty = this.ptys.get(id);
        if (!pty) {
            throw new Error(`${state.label} is not running`);
        }
        pty.write(input);
        state.lastUpdated = now();
        this.emitStatus(state);
        return this.clone(state);
    }
    sendBlock(id, text) {
        const payload = text.replace(/\r?\n/g, '\r') + '\r';
        return this.write(id, payload);
    }
    resize(id, cols, rows) {
        const state = this.require(id);
        state.cols = Math.max(40, cols);
        state.rows = Math.max(8, rows);
        state.lastUpdated = now();
        if (id !== 'logs') {
            const pty = this.ptys.get(id);
            pty?.resize(state.cols, state.rows);
        }
        this.emitStatus(state);
        return this.clone(state);
    }
    ctrlC(id) {
        return this.write(id, '\x03');
    }
    appendLog(message) {
        const state = this.require('logs');
        state.running = true;
        state.lastUpdated = now();
        this.pushOutput('logs', message.endsWith('\n') ? message : `${message}\n`);
        this.emitStatus(state);
        return this.clone(state);
    }
    launchSpec(id) {
        if (id === 'cli' && this.codexExecutable) {
            const codexHome = prepareEmbeddedCodexHome({ workspacePath: this.workspacePath });
            return {
                file: this.codexExecutable,
                args: [],
                cwd: this.workspacePath,
                env: {
                    CODEX_HOME: codexHome.targetHome,
                    FORCE_COLOR: '1',
                },
                banner: `[ROBIN CLI Agent] launching Codex CLI from ${this.codexExecutable} with embedded home ${codexHome.targetHome}`,
            };
        }
        if (id === 'cli' && this.cliAgentRoot && this.cliLaunchScript) {
            const dependenciesInstalled = fs.existsSync(path.join(this.cliAgentRoot, 'node_modules'));
            const buildReady = fs.existsSync(path.join(this.cliAgentRoot, 'dist', 'src', 'entrypoints', 'cli.js'));
            return {
                file: process.execPath,
                args: [this.cliLaunchScript, 'launch'],
                cwd: this.workspacePath,
                env: {
                    FORCE_COLOR: '1',
                    INERTIAI_OPS_CLI_SOURCE: this.cliAgentRoot,
                    INERTIAI_OPS_CLI_WORKSPACE: this.workspacePath,
                },
                banner: dependenciesInstalled && buildReady
                    ? `[ROBIN CLI Agent] launching vendored runtime from ${this.cliAgentRoot}`
                    : `[ROBIN CLI Agent] preparing vendored runtime from ${this.cliAgentRoot}`,
            };
        }
        const shell = defaultShell();
        return {
            file: shell.file,
            args: shell.args,
            cwd: this.workspacePath,
            banner: id === 'cli'
                ? `[ROBIN CLI Agent] embedded runtime unavailable, falling back to local shell in ${this.workspacePath}`
                : `[${this.require(id).label}] ready in ${this.workspacePath}`,
        };
    }
    require(id) {
        const state = this.states.get(id);
        if (!state)
            throw new Error(`Unknown terminal '${id}'`);
        return state;
    }
    emitStatus(state) {
        broadcast('ops.terminal.status', {
            terminalId: state.id,
            status: this.clone(state),
        });
    }
    pushOutput(id, chunk) {
        const state = this.require(id);
        state.buffer.push(chunk);
        if (state.buffer.length > BUFFER_LIMIT) {
            state.buffer.splice(0, state.buffer.length - BUFFER_LIMIT);
        }
        state.lastUpdated = now();
        broadcast('ops.terminal.output', {
            terminalId: id,
            chunk,
            ts: state.lastUpdated,
        });
    }
    clone(state) {
        return {
            ...state,
            buffer: [...state.buffer],
        };
    }
}
export const opsTerminalManager = new OpsTerminalManager();
// Bring the log pane online immediately so API consumers can read it.
opsTerminalManager.appendLog(`[ROBIN] terminal bus online on ${os.hostname()} (${config.host}:${config.port})`);
