import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('opsAgentService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers the main top-level session when present', async () => {
    const gatewayRpcCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer', agentState: 'IDLE' },
            { sessionKey: 'agent:main:main', label: 'Central', agentState: 'THINKING' },
          ],
        };
      }
      if (method === 'chat.history') {
        expect(params.sessionKey).toBe('agent:main:main');
        return {
          messages: [
            { id: 'm-1', role: 'assistant', content: 'Primary thread ready.', createdAt: '2026-03-31T10:00:00.000Z' },
          ],
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    vi.doMock('./gateway-rpc.js', () => ({ gatewayRpcCall }));
    vi.doMock('../routes/events.js', () => ({ broadcast: vi.fn() }));
    vi.doMock('./ops-terminals.js', () => ({
      opsTerminalManager: {
        appendLog: vi.fn(),
      },
    }));

    const { opsAgentService } = await import('./ops-agent.js');
    const session = await opsAgentService.ensureSession();

    expect(session.id).toBe('agent:main:main');
    expect(session.label).toBe('Central');
    expect(session.status).toBe('THINKING');
    expect(session.history).toEqual([
      expect.objectContaining({
        role: 'assistant',
        text: 'Primary thread ready.',
      }),
    ]);
  });

  it('falls back to another top-level root and flattens structured history', async () => {
    const gatewayRpcCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.list') {
        return {
          sessions: [
            { sessionKey: 'agent:reviewer:main', label: 'Reviewer', state: 'IDLE' },
          ],
        };
      }
      if (method === 'chat.history') {
        expect(params.sessionKey).toBe('agent:reviewer:main');
        return {
          messages: [
            {
              id: 'm-2',
              role: 'tool',
              content: [
                { text: 'Inspected:' },
                { name: 'auth.ts' },
                { input: { outcome: 'ok' } },
              ],
              timestamp: 1711893600000,
            },
          ],
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });

    vi.doMock('./gateway-rpc.js', () => ({ gatewayRpcCall }));
    vi.doMock('../routes/events.js', () => ({ broadcast: vi.fn() }));
    vi.doMock('./ops-terminals.js', () => ({
      opsTerminalManager: {
        appendLog: vi.fn(),
      },
    }));

    const { opsAgentService } = await import('./ops-agent.js');
    const session = await opsAgentService.ensureSession();

    expect(session.id).toBe('agent:reviewer:main');
    expect(session.label).toBe('Reviewer');
    expect(session.history[0]).toEqual(
      expect.objectContaining({
        role: 'tool',
        text: expect.stringContaining('Inspected:\nauth.ts'),
      }),
    );
    expect(session.history[0]?.createdAt).toBe('2024-03-31T14:00:00.000Z');
  });
});
