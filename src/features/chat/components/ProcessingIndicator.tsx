import { useState, useEffect } from 'react';
import type { ProcessingStage, ActivityLogEntry } from '@/contexts/ChatContext';
import { HeartbeatPulse } from './HeartbeatPulse';
import { ThinkingDots } from './ThinkingDots';
import { ActivityLog } from './ActivityLog';
import { formatElapsed } from '../utils';
import SpinnerVerb from './SpinnerVerb';

interface ProcessingIndicatorProps {
  stage?: ProcessingStage;
  elapsedMs: number;
  lastEventTimestamp: number;
  activityLog: ActivityLogEntry[];
  isRecovering?: boolean;
  recoveryReason?: string | null;
}

/**
 * Processing status indicator shown during generation.
 *
 * Layout:
 * - Row 1: [HeartbeatPulse] [◆] [STAGE LABEL] [──] [ELAPSED] [ThinkingDots] [Spinner Verb]
 * - Activity log: scrolling feed of recent tool actions (indented)
 * - Stale warning: "Still working…" when no event for >30s
 */
export function ProcessingIndicator({
  stage,
  elapsedMs,
  lastEventTimestamp,
  activityLog,
  isRecovering = false,
  recoveryReason = null,
}: ProcessingIndicatorProps) {
  // Local timer for stale detection (1s resolution)
  // Lazy initializer avoids impure Date.now() call during render
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const secondsSinceEvent = lastEventTimestamp
    ? Math.floor((now - lastEventTimestamp) / 1000)
    : null;
  const isStale = secondsSinceEvent !== null && secondsSinceEvent > 30;

  // Get spinner verb based on current stage
  const color = stage === 'tool_use' ? 'green' : 'primary';


  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {/* Row 1: heartbeat + stage label + spinner verb + elapsed + dots */}
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 text-[0.8rem] font-semibold text-foreground">
          <HeartbeatPulse lastEventTimestamp={lastEventTimestamp} stage={stage} />
          <span className={`text-[0.667rem] ${stage === 'tool_use' ? 'text-green' : 'text-primary'}`}>◆</span>
          {stage === 'thinking' && (
            <span className="cockpit-badge animate-pulse" data-tone="primary">Thinking</span>
          )}
          {stage === 'tool_use' && (
            <span className="cockpit-badge" data-tone="success">Using tools</span>
          )}
          {(!stage || stage === 'streaming') && (
            <span className="cockpit-badge" data-tone="primary">Processing</span>
          )}
          <span className="mx-1 text-muted-foreground">──</span>
          <span className="font-mono tabular-nums text-muted-foreground">{formatElapsed(elapsedMs)}</span>
        </span>
        <SpinnerVerb stage={stage} color={color} />
        <ThinkingDots stage={stage} />
      </div>

      {/* Tool call notifications - removed, shown in ActivityLog and chat history */}


      {/* Separator: thin dotted line, only if activity log has entries */}
      {activityLog.length > 0 && (
        <div
          className="border-border"
          style={{
            borderTop: '1px dotted var(--color-border)',
            marginTop: '2px',
            marginBottom: '2px',
            marginLeft: '2rem',
          }}
        />
      )}

      {/* Activity log */}
      {activityLog.length > 0 && (
        <div style={{ paddingLeft: '2rem' }}>
          <ActivityLog entries={activityLog} />
        </div>
      )}

      {/* Recovery status */}
      {isRecovering && (
        <div
          className="text-primary text-[0.733rem]"
          style={{
            paddingLeft: '2rem',
          }}
        >
          Resyncing transcript…{recoveryReason ? ` ${recoveryReason}` : ''}
        </div>
      )}

      {/* Stale warning */}
      {isStale && (
        <div
          className="text-orange text-[0.733rem]"
          style={{
            paddingLeft: '2rem',
            animation: 'stale-pulse 2s ease-in-out infinite',
          }}
        >
          Still working… last update {secondsSinceEvent}s ago
        </div>
      )}
    </div>
  );
}
