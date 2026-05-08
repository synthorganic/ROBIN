import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { broadcast } from '../routes/events.js';

export interface OpsDocumentRecord {
  id: string;
  project: string;
  title: string;
  fileName: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  storagePath: string;
  sourceUrl: string;
  uploadedAt: string;
  textPreview?: string;
}

interface OpsDocumentStoreShape {
  documents: OpsDocumentRecord[];
}

const STORE_DIR = path.join(config.home, '.nerve', 'inertiai-ops');
const DOCUMENT_DIR = path.join(STORE_DIR, 'documents');
const STORE_FILE = path.join(STORE_DIR, 'documents.json');
const TEXT_PREVIEW_LIMIT = 4000;

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.rtf',
]);

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProject(value: unknown) {
  return normalizeString(value) || 'General';
}

function sanitizeSegment(value: string) {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return cleaned || 'general';
}

function sanitizeFileName(value: string) {
  const base = path.basename(value || 'document');
  const cleaned = Array.from(base)
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char))
    .join('')
    .trim();
  return cleaned || 'document';
}

function normalizeKind(fileName: string, mimeType: string) {
  const ext = path.extname(fileName).replace('.', '').toLowerCase();
  if (ext) return ext;
  if (mimeType.includes('/')) return mimeType.split('/').pop()?.toLowerCase() || 'file';
  return mimeType || 'file';
}

function isTextLike(fileName: string, mimeType: string) {
  const ext = path.extname(fileName).toLowerCase();
  return mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext);
}

function buildPreview(buffer: Buffer, fileName: string, mimeType: string) {
  if (!isTextLike(fileName, mimeType)) return undefined;
  const text = buffer.toString('utf8').split('\0').join('').trim();
  if (!text) return undefined;
  return text.slice(0, TEXT_PREVIEW_LIMIT);
}

function normalizeRecord(value: unknown): OpsDocumentRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = normalizeString(record.id);
  const title = normalizeString(record.title);
  const fileName = normalizeString(record.fileName);
  const storagePath = normalizeString(record.storagePath);
  if (!id || !title || !fileName || !storagePath) return null;

  return {
    id,
    project: normalizeProject(record.project),
    title,
    fileName,
    mimeType: normalizeString(record.mimeType) || 'application/octet-stream',
    kind: normalizeString(record.kind) || normalizeKind(fileName, normalizeString(record.mimeType)),
    sizeBytes: Number(record.sizeBytes) || 0,
    storagePath,
    sourceUrl: normalizeString(record.sourceUrl) || `/api/documents/${encodeURIComponent(id)}/download`,
    uploadedAt: normalizeString(record.uploadedAt) || new Date().toISOString(),
    textPreview: normalizeString(record.textPreview) || undefined,
  };
}

function normalizeStore(value: unknown): OpsDocumentStoreShape {
  if (!value || typeof value !== 'object') return { documents: [] };
  const record = value as Record<string, unknown>;
  const documents = Array.isArray(record.documents)
    ? record.documents
      .map((item) => normalizeRecord(item))
      .filter((item): item is OpsDocumentRecord => Boolean(item))
    : [];
  return { documents: sortDocuments(documents) };
}

function sortDocuments(documents: OpsDocumentRecord[]) {
  return [...documents].sort((left, right) => (
    left.project.localeCompare(right.project)
    || right.uploadedAt.localeCompare(left.uploadedAt)
    || left.title.localeCompare(right.title)
  ));
}

class OpsDocumentStore {
  private cache: OpsDocumentStoreShape | null = null;

  async list() {
    const store = await this.read();
    return sortDocuments(store.documents);
  }

  async create(input: {
    project?: string;
    title?: string;
    fileName: string;
    mimeType?: string;
    buffer: Buffer;
  }) {
    const store = await this.read();
    const id = `doc-${randomUUID().slice(0, 10)}`;
    const project = normalizeProject(input.project);
    const fileName = sanitizeFileName(input.fileName);
    const mimeType = normalizeString(input.mimeType) || 'application/octet-stream';
    const ext = path.extname(fileName);
    const projectDir = path.join(DOCUMENT_DIR, sanitizeSegment(project));
    const storedName = `${id}${ext || '.bin'}`;
    const storagePath = path.join(projectDir, storedName);

    await mkdir(projectDir, { recursive: true });
    await writeFile(storagePath, input.buffer);

    const record: OpsDocumentRecord = {
      id,
      project,
      title: normalizeString(input.title) || fileName,
      fileName,
      mimeType,
      kind: normalizeKind(fileName, mimeType),
      sizeBytes: input.buffer.byteLength,
      storagePath,
      sourceUrl: `/api/documents/${encodeURIComponent(id)}/download`,
      uploadedAt: new Date().toISOString(),
      textPreview: buildPreview(input.buffer, fileName, mimeType),
    };

    store.documents.push(record);
    store.documents = sortDocuments(store.documents);
    await this.write(store);
    await this.emit();
    return record;
  }

  async get(id: string) {
    const store = await this.read();
    return store.documents.find((document) => document.id === id) ?? null;
  }

  async remove(id: string) {
    const store = await this.read();
    const record = store.documents.find((document) => document.id === id);
    if (!record) throw new Error(`Document '${id}' not found`);

    store.documents = store.documents.filter((document) => document.id !== id);
    await rm(record.storagePath, { force: true }).catch(() => undefined);
    await this.write(store);
    await this.emit();
  }

  async content(id: string) {
    const record = await this.get(id);
    if (!record) return null;
    const info = await stat(record.storagePath);
    const buffer = await readFile(record.storagePath);
    return { record, buffer, size: info.size };
  }

  async agentContext(selectedIds?: string[]) {
    const documents = await this.list();
    const selected = selectedIds?.length
      ? documents.filter((document) => selectedIds.includes(document.id))
      : documents;
    const scoped = selected.slice(0, 60);
    if (scoped.length === 0) {
      return 'No ROBIN project documents are currently uploaded.';
    }

    const lines = scoped.map((document) => {
      const preview = document.textPreview
        ? ` preview="${document.textPreview.replace(/\s+/g, ' ').slice(0, 260)}"`
        : '';
      return `- [${document.project}] ${document.title} (${document.kind}, ${document.sizeBytes} bytes) id=${document.id} path="${document.storagePath}"${preview}`;
    });

    return [
      'ROBIN project documents available to this chat:',
      ...lines,
      'Use exact document ids or storage paths when referring to uploaded documents.',
    ].join('\n');
  }

  private async read() {
    if (this.cache) return this.cache;

    await mkdir(STORE_DIR, { recursive: true });
    await mkdir(DOCUMENT_DIR, { recursive: true });
    try {
      const raw = await readFile(STORE_FILE, 'utf8');
      this.cache = normalizeStore(JSON.parse(raw));
    } catch {
      this.cache = { documents: [] };
      await this.write(this.cache);
    }
    return this.cache;
  }

  private async write(store: OpsDocumentStoreShape) {
    this.cache = { documents: sortDocuments(store.documents) };
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(STORE_FILE, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  private async emit() {
    broadcast('ops.documents.updated', {
      documents: await this.list(),
      ts: Date.now(),
    });
  }
}

export const opsDocumentStore = new OpsDocumentStore();
