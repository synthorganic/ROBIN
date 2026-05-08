/**
 * Shared Chat API Routes
 *
 * Provides HTTP endpoints for participants to interact with the shared chat.
 */
import { Hono } from 'hono';
import { sharedChatService } from '../lib/shared-chat.js';
const app = new Hono();
// ── Status endpoint ─────────────────────────────────────────────────
app.get('/api/shared-chat/status', async (c) => {
    const stats = sharedChatService.getStats();
    return c.json({
        ok: true,
        ...stats,
    });
});
// ── Get messages ────────────────────────────────────────────────────
app.get('/api/shared-chat/messages', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = Number(c.req.query('offset') ?? 0);
    const participantId = c.req.query('participantId');
    const participantType = c.req.query('participantType');
    const messages = sharedChatService.getMessages({
        limit,
        offset,
        participantId: participantId?.trim() || undefined,
        participantType: participantType?.trim(),
    });
    return c.json({
        ok: true,
        messages,
        total: sharedChatService.getStats().totalMessages,
    });
});
// ── Add message ─────────────────────────────────────────────────────
app.post('/api/shared-chat/messages', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { participantId, content, participantName, type = 'text', metadata, parentId } = body;
    if (!content?.trim()) {
        return c.json({ ok: false, error: 'Message content is required' }, 400);
    }
    // Use participantId as name if not provided
    const name = participantName || participantId;
    const message = await sharedChatService.addMessage({
        participantId,
        participantName: name,
        content: content.trim(),
        type,
        metadata,
        parentId,
    });
    return c.json({
        ok: true,
        message,
    });
});
// ── Register participant ────────────────────────────────────────────
app.post('/api/shared-chat/participants', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
        await sharedChatService.registerParticipant({
            id: body.id,
            name: body.name,
            type: body.type || 'user',
            metadata: body.metadata,
        });
        return c.json({
            ok: true,
            status: 'participant-registered',
            participantId: body.id,
        });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 503);
    }
});
// ── Unregister participant ──────────────────────────────────────────
app.delete('/api/shared-chat/participants/:participantId', async (c) => {
    const participantId = c.req.param('participantId');
    try {
        await sharedChatService.unregisterParticipant(participantId);
        return c.json({
            ok: true,
            status: 'participant-unregistered',
            participantId,
        });
    }
    catch (error) {
        return c.json({ ok: false, error: error.message }, 503);
    }
});
// ── Get participants ────────────────────────────────────────────────
app.get('/api/shared-chat/participants', async (c) => {
    const participants = sharedChatService.getParticipants();
    return c.json({
        ok: true,
        participants: [...participants.values()],
        total: participants.size,
    });
});
export default app;
