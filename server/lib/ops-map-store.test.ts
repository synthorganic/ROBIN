import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('opsMapStore', () => {
  const originalEnv = { ...process.env };
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-map-store-'));
    process.env = {
      ...originalEnv,
      HOME: tempHome,
    };
    vi.resetModules();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('creates, normalizes, and groups assets into layers', async () => {
    const { opsMapStore } = await import('./ops-map-store.js');

    const asset = await opsMapStore.create({
      title: '  Dock Camera  ',
      type: 'video',
      lat: 42.1,
      lng: -71.2,
      sourceUrl: ' https://example.com/feed.mp4 ',
      thumbnailUrl: ' https://example.com/thumb.jpg ',
      notes: '  South loading dock feed  ',
      tags: [' logistics ', 'dock', 'dock'],
      status: ' active ',
      linkedSessionId: ' agent:main:main ',
    });

    expect(asset.title).toBe('Dock Camera');
    expect(asset.sourceUrl).toBe('https://example.com/feed.mp4');
    expect(asset.tags).toEqual(['logistics', 'dock']);
    expect(asset.status).toBe('active');
    expect(asset.linkedSessionId).toBe('agent:main:main');

    const assets = await opsMapStore.list();
    expect(assets).toHaveLength(1);

    const layers = await opsMapStore.layers();
    expect(layers.find((layer) => layer.id === 'videos')?.assetIds).toContain(asset.id);
    expect(layers.find((layer) => layer.id === 'documents')?.assetIds).toEqual([]);
  });

  it('updates and removes persisted assets', async () => {
    const { opsMapStore } = await import('./ops-map-store.js');

    const created = await opsMapStore.create({
      title: 'Plan',
      type: 'document',
      lat: 10,
      lng: 20,
      sourceUrl: '/docs/plan.pdf',
      notes: '',
      tags: ['alpha'],
      status: 'draft',
      linkedSessionId: undefined,
    });

    const updated = await opsMapStore.update(created.id, {
      title: 'Updated Plan',
      tags: ['alpha', 'beta', 'beta'],
      status: 'published',
    });

    expect(updated.title).toBe('Updated Plan');
    expect(updated.tags).toEqual(['alpha', 'beta']);
    expect(updated.status).toBe('published');

    await opsMapStore.remove(created.id);
    await expect(opsMapStore.list()).resolves.toEqual([]);
  });
});
