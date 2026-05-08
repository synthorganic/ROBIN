import { Hono } from 'hono';
import { opsBridgeService } from '../lib/ops-bridge.js';

const app = new Hono();

app.get('/api/bridge/status', async (c) => c.json({ ok: true, ...opsBridgeService.status() }));

app.post('/api/bridge/handoff-to-cli', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as {
      sessionId?: string;
      prompt?: string;
      context?: string;
    };

    if (!body.sessionId?.trim() || !body.prompt?.trim()) {
      return c.json({ ok: false, error: 'sessionId and prompt are required' }, 400);
    }

    const status = await opsBridgeService.handoffToCli(body.sessionId.trim(), body.prompt.trim(), body.context ?? '');
    return c.json({ ok: true, ...status });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.post('/api/bridge/return-to-agent', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as {
      sessionId?: string;
      text?: string;
    };

    if (!body.sessionId?.trim() || !body.text?.trim()) {
      return c.json({ ok: false, error: 'sessionId and text are required' }, 400);
    }

    const status = await opsBridgeService.returnToAgent(body.sessionId.trim(), body.text.trim());
    return c.json({ ok: true, ...status });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 503);
  }
});

app.post('/api/bridge/cancel', async (c) => c.json({ ok: true, ...opsBridgeService.cancel() }));

export default app;
