import { Hono } from 'hono';
import { opsTerminalManager } from '../lib/ops-terminals.js';
const app = new Hono();
function parseTerminalId(id) {
    if (id === 'cli' || id === 'support' || id === 'logs')
        return id;
    throw new Error(`Unknown terminal '${id}'`);
}
app.get('/api/terminals', async (c) => c.json({ ok: true, terminals: opsTerminalManager.list() }));
app.get('/api/terminals/:id/status', async (c) => {
    try {
        return c.json({ ok: true, terminal: opsTerminalManager.status(parseTerminalId(c.req.param('id'))) });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 404);
    }
});
app.post('/api/terminals/:id/start', async (c) => {
    try {
        return c.json({ ok: true, terminal: opsTerminalManager.start(parseTerminalId(c.req.param('id'))) });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
    }
});
app.post('/api/terminals/:id/stop', async (c) => {
    try {
        return c.json({ ok: true, terminal: opsTerminalManager.stop(parseTerminalId(c.req.param('id'))) });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
    }
});
app.post('/api/terminals/:id/write', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
        return c.json({
            ok: true,
            terminal: opsTerminalManager.write(parseTerminalId(c.req.param('id')), body.input ?? ''),
        });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
    }
});
app.post('/api/terminals/:id/resize', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
        return c.json({
            ok: true,
            terminal: opsTerminalManager.resize(parseTerminalId(c.req.param('id')), Number(body.cols) || 120, Number(body.rows) || 28),
        });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
    }
});
app.post('/api/terminals/:id/ctrl-c', async (c) => {
    try {
        const id = parseTerminalId(c.req.param('id'));
        if (id === 'logs') {
            return c.json({ ok: false, error: 'Logs pane is read-only' }, 400);
        }
        return c.json({ ok: true, terminal: opsTerminalManager.ctrlC(id) });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 400);
    }
});
export default app;
