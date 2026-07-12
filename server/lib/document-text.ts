/**
 * Shared document text extraction service.
 */

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { config } from './config.js';

export interface ExtractedDocumentText {
  ok: boolean;
  text: string;
  mimeType: string;
  kind: string;
  pageCount?: number;
  charCount: number;
  truncated?: boolean;
  error?: string;
}

const MAX_CHARS_DEFAULT = 100_000;

function detectKind(fileName: string, mimeType: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext) return ext.slice(1);
  if (mimeType.includes('pdf')) return 'pdf';
  if (mimeType.includes('word') || mimeType.includes('doc')) return 'docx';
  if (mimeType.includes('excel')) return 'xlsx';
  const mimeBase = mimeType.split('/')[0];
  return mimeBase === 'text' ? 'txt' : 'file';
}

async function extractTextFile(buffer: Buffer): Promise<string> {
  try {
    let text = buffer.toString('utf8');
    text = text.replace(/\x00/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return text.trim();
  } catch { return ''; }
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const WORD_DOCUMENT_XML = 'word/document.xml';

function findEndOfCentralDirectory(buffer: Buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}

function extractZipEntry(buffer: Buffer, entryName: string): Buffer {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === -1) {
    throw new Error('Could not locate ZIP central directory');
  }

  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.toString('utf8', fileNameStart, fileNameEnd);

    if (fileName === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
        throw new Error(`Invalid local ZIP header for ${entryName}`);
      }

      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      const compressedData = buffer.subarray(dataStart, dataEnd);

      if (compressionMethod === 0) {
        return Buffer.from(compressedData);
      }
      if (compressionMethod === 8) {
        return inflateRawSync(compressedData);
      }
      throw new Error(`Unsupported DOCX compression method: ${compressionMethod}`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`Could not find ${entryName} in DOCX archive`);
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const content = extractZipEntry(buffer, WORD_DOCUMENT_XML).toString('utf8');
  const paragraphs = content
    .split(/<\/w:p>/gi)
    .map((segment) => {
      const tokens = Array.from(
        segment.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/gi),
      ).map((match) => {
        if (typeof match[1] === 'string') return decodeXmlEntities(match[1]);
        const token = match[0].toLowerCase();
        if (token.startsWith('<w:tab')) return '\t';
        return '\n';
      });

      return tokens.join('').trim();
    })
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const fallback = Array.from(content.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi))
    .map((match) => decodeXmlEntities(match[1] ?? ''))
    .join('')
    .trim();

  if (!fallback) {
    throw new Error('DOCX parsing failed: no readable text nodes found');
  }

  return fallback;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // Use require for pdf-parse since it uses CommonJS
    const pdfParse = require('pdf-parse');
    const dataBuffer = await pdfParse(buffer);
    return dataBuffer.text;
  } catch (err) {
    throw new Error(`PDF parsing failed: ${(err as Error).message}`);
  }
}

export async function extractDocumentText(input: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  maxChars?: number;
}): Promise<ExtractedDocumentText> {
  const { buffer, fileName, mimeType = 'application/octet-stream', maxChars = MAX_CHARS_DEFAULT } = input;
  const kind = detectKind(fileName, mimeType);

  try {
    let text = '';
    switch (kind) {
      case 'docx': text = await extractDocxText(buffer); break;
      case 'pdf': text = await extractPdfText(buffer); break;
      default: text = await extractTextFile(buffer);
    }

    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    return { ok: true, text, mimeType, kind, charCount: text.length, truncated };
  } catch (err) {
    return { ok: false, text: '', mimeType, kind, charCount: 0, error: (err as Error).message };
  }
}

export async function extractDocumentTextFromFile(input: {
  filePath: string;
  maxChars?: number;
}): Promise<ExtractedDocumentText> {
  const { filePath, maxChars } = input;
  
  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    let mimeType = 'application/octet-stream';
    if (ext === '.docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.md' || ext === '.markdown') mimeType = 'text/markdown';
    
    return extractDocumentText({ buffer, fileName: path.basename(filePath), mimeType, maxChars });
  } catch (err) {
    return { ok: false, text: '', mimeType: 'application/octet-stream', kind: path.extname(filePath).slice(1), charCount: 0, error: (err as Error).message };
  }
}

export async function loadCachedText(documentId: string): Promise<string | null> {
  try {
    const storeDir = path.join(config.home, '.robin', 'inertiai-ops', 'documents');
    const cachePath = path.join(storeDir, `${documentId}.txt`);
    if (await fileExists(cachePath)) return await readFile(cachePath, 'utf8');
    return null;
  } catch { return null; }
}

async function fileExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile(); } catch { return false; }
}
