import { useMemo, useState } from 'react';
import { Ban, CornerUpLeft, LoaderCircle, Send } from 'lucide-react';
import type { BridgeStatus } from './api';

interface BridgeWorkflowPanelProps {
  bridge: BridgeStatus;
  sessionId: string | null;
  assistantSeed: string;
  busyAction: 'handoff' | 'return' | 'cancel' | null;
  onHandoff: (prompt: string, context: string) => Promise<void>;
  onReturn: (sessionId: string, text: string) => Promise<void>;
  onCancel: () => Promise<void>;
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleTimeString();
}

export default function BridgeWorkflowPanel({
  bridge,
  sessionId,
  assistantSeed,
  busyAction,
  onHandoff,
  onReturn,
  onCancel,
}: BridgeWorkflowPanelProps) {
  const [handoffPrompt, setHandoffPrompt] = useState('');
  const [handoffContext, setHandoffContext] = useState('');
  const [returnText, setReturnText] = useState('');

  const activeSessionId = bridge.activeJob?.sessionId ?? sessionId;
  const isBusy = busyAction !== null;
  const isBridgeActive = Boolean(bridge.activeJob);

  const effectiveContext = useMemo(() => {
    const explicitContext = handoffContext.trim();
    if (explicitContext) return explicitContext;
    return assistantSeed.trim();
  }, [assistantSeed, handoffContext]);

  const submitHandoff = async () => {
    if (!sessionId || !handoffPrompt.trim() || isBusy) return;
    await onHandoff(handoffPrompt.trim(), effectiveContext);
    setHandoffPrompt('');
  };

  const submitReturn = async () => {
    if (!activeSessionId || !returnText.trim() || isBusy) return;
    await onReturn(activeSessionId, returnText.trim());
    setReturnText('');
  };

  return (
    <div className="ops-bridge-workflow">
      <div className="ops-bridge-status">
        <span className="ops-terminal-desc">
          Active bridge job:{' '}
          {bridge.activeJob ? `${bridge.activeJob.id} (${bridge.activeJob.state})` : 'none'}
        </span>
        <span className="ops-terminal-desc">
          {bridge.activeJob ? `Session: ${bridge.activeJob.sessionId}` : 'No active CLI handoff'}
        </span>
      </div>

      <div className="ops-bridge-grid">
        <div className="ops-bridge-form">
          <h3>Handoff to CLI</h3>
          <textarea
            className="ops-textarea"
            value={handoffPrompt}
            onChange={(event) => setHandoffPrompt(event.target.value)}
            placeholder="Describe the implementation task for the CLI coding agent..."
            disabled={!sessionId || isBusy}
          />
          <textarea
            className="ops-textarea"
            value={handoffContext}
            onChange={(event) => setHandoffContext(event.target.value)}
            placeholder="Optional context (latest assistant message will be used when this is empty)"
            disabled={!sessionId || isBusy}
          />
          <button
            type="button"
            className="ops-button primary"
            onClick={() => { void submitHandoff().catch(() => {}); }}
            disabled={!sessionId || !handoffPrompt.trim() || isBusy}
          >
            {busyAction === 'handoff' ? <LoaderCircle className="spinning" size={14} /> : <Send size={14} />}
            Handoff to CLI
          </button>
        </div>

        <div className="ops-bridge-form">
          <h3>Return to Agent</h3>
          <textarea
            className="ops-textarea"
            value={returnText}
            onChange={(event) => setReturnText(event.target.value)}
            placeholder="Paste CLI output summary, blockers, and next step to return to the central agent..."
            disabled={!activeSessionId || isBusy}
          />
          <div className="ops-action-row">
            <button
              type="button"
              className="ops-button primary"
              onClick={() => { void submitReturn().catch(() => {}); }}
              disabled={!activeSessionId || !returnText.trim() || isBusy}
            >
              {busyAction === 'return' ? <LoaderCircle className="spinning" size={14} /> : <CornerUpLeft size={14} />}
              Return to Agent
            </button>
            <button
              type="button"
              className="ops-button ghost"
              onClick={() => { void onCancel().catch(() => {}); }}
              disabled={!isBridgeActive || isBusy}
            >
              {busyAction === 'cancel' ? <LoaderCircle className="spinning" size={14} /> : <Ban size={14} />}
              Cancel Bridge
            </button>
          </div>
        </div>
      </div>

      <div className="ops-bridge-history">
        <h3>Recent Bridge Jobs</h3>
        {bridge.recentJobs.length === 0 ? (
          <div className="ops-helper">No bridge jobs yet.</div>
        ) : (
          <div className="ops-list">
            {bridge.recentJobs.map((job) => (
              <div key={job.id} className="ops-list-card" data-active={bridge.activeJob?.id === job.id}>
                <strong>{job.id}</strong>
                <small>
                  {job.state} · {job.sessionId} · updated {formatWhen(job.updatedAt)}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
