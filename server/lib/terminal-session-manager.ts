/**
 * Terminal Session Manager for ROBIN Ops Agent
 * Simplified session management for PTY-based terminal sessions
 */

import { spawn, type IPty } from 'node-pty';
import { ScrollbackBuffer } from './scrollback-buffer.js';
import type { WebSocket } from 'ws';

export interface SessionInfo {
  token: string;
  userId: string;
  createdAt: Date;
  lastActive: Date;
  alive: boolean;
}

export interface StoredSession {
  token: string;
  userId: string;
  pty: IPty | null;
  scrollback: ScrollbackBuffer;
  ws: WebSocket | null;
  createdAt: Date;
  lastActive: Date;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_GRACE_MS = 5 * 60_000;
const DEFAULT_SCROLLBACK_BYTES = 100 * 1024;

class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private readonly gracePeriodMs: number;
  private readonly scrollbackBytes: number;

  get sessionsMap(): Map<string, StoredSession> {
    return this.sessions;
  }

  constructor(
    gracePeriodMs = DEFAULT_GRACE_MS,
    scrollbackBytes = DEFAULT_SCROLLBACK_BYTES,
  ) {
    this.gracePeriodMs = gracePeriodMs;
    this.scrollbackBytes = scrollbackBytes;
  }

  get size(): number {
    return this.sessions.size;
  }

  register(pty: IPty | null, userId = 'default'): StoredSession {
    const token = crypto.randomUUID();
    const session: StoredSession = {
      token,
      userId,
      pty,
      scrollback: new ScrollbackBuffer(this.scrollbackBytes),
      ws: null,
      createdAt: new Date(),
      lastActive: new Date(),
      graceTimer: null,
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token: string): StoredSession | undefined {
    return this.sessions.get(token);
  }

  reattach(token: string, ws: WebSocket): StoredSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    session.ws = ws;
    session.lastActive = new Date();
    return session;
  }

  startGrace(token: string, onExpire: () => void): void {
    const session = this.sessions.get(token);
    if (!session) return;

    session.ws = null;
    session.lastActive = new Date();

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
    }

    session.graceTimer = setTimeout(() => {
      session.graceTimer = null;
      this.destroy(token);
      onExpire();
    }, this.gracePeriodMs);
  }

  destroy(token: string): void {
    const session = this.sessions.get(token);
    if (!session) return;

    this.sessions.delete(token);

    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }

    if (session.ws) {
      try { session.ws.close(1000, 'Session destroyed'); } catch {}
    }

    if (session.pty) {
      try {
        session.pty.kill('SIGHUP');
      } catch {}
      setTimeout(() => {
        try {
          session.pty?.kill('SIGKILL');
        } catch {}
      }, 5000);
    }
  }

  destroyAll(): void {
    for (const token of [...this.sessions.keys()]) {
      this.destroy(token);
    }
  }
}

export class SessionManager {
  private store: SessionStore;
  private maxSessions: number;
  private maxSessionsPerUser: number;
  private spawnPty: (cols: number, rows: number) => IPty | null;
  private wiredPtys = new Set<string>();

  constructor(
    maxSessions: number,
    spawnPty: (cols: number, rows: number) => IPty | null,
    gracePeriodMs?: number,
    scrollbackBytes?: number,
    maxSessionsPerUser?: number,
  ) {
    this.maxSessions = maxSessions;
    this.maxSessionsPerUser = maxSessionsPerUser ?? maxSessions;
    this.spawnPty = spawnPty;
    this.store = new SessionStore(gracePeriodMs, scrollbackBytes);
  }

  get activeCount(): number {
    return this.store.size;
  }

  get isFull(): boolean {
    return this.store.size >= this.maxSessions;
  }

  getSession(token: string) {
    return this.store.get(token);
  }

  listSessions(): Array<{ token: string; userId: string; createdAt: string }> {
    const result = [];
    for (const [token, session] of this.store.sessionsMap) {
      if (session) {
        result.push({
          token,
          userId: session.userId,
          createdAt: session.createdAt.toISOString(),
        });
      }
    }
    return result;
  }

  create(ws: WebSocket, cols = 80, rows = 24): string | null {
    if (this.isFull) return null;

    let pty: IPty | null;
    try {
      pty = this.spawnPty(cols, rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown PTY spawn error';
      return null;
    }

    if (!pty) return null;

    const session = this.store.register(pty, 'default');
    session.ws = ws;
    const { token } = session;

    this.wirePtyEvents(token, pty);
    this.wireWsEvents(token, ws, pty);

    return token;
  }

  resume(token: string, ws: WebSocket, cols: number, rows: number): boolean {
    const session = this.store.reattach(token, ws);
    if (!session) return false;
    if (!session.pty) return false;

    ws.send(JSON.stringify({ type: 'resumed', token }));

    const scrollback = session.scrollback.read();
    if (scrollback.length > 0) {
      ws.send(scrollback);
    }

    try {
      session.pty.resize(cols, rows);
    } catch {}

    this.wireWsEvents(token, ws, session.pty);
    return true;
  }

  wirePtyEvents(token: string, pty: IPty): void {
    if (this.wiredPtys.has(token)) return;
    this.wiredPtys.add(token);

    const session = this.store.get(token);
    if (!session) return;

    pty.onData((data) => {
      session.scrollback.write(data);
      const ws = session.ws;
      if (ws && ws.readyState === 1) {
        ws.send(data);
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      this.wiredPtys.delete(token);
      const ws = session.ws;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
        ws.close(1000, 'PTY exited');
      }
      this.store.destroy(token);
    });
  }

  wireWsEvents(token: string, ws: WebSocket, pty: IPty): void {
    ws.on('message', (data: Buffer | string) => {
      const str = (data as Buffer | string).toString();
      if (str.startsWith('{')) {
        try {
          const msg = JSON.parse(str);
          if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            pty.resize(msg.cols, msg.rows);
            return;
          }
          if (msg.type === 'ping') {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
        } catch {}
      }
      pty.write(str);
    });

    const handleClose = () => {
      const session = this.store.get(token);
      if (session && session.ws === ws) {
        this.store.startGrace(token, () => {});
      }
    };

    ws.on('close', handleClose);
    ws.on('error', (err: Error) => {
      console.error('[terminal-session-manager] WebSocket error:', err.message);
    });
  }

  destroySession(token: string): void {
    this.store.destroy(token);
  }

  destroyAll(): void {
    this.store.destroyAll();
  }
}
