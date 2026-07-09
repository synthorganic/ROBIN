import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('opsAgentService local streaming', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('broadcasts assistant deltas and tool results into local session history', async () => {
    const broadcast = vi.fn();
    const appendLog = vi.fn();
    let completionCallCount = 0;
    const createChatCompletion = vi.fn(async ({ onChunk }: { onChunk?: (content: string) => void }) => {
      completionCallCount += 1;
      if (completionCallCount === 1) {
        onChunk?.('Working');
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'tool-1',
                    type: 'function',
                    function: {
                      name: 'powershell',
                      arguments: '{"command":"Get-Date"}',
                    },
                  },
                ],
              },
            },
          ],
        };
      }

      onChunk?.('Done');
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Done',
            },
          },
        ],
      };
    });

    vi.doMock('./gateway-rpc.js', () => ({ gatewayRpcCall: vi.fn() }));
    vi.doMock('../routes/events.js', () => ({ broadcast }));
    vi.doMock('./ops-terminals.js', () => ({
      opsTerminalManager: {
        appendLog,
      },
    }));
    vi.doMock('./lmstudio-service.js', () => ({
      lmStudioService: {
        createChatCompletion,
      },
    }));
    vi.doMock('./ops-documents.js', () => ({
      opsDocumentStore: {
        agentContext: vi.fn(async () => ''),
      },
    }));
    vi.doMock('./ops-agent-tool-catalog.js', () => ({
      buildOpsAgentToolContext: vi.fn(async () => ''),
    }));
    vi.doMock('./config.js', () => ({
      config: {
        gatewayUrl: 'http://127.0.0.1:18789',
        gatewayToken: '',
        home: 'C:\\Users\\benmc',
      },
    }));

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { output: '2026-07-07T12:00:00Z' } }),
    })));

    const { opsAgentService } = await import('./ops-agent.js');
    const snapshot = await opsAgentService.sendMessage('local:ops:main', 'What time is it?', { transport: 'local' });

    expect(broadcast).toHaveBeenCalledWith('ops.agent.status', expect.objectContaining({
      sessionKey: 'local:ops:main',
      status: 'streaming',
    }));

    expect(broadcast).toHaveBeenCalledWith('ops.agent.status', expect.objectContaining({
      sessionKey: 'local:ops:main',
      status: 'tool_use',
    }));

    expect(broadcast).toHaveBeenCalledWith('ops.agent.history', expect.objectContaining({
      sessionKey: 'local:ops:main',
      history: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          text: 'Working',
          tool_call_phase: 'request',
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ name: 'powershell' }),
          ]),
        }),
      ]),
    }));

    expect(broadcast).toHaveBeenCalledWith('ops.agent.history', expect.objectContaining({
      sessionKey: 'local:ops:main',
      history: expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          text: '2026-07-07T12:00:00Z',
          tool_call_phase: 'result',
          toolCalls: expect.arrayContaining([
            expect.objectContaining({ name: 'powershell' }),
          ]),
        }),
      ]),
    }));

    expect(snapshot.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', text: 'Working' }),
      expect.objectContaining({ role: 'tool', text: '2026-07-07T12:00:00Z' }),
      expect.objectContaining({ role: 'assistant', text: 'Done' }),
    ]));
  });
});
