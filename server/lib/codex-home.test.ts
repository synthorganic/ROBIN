import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareEmbeddedCodexHome } from './codex-home.js';

describe('prepareEmbeddedCodexHome', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inertiai-ops-codex-home-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('seeds auth/config files and suppresses the current update notice', async () => {
    const sourceHome = path.join(tempRoot, 'source');
    const targetHome = path.join(tempRoot, 'target');
    const workspacePath = path.join(tempRoot, 'workspace');

    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(sourceHome, 'auth.json'), '{"provider":"chatgpt"}');
    await fs.writeFile(path.join(sourceHome, 'config.toml'), 'model = "gpt-5.4"\n');
    await fs.writeFile(
      path.join(sourceHome, 'version.json'),
      JSON.stringify({
        latest_version: '0.118.0',
        dismissed_version: '0.114.0',
        last_checked_at: '2026-03-31T00:00:00Z',
      }),
    );

    const prepared = prepareEmbeddedCodexHome({ sourceHome, targetHome, workspacePath });

    expect(prepared.sourceHome).toBe(path.resolve(sourceHome));
    expect(prepared.targetHome).toBe(path.resolve(targetHome));
    expect(prepared.syncedFiles).toEqual(expect.arrayContaining(['auth.json', 'config.toml']));
    expect(prepared.noticeSuppressed).toBe(true);

    await expect(fs.readFile(path.join(targetHome, 'auth.json'), 'utf8')).resolves.toContain('chatgpt');
    const targetConfig = await fs.readFile(path.join(targetHome, 'config.toml'), 'utf8');
    expect(targetConfig).toContain('gpt-5.4');
    expect(targetConfig).toContain(workspacePath);

    const versionState = JSON.parse(await fs.readFile(path.join(targetHome, 'version.json'), 'utf8'));
    expect(versionState.latest_version).toBe('0.118.0');
    expect(versionState.dismissed_version).toBe('0.118.0');
  });

  it('still creates a target home when no source Codex home exists', async () => {
    const sourceHome = path.join(tempRoot, 'missing-source');
    const targetHome = path.join(tempRoot, 'target');
    const workspacePath = path.join(tempRoot, 'workspace');

    await fs.mkdir(workspacePath, { recursive: true });
    const prepared = prepareEmbeddedCodexHome({ sourceHome, targetHome, workspacePath });

    expect(prepared.sourceHome).toBeNull();
    expect(prepared.syncedFiles).toHaveLength(0);
    expect(prepared.noticeSuppressed).toBe(false);

    const targetStat = await fs.stat(targetHome);
    expect(targetStat.isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(targetHome, 'config.toml'), 'utf8')).resolves.toContain(workspacePath);
  });
});
