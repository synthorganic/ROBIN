import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BridgeWorkflowPanel from './BridgeWorkflowPanel';
import type { BridgeStatus } from './api';

function buildBridgeStatus(overrides?: Partial<BridgeStatus>): BridgeStatus {
  return {
    activeJob: null,
    recentJobs: [],
    ...overrides,
  };
}

describe('BridgeWorkflowPanel', () => {
  it('hands work off to CLI and falls back to assistant seed as context', async () => {
    const onHandoff = vi.fn(async () => {});
    const onReturn = vi.fn(async () => {});
    const onCancel = vi.fn(async () => {});

    render(
      <BridgeWorkflowPanel
        bridge={buildBridgeStatus()}
        sessionId="agent:main:main"
        assistantSeed="Most recent assistant response"
        busyAction={null}
        onHandoff={onHandoff}
        onReturn={onReturn}
        onCancel={onCancel}
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText('Describe the implementation task for the CLI coding agent...'),
      { target: { value: 'Refactor the terminal manager' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Handoff to CLI' }));

    await waitFor(() => {
      expect(onHandoff).toHaveBeenCalledWith(
        'Refactor the terminal manager',
        'Most recent assistant response',
      );
    });
  });

  it('returns CLI output to the active bridge session', async () => {
    const onHandoff = vi.fn(async () => {});
    const onReturn = vi.fn(async () => {});
    const onCancel = vi.fn(async () => {});

    render(
      <BridgeWorkflowPanel
        bridge={buildBridgeStatus({
          activeJob: {
            id: 'bridge-123',
            sessionId: 'agent:main:main',
            targetTerminalId: 'cli',
            state: 'sent',
            prompt: 'Fix workspace switch',
            transcriptRef: 'cli:agent:main:main',
            createdAt: '2026-04-19T10:00:00.000Z',
            updatedAt: '2026-04-19T10:01:00.000Z',
          },
        })}
        sessionId="agent:reviewer:main"
        assistantSeed=""
        busyAction={null}
        onHandoff={onHandoff}
        onReturn={onReturn}
        onCancel={onCancel}
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText('Paste CLI output summary, blockers, and next step to return to the central agent...'),
      { target: { value: 'Done. Tests are passing.' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Return to Agent' }));

    await waitFor(() => {
      expect(onReturn).toHaveBeenCalledWith('agent:main:main', 'Done. Tests are passing.');
    });
  });

  it('renders recent bridge jobs and exposes cancel for active handoffs', async () => {
    const onHandoff = vi.fn(async () => {});
    const onReturn = vi.fn(async () => {});
    const onCancel = vi.fn(async () => {});

    render(
      <BridgeWorkflowPanel
        bridge={buildBridgeStatus({
          activeJob: {
            id: 'bridge-123',
            sessionId: 'agent:main:main',
            targetTerminalId: 'cli',
            state: 'sent',
            prompt: 'Fix workspace switch',
            transcriptRef: 'cli:agent:main:main',
            createdAt: '2026-04-19T10:00:00.000Z',
            updatedAt: '2026-04-19T10:01:00.000Z',
          },
          recentJobs: [
            {
              id: 'bridge-123',
              sessionId: 'agent:main:main',
              targetTerminalId: 'cli',
              state: 'sent',
              prompt: 'Fix workspace switch',
              transcriptRef: 'cli:agent:main:main',
              createdAt: '2026-04-19T10:00:00.000Z',
              updatedAt: '2026-04-19T10:01:00.000Z',
            },
          ],
        })}
        sessionId="agent:main:main"
        assistantSeed=""
        busyAction={null}
        onHandoff={onHandoff}
        onReturn={onReturn}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText('Recent Bridge Jobs')).toBeInTheDocument();
    expect(screen.getByText('bridge-123')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Bridge' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
