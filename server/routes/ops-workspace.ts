import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { opsTerminalManager, type OpsWorkspaceRestartMode } from '../lib/ops-terminals.js';

const app = new Hono();

interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}

function isDirectory(dir: string) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function dedupeByPath(entries: WorkspaceInfo[]) {
  const seen = new Set<string>();
  const unique: WorkspaceInfo[] = [];

  for (const entry of entries) {
    const normalized = process.platform === 'win32'
      ? entry.path.toLowerCase()
      : entry.path;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(entry);
  }

  return unique;
}

function listWorkspaceCandidates(currentWorkspace: string): WorkspaceInfo[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const currentDir = process.cwd();

  const candidates: Array<{ name: string; path: string; includeWhenMissing?: boolean }> = [
    { name: 'Active', path: currentWorkspace, includeWhenMissing: true },
    { name: 'Project', path: currentDir },
    { name: 'Home', path: homeDir },
    { name: 'ROBIN Workspace', path: homeDir ? path.join(homeDir, '.robin', 'workspace') : '' },
    { name: 'Projects', path: homeDir ? path.join(homeDir, 'projects') : '' },
    { name: 'Work', path: homeDir ? path.join(homeDir, 'work') : '' },
    { name: 'Repos', path: homeDir ? path.join(homeDir, 'repos') : '' },
    { name: 'Development', path: homeDir ? path.join(homeDir, 'development') : '' },
  ];

  const discovered = candidates
    .map((candidate, index) => ({
      id: `workspace-${index}`,
      name: candidate.name,
      path: path.resolve(candidate.path || '.'),
      includeWhenMissing: candidate.includeWhenMissing === true,
    }))
    .filter((workspace) => workspace.includeWhenMissing || isDirectory(workspace.path))
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
    }));

  return dedupeByPath(discovered);
}

app.get('/api/ops/workspace/list', async (c) => {
  try {
    const currentPath = opsTerminalManager.getWorkspace();
    const workspaces = listWorkspaceCandidates(currentPath);
    return c.json({ ok: true, currentPath, workspaces });
  } catch (error) {
    return c.json(
      { ok: false, error: (error as Error).message },
      500
    );
  }
});

app.get('/api/ops/workspace/current', async (c) => {
  return c.json({ ok: true, path: opsTerminalManager.getWorkspace() });
});

app.post('/api/ops/workspace/switch', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    path?: string;
    restart?: string;
  };

  if (!body.path?.trim()) {
    return c.json({ ok: false, error: 'Workspace path is required' }, 400);
  }

  const restart = body.restart?.trim() || 'running';
  if (restart !== 'running' && restart !== 'none') {
    return c.json({ ok: false, error: 'restart must be "running" or "none"' }, 400);
  }

  try {
    const result = opsTerminalManager.setWorkspace(body.path, {
      restart: restart as OpsWorkspaceRestartMode,
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 400);
  }
});

export default app;
