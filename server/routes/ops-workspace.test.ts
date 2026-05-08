import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

describe('ops workspace routes', () => {
  let tempRoot: string;
  let previousHome: string | undefined;
  let activeWorkspace: string;

  beforeEach(async () => {
    vi.resetModules();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-workspace-routes-test-'));
    activeWorkspace = path.join(tempRoot, 'active');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'projects'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'repos'), { recursive: true });

    previousHome = process.env.HOME;
    process.env.HOME = tempRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function buildApp() {
    const getWorkspace = vi.fn(() => activeWorkspace);
    const setWorkspace = vi.fn((nextPath: string, options?: { restart?: 'running' | 'none' }) => ({
      path: path.resolve(nextPath),
      previousPath: activeWorkspace,
      restartedTerminals: options?.restart === 'running' ? ['cli'] : [],
      terminals: [],
    }));

    vi.doMock('../lib/ops-terminals.js', () => ({
      opsTerminalManager: {
        getWorkspace,
        setWorkspace,
      },
    }));

    const mod = await import('./ops-workspace.js');
    const app = new Hono();
    app.route('/', mod.default);
    return { app, getWorkspace, setWorkspace };
  }

  it('lists candidate workspace directories and includes current workspace', async () => {
    const { app } = await buildApp();
    const response = await app.request('/api/ops/workspace/list');

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      ok: boolean;
      currentPath: string;
      workspaces: Array<{ path: string }>;
    };

    expect(json.ok).toBe(true);
    expect(json.currentPath).toBe(activeWorkspace);
    expect(json.workspaces.some((workspace) => workspace.path === activeWorkspace)).toBe(true);
    expect(json.workspaces.some((workspace) => workspace.path === path.join(tempRoot, 'projects'))).toBe(true);
  });

  it('returns the current workspace from the terminal manager', async () => {
    const { app, getWorkspace } = await buildApp();
    const response = await app.request('/api/ops/workspace/current');

    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; path: string };
    expect(json.ok).toBe(true);
    expect(json.path).toBe(activeWorkspace);
    expect(getWorkspace).toHaveBeenCalled();
  });

  it('switches terminal workspace with running-terminal restart mode', async () => {
    const { app, setWorkspace } = await buildApp();
    const nextWorkspace = path.join(tempRoot, 'repos');

    const response = await app.request('/api/ops/workspace/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: nextWorkspace, restart: 'running' }),
    });

    expect(response.status).toBe(200);
    expect(setWorkspace).toHaveBeenCalledWith(nextWorkspace, { restart: 'running' });

    const json = (await response.json()) as {
      ok: boolean;
      path: string;
      restartedTerminals: string[];
    };
    expect(json.ok).toBe(true);
    expect(json.path).toBe(path.resolve(nextWorkspace));
    expect(json.restartedTerminals).toEqual(['cli']);
  });

  it('rejects invalid restart mode values', async () => {
    const { app } = await buildApp();
    const response = await app.request('/api/ops/workspace/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: activeWorkspace, restart: 'all' }),
    });

    expect(response.status).toBe(400);
    const json = (await response.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('restart must be');
  });
});
