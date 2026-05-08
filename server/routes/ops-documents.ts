import { Hono } from 'hono';
import { opsDocumentStore } from '../lib/ops-documents.js';

const app = new Hono();

app.get('/api/documents', async (c) => {
  const documents = await opsDocumentStore.list();
  return c.json({ ok: true, documents });
});

app.post('/api/documents/upload', async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) {
      return c.json({ ok: false, error: 'Document file is required' }, 400);
    }

    const project = typeof body.project === 'string' ? body.project : 'General';
    const title = typeof body.title === 'string' ? body.title : file.name;
    const buffer = Buffer.from(await file.arrayBuffer());
    const document = await opsDocumentStore.create({
      project,
      title,
      fileName: file.name || title || 'document',
      mimeType: file.type || 'application/octet-stream',
      buffer,
    });
    return c.json({ ok: true, document, documents: await opsDocumentStore.list() });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 500);
  }
});

app.get('/api/documents/:id/download', async (c) => {
  const content = await opsDocumentStore.content(c.req.param('id'));
  if (!content) {
    return c.json({ ok: false, error: 'Document not found' }, 404);
  }

  return new Response(content.buffer, {
    headers: {
      'Content-Type': content.record.mimeType || 'application/octet-stream',
      'Content-Length': String(content.size),
      'Content-Disposition': `attachment; filename="${content.record.fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'no-cache',
    },
  });
});

app.delete('/api/documents/:id', async (c) => {
  try {
    await opsDocumentStore.remove(c.req.param('id'));
    return c.json({ ok: true, documents: await opsDocumentStore.list() });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message }, 404);
  }
});

export default app;
