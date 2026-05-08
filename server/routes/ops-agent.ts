import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { broadcaster, type SSEEvent } from './events.js';
import { opsAgentService } from '../lib/ops-agent.js';

const app = new Hono();

app.post('/api/agent/session', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { sessionKey?: string };
    const session = await opsAgentService.ensureSession(body.sessionKey);
    return c.json({ ok: true, session });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.get('/api/agent/session/:id', async (c) => {
  try {
    const session = await opsAgentService.getSession(c.req.param('id'));
    return c.json({ ok: true, session });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.get('/api/agent/session/:id/history', async (c) => {
  try {
    const history = await opsAgentService.getHistory(c.req.param('id'));
    return c.json({ ok: true, history });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.post('/api/agent/session/:id/message', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as { text?: string };
    if (!body.text?.trim()) {
      return c.json({ ok: false, error: 'Message text is required' }, 400);
    }

    const session = await opsAgentService.sendMessage(c.req.param('id'), body.text.trim());
    return c.json({ ok: true, session });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.post('/api/agent/session/:id/abort', async (c) => {
  try {
    await opsAgentService.abort(c.req.param('id'));
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.get('/api/agent/session/:id/stream', async (c) => {
  const sessionKey = c.req.param('id');
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    let connected = true;
    let resolveDisconnect: (() => void) | undefined;

    const onMessage = (payload: SSEEvent) => {
      if (!connected) return;
      const data = payload.data as Record<string, unknown> | undefined;
      if (!payload.event.startsWith('ops.agent.') || data?.sessionKey !== sessionKey) return;

      try {
        stream.writeSSE({
          event: payload.event,
          data: JSON.stringify(payload),
        });
      } catch {
        disconnect();
      }
    };

    function disconnect() {
      if (!connected) return;
      connected = false;
      broadcaster.off('message', onMessage);
      resolveDisconnect?.();
    }

    broadcaster.on('message', onMessage);
    await stream.writeSSE({
      event: 'ops.agent.connected',
      data: JSON.stringify({ event: 'ops.agent.connected', data: { sessionKey }, ts: Date.now() }),
    });

    stream.onAbort(() => disconnect());
    await new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
  });
});

export default app;
