/**
 * useLimits — Hook for polling Codex and Robin-Ops rate limits.
 *
 * Fetches limits every 60s with graceful handling of unavailable services.
 */

import { useState, useEffect } from 'react';

// ── Limits types ─────────────────────────────────────────────────────

export interface LimitEntry {
  used_percent: number;
  left_percent: number;
}

export interface CodexLimitEntry extends LimitEntry {
  resets_at: number | null; // epoch seconds
  resets_at_formatted: string | null; // legacy
}

export interface CodexLimits {
  available: boolean;
  five_hour_limit?: CodexLimitEntry;
  weekly_limit?: CodexLimitEntry;
}

export interface RobinOpsLimitEntry extends LimitEntry {
  resets_at_epoch: number | null; // epoch ms (normalised server-side)
  resets_at_raw: string;          // original string as fallback
}

export interface RobinOpsLimits {
  available: boolean;
  session_limit?: RobinOpsLimitEntry;
  weekly_limit?: RobinOpsLimitEntry;
}

export interface UseLimitsReturn {
  codexLimits: CodexLimits | null;
  robinOpsLimits: RobinOpsLimits | null;
  codexLastChecked: number | null;
  robinOpsLastChecked: number | null;
}

const POLL_INTERVAL_MS = 60_000;
const GRACE_MS = 60_000; // keep loading state for 60s before showing "unavailable"

/** Hook to fetch and expose rate-limit / usage data from the gateway. */
export function useLimits(): UseLimitsReturn {
  const [codexLimits, setCodexLimits] = useState<CodexLimits | null>(null);
  const [robinOpsLimits, setRobinOpsLimits] = useState<RobinOpsLimits | null>(null);
  const [codexLastChecked, setCodexLastChecked] = useState<number | null>(null);
  const [robinOpsLastChecked, setRobinOpsLastChecked] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    async function fetchCodex() {
      try {
        const res = await fetch('/api/codex-limits');
        const json = (await res.json()) as CodexLimits;
        if (!cancelled && json.available) {
          setCodexLimits(json);
          setCodexLastChecked(Date.now());
        } else if (!cancelled) {
          setCodexLimits((prev) => prev ?? { available: false });
        }
      } catch {
        if (!cancelled) setCodexLimits((prev) => prev ?? { available: false });
      }
    }

    async function fetchRobinOps() {
      try {
        const res = await fetch('/api/robin-ops-limits');
        const json = (await res.json()) as RobinOpsLimits;
        if (!cancelled) {
          if (json.available) {
            setRobinOpsLimits(json);
            setRobinOpsLastChecked(Date.now());
          } else {
            setRobinOpsLimits((prev) => {
              if (prev?.available) return prev; // preserve good data
              if (Date.now() - startedAt < GRACE_MS) return prev; // stay in loading state
              return { available: false };
            });
          }
        }
      } catch {
        if (!cancelled) setRobinOpsLimits((prev) => prev ?? (Date.now() - startedAt < GRACE_MS ? null : { available: false }));
      }
    }

    fetchCodex();
    fetchRobinOps();

    const id = setInterval(() => {
      fetchCodex();
      fetchRobinOps();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { codexLimits, robinOpsLimits, codexLastChecked, robinOpsLastChecked };
}
