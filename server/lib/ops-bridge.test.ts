import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('opsBridgeService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands work off only through the dedicated CLI lane and records bridge status', async () => {
    const broadcast = vi.fn();
    const start = vi.fn(async () => ({}));
    const sendBlock = vi.fn();
    const appendLog = vi.fn();

    vi.doMock('../routes/events.js', () => ({ broadcast }));
    vi.doMock('./ops-agent.js', () => ({
      opsAgentService: {
        sendMessage: vi.fn(),
      },
    }));
    vi.doMock('./ops-terminals.js', () => ({
      opsTerminalManager: {
        start,
        sendBlock,
        appendLog,
        ctrlC: vi.fn(),
      },
    }));

    const { opsBridgeService } = await import('./ops-bridge.js');
    const result = await opsBridgeService.handoffToCli('agent:main:main', 'Audit the auth flow', 'Focus on login/session code.');

    expect(start).toHaveBeenCalledWith('cli');
    expect(sendBlock).toHaveBeenCalledWith(
      'cli',
      expect.stringContaining('# ROBIN Bridge'),
    );
    expect(sendBlock).toHaveBeenCalledWith(
      'cli',
      expect.stringContaining('Session: agent:main:main'),
    );
    expect(result.activeJob?.targetTerminalId).toBe('cli');
    expect(result.activeJob?.state).toBe('sent');
    expect(result.recentJobs).toHaveLength(1);
    expect(appendLog).toHaveBeenCalledWith(
      expect.stringContaining('-> cli (agent:main:main)'),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'ops.bridge.status',
      expect.objectContaining({
        activeJob: expect.objectContaining({
          sessionId: 'agent:main:main',
          targetTerminalId: 'cli',
        }),
      }),
    );
  });

  it('rejects returns that do not match the active central session', async () => {
    vi.doMock('../routes/events.js', () => ({ broadcast: vi.fn() }));
    vi.doMock('./ops-agent.js', () => ({
      opsAgentService: {
        sendMessage: vi.fn(),
      },
    }));
    vi.doMock('./ops-terminals.js', () => ({
      opsTerminalManager: {
        start: vi.fn(async () => ({})),
        sendBlock: vi.fn(),
        appendLog: vi.fn(),
        ctrlC: vi.fn(),
      },
    }));

    const { opsBridgeService } = await import('./ops-bridge.js');
    await opsBridgeService.handoffToCli('agent:main:main', 'Implement the bridge');

    await expect(
      opsBridgeService.returnToAgent('agent:reviewer:main', 'Done.'),
    ).rejects.toThrow('Bridge return must target the active central agent session');
  });

  it('returns CLI output into the active agent session and clears the bridge job', async () => {
    const broadcast = vi.fn();
    const sendMessage = vi.fn(async () => ({}));
    const appendLog = vi.fn();
    const ctrlC = vi.fn();

    vi.doMock('../routes/events.js', () => ({ broadcast }));
    vi.doMock('./ops-agent.js', () => ({
      opsAgentService: {
        sendMessage,
      },
    }));
    vi.doMock('./ops-terminals.js', () => ({
      opsTerminalManager: {
        start: vi.fn(async () => ({})),
        sendBlock: vi.fn(),
        appendLog,
        ctrlC,
      },
    }));

    const { opsBridgeService } = await import('./ops-bridge.js');
    await opsBridgeService.handoffToCli('agent:main:main', 'Patch the PTY manager');

    const returned = await opsBridgeService.returnToAgent('agent:main:main', 'Patched and verified.');
    const cancelled = opsBridgeService.cancel();

    expect(sendMessage).toHaveBeenCalledWith(
      'agent:main:main',
      'CLI coding agent update:\n\nPatched and verified.',
    );
    expect(returned.activeJob).toBeNull();
    expect(returned.recentJobs[0]?.state).toBe('returned');
    expect(appendLog).toHaveBeenCalledWith('[bridge] returned cli update -> agent:main:main');
    expect(cancelled.activeJob).toBeNull();
    expect(ctrlC).toHaveBeenCalledWith('cli');
    expect(broadcast).toHaveBeenCalledWith(
      'ops.bridge.status',
      expect.objectContaining({
        activeJob: null,
      }),
    );
  });
});
