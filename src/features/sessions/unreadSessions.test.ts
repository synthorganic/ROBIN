/**
 * unreadSessions.test.ts — Tests for unread session indicator logic.
 * Validates that unread state is set on subagent DONE and cleared on session select.
 */
import { describe, it, expect } from 'vitest';

// Test the pure logic that SessionContext uses for unread tracking.
// We extract the logic into testable helpers to avoid needing full React context rendering.

/** Simulates adding a session key to the unread set (mirrors setUnreadSessionKeys logic) */
function addUnread(set: Set<string>, sessionKey: string, currentSession: string): Set<string> {
  if (!sessionKey.includes('subagent')) return set;
  if (currentSession === sessionKey) return set;
  if (set.has(sessionKey)) return set;
  const next = new Set(set);
  next.add(sessionKey);
  return next;
}

/** Simulates removing a session key from the unread set (mirrors markSessionRead logic) */
function removeUnread(set: Set<string>, key: string): Set<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

/** Converts Set to Record<string, boolean> (mirrors unreadSessions memo) */
function toRecord(set: Set<string>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const key of set) {
    result[key] = true;
  }
  return result;
}

describe('unread sessions logic', () => {
  const subagentKey = 'agent:main:subagent:abc123';
  const mainKey = 'agent:main:main';

  it('marks subagent as unread on DONE when not currently viewing', () => {
    const set = new Set<string>();
    const result = addUnread(set, subagentKey, mainKey);
    expect(result.has(subagentKey)).toBe(true);
  });

  it('does not mark subagent as unread if currently viewing it', () => {
    const set = new Set<string>();
    const result = addUnread(set, subagentKey, subagentKey);
    expect(result).toBe(set); // same reference — no change
  });

  it('does not mark main session as unread', () => {
    const set = new Set<string>();
    const result = addUnread(set, mainKey, 'some:other:session');
    expect(result).toBe(set); // same reference — no change
  });

  it('does not duplicate if already unread', () => {
    const set = new Set<string>([subagentKey]);
    const result = addUnread(set, subagentKey, mainKey);
    expect(result).toBe(set); // same reference — no change
  });

  it('clears unread when session is selected (markSessionRead)', () => {
    const set = new Set<string>([subagentKey]);
    const result = removeUnread(set, subagentKey);
    expect(result.has(subagentKey)).toBe(false);
  });

  it('returns same set reference if key not in unread (no-op)', () => {
    const set = new Set<string>();
    const result = removeUnread(set, subagentKey);
    expect(result).toBe(set);
  });

  it('converts unread set to record correctly', () => {
    const set = new Set<string>([subagentKey, 'agent:main:subagent:def456']);
    const record = toRecord(set);
    expect(record).toEqual({
      [subagentKey]: true,
      'agent:main:subagent:def456': true,
    });
  });

  it('converts empty set to empty record', () => {
    const record = toRecord(new Set());
    expect(record).toEqual({});
  });

  it('full lifecycle: mark unread → select → cleared', () => {
    let set = new Set<string>();

    // Subagent finishes while viewing main
    set = addUnread(set, subagentKey, mainKey);
    expect(toRecord(set)[subagentKey]).toBe(true);

    // User clicks into the subagent
    set = removeUnread(set, subagentKey);
    expect(toRecord(set)[subagentKey]).toBeUndefined();
  });
});
