import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXAMPLE_TS_DNS = 'example-node.tail0000.ts.net';
const EXAMPLE_TS_IPV4 = '100.64.0.42';

const FULL_OPERATOR_SCOPES = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
];

async function importGatewayDetect(execSyncImpl = vi.fn()): Promise<{
  execSyncMock: ReturnType<typeof vi.fn>;
  mod: typeof import('./gateway-detect.js');
}> {
  vi.doUnmock('node:child_process');
  vi.resetModules();
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
      ...actual,
      default: actual,
      execSync: execSyncImpl,
    };
  });
  const mod = await import('./gateway-detect.js');
  return { execSyncMock: execSyncImpl, mod };
}

describe('gateway detection and repair', () => {
  const originalEnv = { ...process.env };
  let tempHome = '';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'robin-gateway-detect-'));
    process.env.HOME = tempHome;
    process.env.ROBIN_DATA_DIR = path.join(tempHome, '.robin');
    delete process.env.OPENCLAW_GATEWAY_TOKEN;

    mkdirSync(path.join(tempHome, '.openclaw', 'devices'), { recursive: true });
    mkdirSync(path.join(tempHome, '.openclaw', 'identity'), { recursive: true });
    mkdirSync(path.join(tempHome, '.openclaw'), { recursive: true });
    mkdirSync(path.join(tempHome, '.robin'), { recursive: true });

    writeFileSync(path.join(tempHome, '.openclaw', 'openclaw.json'), JSON.stringify({
      gateway: {
        port: 18789,
        auth: { token: 'test-token' },
        tools: { allow: ['cron', 'gateway'] },
        controlUi: {
          allowedOrigins: ['http://localhost:3080'],
        },
      },
    }, null, 2));

    writeFileSync(path.join(tempHome, '.robin', 'device-identity.json'), JSON.stringify({
      deviceId: 'robin-device',
      publicKeyB64url: 'robin-public-key',
    }, null, 2));

    writeFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), JSON.stringify({
      'gateway-device': {
        deviceId: 'gateway-device',
        scopes: FULL_OPERATOR_SCOPES,
        tokens: {
          operator: {
            token: 'gateway-token',
            scopes: FULL_OPERATOR_SCOPES,
          },
        },
      },
      'robin-device': {
        deviceId: 'robin-device',
        scopes: FULL_OPERATOR_SCOPES,
        displayName: 'ROBIN UI',
        platform: 'web',
        clientId: 'webchat-ui',
        clientMode: 'webchat',
        tokens: {
          operator: {
            token: 'test-token',
            scopes: FULL_OPERATOR_SCOPES,
          },
        },
      },
    }, null, 2));

    writeFileSync(path.join(tempHome, '.openclaw', 'identity', 'device.json'), JSON.stringify({
      deviceId: 'gateway-device',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2sI3DpP2u80EIk1BddY5hAzvY4xXHzkwmo7aX6ixkm0=\n-----END PUBLIC KEY-----\n',
    }, null, 2));

    writeFileSync(path.join(tempHome, '.openclaw', 'identity', 'device-auth.json'), JSON.stringify({
      version: 1,
      deviceId: 'gateway-device',
      tokens: {
        operator: {
          token: 'gateway-token',
          scopes: ['operator.read'],
        },
      },
    }, null, 2));
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    process.env = { ...originalEnv };
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it('emits one change per missing origin and patches both when applied', async () => {
    const { mod } = await importGatewayDetect();

    const changes = mod.detectNeededConfigChanges({
      gatewayToken: 'test-token',
      allowedOrigins: [
        `  http://${EXAMPLE_TS_IPV4}:3080  `,
        `https://${EXAMPLE_TS_DNS}`,
      ],
    });

    expect(changes.some(change => change.description.includes(`${EXAMPLE_TS_IPV4}:3080`))).toBe(true);
    expect(changes.some(change => change.description.includes(EXAMPLE_TS_DNS))).toBe(true);

    for (const change of changes.filter(change => change.description.includes('allowed origins'))) {
      const result = change.apply();
      expect(result.ok).toBe(true);
    }

    const updated = JSON.parse(readFileSync(path.join(tempHome, '.openclaw', 'openclaw.json'), 'utf8'));
    expect(updated.gateway.controlUi.allowedOrigins).toEqual(expect.arrayContaining([
      'http://localhost:3080',
      `http://${EXAMPLE_TS_IPV4}:3080`,
      `https://${EXAMPLE_TS_DNS}`,
    ]));
    expect(updated.gateway.controlUi.allowedOrigins).not.toContain(`  http://${EXAMPLE_TS_IPV4}:3080  `);
  });

  it('detects missing sessions_spawn in gateway.tools.allow and patches it for kanban execution', async () => {
    const { mod } = await importGatewayDetect();

    const changes = mod.detectNeededConfigChanges({
      gatewayToken: 'test-token',
    });
    const toolsAllowChange = changes.find((change) => change.id === 'tools-allow');

    expect(toolsAllowChange).toBeDefined();
    expect(toolsAllowChange?.description).toContain('sessions_spawn');

    const result = toolsAllowChange!.apply();
    expect(result.ok).toBe(true);

    const updated = JSON.parse(readFileSync(path.join(tempHome, '.openclaw', 'openclaw.json'), 'utf8'));
    expect(updated.gateway.tools.allow).toEqual(expect.arrayContaining([
      'cron',
      'gateway',
      'sessions_spawn',
    ]));
  });

  it('prefers a detected config token over a stale shell env token during setup', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'stale-shell-token';

    const { mod } = await importGatewayDetect();
    const detected = mod.detectGatewayConfig();

    expect(detected.token).toBe('test-token');
    expect(mod.chooseSetupGatewayToken({
      envToken: mod.getEnvGatewayToken(),
      detectedToken: detected.token,
    })).toEqual({
      token: 'test-token',
      source: 'detected',
    });
  });

  it('prefers the systemd runtime token over a stale shell env token during setup', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'stale-shell-token';
    mkdirSync(path.join(tempHome, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(
      path.join(tempHome, '.config', 'systemd', 'user', 'openclaw-gateway.service'),
      '[Service]\nEnvironment=OPENCLAW_GATEWAY_TOKEN=real-systemd-token\n',
    );

    const { mod } = await importGatewayDetect();
    const detected = mod.detectGatewayConfig();

    expect(detected.token).toBe('real-systemd-token');
    expect(mod.chooseSetupGatewayToken({
      envToken: mod.getEnvGatewayToken(),
      detectedToken: detected.token,
    })).toEqual({
      token: 'real-systemd-token',
      source: 'detected',
    });
  });

  it('detects a systemd-only runtime token even when openclaw.json is missing', async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = 'stale-shell-token';
    rmSync(path.join(tempHome, '.openclaw', 'openclaw.json'));
    mkdirSync(path.join(tempHome, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(
      path.join(tempHome, '.config', 'systemd', 'user', 'openclaw-gateway.service'),
      '[Service]\nEnvironment=OPENCLAW_GATEWAY_TOKEN=real-systemd-token\n',
    );

    const { mod } = await importGatewayDetect();
    const detected = mod.detectGatewayConfig();

    expect(detected.token).toBe('real-systemd-token');
    expect(mod.chooseSetupGatewayToken({
      envToken: mod.getEnvGatewayToken(),
      detectedToken: detected.token,
    })).toEqual({
      token: 'real-systemd-token',
      source: 'detected',
    });
  });

  it('approves only the pending request that matches ROBIN and leaves unrelated requests untouched', async () => {
    const execSyncMock = vi.fn((command: string) => {
      if (command.includes('devices list --json')) {
        return Buffer.from(JSON.stringify({
          pending: [
            {
              requestId: 'req-robin',
              deviceId: 'robin-device',
              publicKey: 'robin-public-key',
              displayName: 'ROBIN UI',
            },
            {
              requestId: 'req-other',
              deviceId: 'other-device',
              publicKey: 'other-public-key',
              displayName: 'Other Device',
            },
          ],
        }));
      }

      if (command === 'openclaw devices approve req-robin') {
        return Buffer.from('approved');
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { mod } = await importGatewayDetect();
    const result = mod.approvePendingROBINDevice({
      exec: execSyncMock,
    });

    expect(result).toMatchObject({
      ok: true,
      approved: 1,
    });
    expect(execSyncMock).toHaveBeenCalledWith(
      'openclaw devices approve req-robin',
      expect.objectContaining({ timeout: 10000, stdio: 'pipe' }),
    );
    expect(execSyncMock).not.toHaveBeenCalledWith(
      'openclaw devices approve req-other',
      expect.anything(),
    );
  });

  it('does not approve a pending request with an invalid requestId', async () => {
    const execSyncMock = vi.fn((command: string) => {
      if (command.includes('devices list --json')) {
        return Buffer.from(JSON.stringify({
          pending: [
            {
              requestId: 'req-robin; rm -rf /',
              deviceId: 'robin-device',
              publicKey: 'robin-public-key',
              displayName: 'ROBIN UI',
            },
          ],
        }));
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { mod } = await importGatewayDetect();
    const result = mod.approvePendingROBINDevice({
      exec: execSyncMock,
    });

    expect(result.ok).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.message.toLowerCase()).toContain('manual');
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('openclaw devices approve'),
      expect.anything(),
    );
  });

  it('does not approve any pending request when ROBIN cannot be identified safely', async () => {
    const execSyncMock = vi.fn((command: string) => {
      if (command.includes('devices list --json')) {
        return Buffer.from(JSON.stringify({
          pending: [
            {
              requestId: 'req-a',
              displayName: 'ROBIN UI',
            },
            {
              requestId: 'req-b',
              displayName: 'ROBIN UI',
            },
          ],
        }));
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { mod } = await importGatewayDetect();
    const result = mod.approvePendingROBINDevice({
      exec: execSyncMock,
    });

    expect(result.ok).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.message.toLowerCase()).toContain('manual');
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('openclaw devices approve'),
      expect.anything(),
    );
  });

  it('fails closed when devices list returns parseable JSON with an unusable pending shape', async () => {
    const execSyncMock = vi.fn((command: string) => {
      if (command.includes('devices list --json')) {
        return Buffer.from(JSON.stringify({
          pending: {
            requestId: 'req-robin',
            deviceId: 'robin-device',
            publicKey: 'robin-public-key',
          },
        }));
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { mod } = await importGatewayDetect();
    const result = mod.approvePendingROBINDevice({
      exec: execSyncMock,
    });

    expect(result.ok).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.message.toLowerCase()).toContain('manual');
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('openclaw devices approve'),
      expect.anything(),
    );
  });

  it('fails closed when a pending request matches only one of ROBIN\'s known identifiers', async () => {
    const execSyncMock = vi.fn((command: string) => {
      if (command.includes('devices list --json')) {
        return Buffer.from(JSON.stringify({
          pending: [
            {
              requestId: 'req-partial',
              deviceId: 'robin-device',
              publicKey: 'wrong-public-key',
              displayName: 'ROBIN UI',
            },
            {
              requestId: 'req-other',
              deviceId: 'other-device',
              publicKey: 'other-public-key',
              displayName: 'Other Device',
            },
          ],
        }));
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { mod } = await importGatewayDetect();
    const result = mod.approvePendingROBINDevice({
      exec: execSyncMock,
    });

    expect(result.ok).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.message.toLowerCase()).toContain('manual');
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('openclaw devices approve'),
      expect.anything(),
    );
  });

  it('fails closed when pending-request inspection cannot run safely', async () => {
    const execSyncMock = vi.fn((command: string) => {
      if (command.includes('devices list --json')) {
        throw new Error('openclaw devices list failed');
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { mod } = await importGatewayDetect();
    const result = mod.approvePendingROBINDevice({
      exec: execSyncMock,
    });

    expect(result.ok).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.message.toLowerCase()).toContain('manual');
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('openclaw devices approve'),
      expect.anything(),
    );
  });

  it('repairs only the ROBIN paired device record and preserves unrelated devices', async () => {
    writeFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), JSON.stringify({
      'gateway-device': {
        deviceId: 'gateway-device',
        scopes: FULL_OPERATOR_SCOPES,
        tokens: { operator: { token: 'gateway-token', scopes: FULL_OPERATOR_SCOPES } },
      },
      'robin-device': {
        deviceId: 'robin-device',
        scopes: ['operator.read'],
        displayName: 'ROBIN UI',
        platform: 'web',
        clientId: 'webchat-ui',
        clientMode: 'webchat',
        tokens: { operator: { token: 'old-token', scopes: ['operator.read'] } },
      },
      'other-device': {
        deviceId: 'other-device',
        scopes: ['operator.read'],
        displayName: 'Other Device',
        platform: 'cli',
        clientId: 'other-cli',
        clientMode: 'terminal',
        tokens: { operator: { token: 'other-token', scopes: ['operator.read'] } },
      },
    }, null, 2));

    const { mod } = await importGatewayDetect();
    const result = mod.prePairROBINDevice('test-token');
    const paired = JSON.parse(readFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), 'utf8'));

    expect(result.ok).toBe(true);
    expect(paired['robin-device'].scopes).toEqual(FULL_OPERATOR_SCOPES);
    expect(paired['robin-device'].tokens.operator.scopes).toEqual(FULL_OPERATOR_SCOPES);
    expect(paired['robin-device'].tokens.operator.token).toBe('test-token');
    expect(paired['other-device'].scopes).toEqual(['operator.read']);
    expect(paired['other-device'].tokens.operator.scopes).toEqual(['operator.read']);
  });

  it('repairs only the explicitly targeted identity and does not broaden every paired device', async () => {
    writeFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), JSON.stringify({
      'gateway-device': {
        deviceId: 'gateway-device',
        scopes: ['operator.read'],
        tokens: { operator: { token: 'gateway-token', scopes: ['operator.read'] } },
      },
      'other-device': {
        deviceId: 'other-device',
        scopes: ['operator.read'],
        tokens: { operator: { token: 'other-token', scopes: ['operator.read'] } },
      },
    }, null, 2));

    const { mod } = await importGatewayDetect();
    const result = mod.fixGatewayDeviceScopes({ targetDeviceId: 'gateway-device' });
    const paired = JSON.parse(readFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), 'utf8'));
    const deviceAuth = JSON.parse(readFileSync(path.join(tempHome, '.openclaw', 'identity', 'device-auth.json'), 'utf8'));

    expect(result.ok).toBe(true);
    expect(paired['gateway-device'].scopes).toEqual(FULL_OPERATOR_SCOPES);
    expect(paired['gateway-device'].tokens.operator.scopes).toEqual(FULL_OPERATOR_SCOPES);
    expect(paired['other-device'].scopes).toEqual(['operator.read']);
    expect(paired['other-device'].tokens.operator.scopes).toEqual(['operator.read']);
    expect(deviceAuth.tokens.operator.scopes).toEqual(FULL_OPERATOR_SCOPES);
  });

  it('requests a gateway scope repair when the targeted paired operator token scopes are stale', async () => {
    writeFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), JSON.stringify({
      'gateway-device': {
        deviceId: 'gateway-device',
        scopes: FULL_OPERATOR_SCOPES,
        tokens: { operator: { token: 'gateway-token', scopes: ['operator.read'] } },
      },
      'robin-device': {
        deviceId: 'robin-device',
        scopes: FULL_OPERATOR_SCOPES,
        displayName: 'ROBIN UI',
        platform: 'web',
        clientId: 'webchat-ui',
        clientMode: 'webchat',
        tokens: { operator: { token: 'test-token', scopes: FULL_OPERATOR_SCOPES } },
      },
    }, null, 2));

    writeFileSync(path.join(tempHome, '.openclaw', 'identity', 'device-auth.json'), JSON.stringify({
      version: 1,
      deviceId: 'gateway-device',
      tokens: {
        operator: {
          token: 'gateway-token',
          scopes: FULL_OPERATOR_SCOPES,
        },
      },
    }, null, 2));

    const { mod } = await importGatewayDetect();
    const changes = mod.detectNeededConfigChanges({ gatewayToken: 'test-token' });

    expect(changes.map(change => change.id)).toContain('device-scopes');
    expect(changes.map(change => change.id)).not.toContain('pre-pair');
  });

  it('requests a gateway scope repair when the local targeted identity token scopes are stale', async () => {
    writeFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), JSON.stringify({
      'gateway-device': {
        deviceId: 'gateway-device',
        scopes: FULL_OPERATOR_SCOPES,
        tokens: { operator: { token: 'gateway-token', scopes: FULL_OPERATOR_SCOPES } },
      },
      'robin-device': {
        deviceId: 'robin-device',
        scopes: FULL_OPERATOR_SCOPES,
        displayName: 'ROBIN UI',
        platform: 'web',
        clientId: 'webchat-ui',
        clientMode: 'webchat',
        tokens: { operator: { token: 'test-token', scopes: FULL_OPERATOR_SCOPES } },
      },
      'other-device': {
        deviceId: 'other-device',
        scopes: ['operator.read'],
        tokens: { operator: { token: 'other-token', scopes: ['operator.read'] } },
      },
    }, null, 2));

    writeFileSync(path.join(tempHome, '.openclaw', 'identity', 'device-auth.json'), JSON.stringify({
      version: 1,
      deviceId: 'gateway-device',
      tokens: {
        operator: {
          token: 'gateway-token',
          scopes: ['operator.read'],
        },
      },
    }, null, 2));

    const { mod } = await importGatewayDetect();
    const changes = mod.detectNeededConfigChanges({ gatewayToken: 'test-token' });

    expect(changes.map(change => change.id)).toContain('device-scopes');
    expect(changes.map(change => change.id)).not.toContain('pre-pair');
  });

  it('does not request a blanket scope repair just because an unrelated paired device is under-scoped', async () => {
    writeFileSync(path.join(tempHome, '.openclaw', 'devices', 'paired.json'), JSON.stringify({
      'gateway-device': {
        deviceId: 'gateway-device',
        scopes: FULL_OPERATOR_SCOPES,
        tokens: { operator: { token: 'gateway-token', scopes: FULL_OPERATOR_SCOPES } },
      },
      'robin-device': {
        deviceId: 'robin-device',
        scopes: FULL_OPERATOR_SCOPES,
        displayName: 'ROBIN UI',
        platform: 'web',
        clientId: 'webchat-ui',
        clientMode: 'webchat',
        tokens: { operator: { token: 'test-token', scopes: FULL_OPERATOR_SCOPES } },
      },
      'other-device': {
        deviceId: 'other-device',
        scopes: ['operator.read'],
        tokens: { operator: { token: 'other-token', scopes: ['operator.read'] } },
      },
    }, null, 2));

    writeFileSync(path.join(tempHome, '.openclaw', 'identity', 'device-auth.json'), JSON.stringify({
      version: 1,
      deviceId: 'gateway-device',
      tokens: {
        operator: {
          token: 'gateway-token',
          scopes: FULL_OPERATOR_SCOPES,
        },
      },
    }, null, 2));

    const { mod } = await importGatewayDetect();
    const changes = mod.detectNeededConfigChanges({ gatewayToken: 'test-token' });

    expect(changes.map(change => change.id)).not.toContain('device-scopes');
    expect(changes.map(change => change.id)).not.toContain('pre-pair');
  });
});
