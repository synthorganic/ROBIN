import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('OpsTerminalManager workspace switching', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-terminals-test-'));
    process.env.INERTIAI_OPS_TERMINAL_WORKSPACE = tempRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.INERTIAI_OPS_TERMINAL_WORKSPACE;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function loadModule() {
    const spawnMock = vi.fn(() => {
      const onExitHandlers: Array<(event: { exitCode: number }) => void> = [];
      const pty = {
        pid: Math.floor(Math.random() * 10_000) + 100,
        onData: vi.fn(),
        onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
          onExitHandlers.push(handler);
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => {
          for (const handler of onExitHandlers) handler({ exitCode: 0 });
        }),
      };
      return pty;
    });

    vi.doMock('node-pty', () => ({ spawn: spawnMock }));
    vi.doMock('../routes/events.js', () => ({ broadcast: vi.fn() }));
    vi.doMock('./config.js', () => ({
      config: {
        host: '127.0.0.1',
        port: 3000,
      },
    }));
    vi.doMock('./codex-home.js', () => ({
      prepareEmbeddedCodexHome: vi.fn(() => ({ targetHome: path.join(tempRoot, '.codex-home') })),
    }));

    const mod = await import('./ops-terminals.js');
    return { ...mod, spawnMock };
  }

  it('restarts running terminals in the new workspace', async () => {
    const { OpsTerminalManager, spawnMock } = await loadModule();
    const manager = new OpsTerminalManager();

    manager.start('cli');
    manager.start('support');

    const nextWorkspace = path.join(tempRoot, 'next');
    await fs.mkdir(nextWorkspace, { recursive: true });

    const result = manager.setWorkspace(nextWorkspace, { restart: 'running' });

    expect(result.path).toBe(path.resolve(nextWorkspace));
    expect(result.restartedTerminals).toEqual(['cli', 'support']);
    expect(manager.getWorkspace()).toBe(path.resolve(nextWorkspace));

    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(spawnMock.mock.calls[2]?.[2]).toMatchObject({ cwd: path.resolve(nextWorkspace) });
    expect(spawnMock.mock.calls[3]?.[2]).toMatchObject({ cwd: path.resolve(nextWorkspace) });
  });

  it('applies workspace changes to future launches when restart is none', async () => {
    const { OpsTerminalManager, spawnMock } = await loadModule();
    const manager = new OpsTerminalManager();

    const nextWorkspace = path.join(tempRoot, 'cold-start');
    await fs.mkdir(nextWorkspace, { recursive: true });

    const result = manager.setWorkspace(nextWorkspace, { restart: 'none' });
    expect(result.restartedTerminals).toEqual([]);

    manager.start('cli');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: path.resolve(nextWorkspace) });
  });

  it('rejects non-directory workspace paths', async () => {
    const { OpsTerminalManager } = await loadModule();
    const manager = new OpsTerminalManager();

    await expect(async () => {
      manager.setWorkspace(path.join(tempRoot, 'missing'), { restart: 'running' });
    }).rejects.toThrow('Workspace directory not found');
  });

  it('defaults terminal launches to the user home directory when no workspace override is set', async () => {
    delete process.env.INERTIAI_OPS_TERMINAL_WORKSPACE;

    const { OpsTerminalManager } = await loadModule();
    const manager = new OpsTerminalManager();

    expect(manager.getWorkspace()).toBe(path.resolve(os.homedir()));
  });
});
