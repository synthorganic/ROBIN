/**
 * File system operations for ROBIN Gateway.
 *
 * Provides safe file system access through controlled endpoints.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractDocumentTextFromFile } from './document-text.js';

/**
 * Extract text content from a .docx file using Node.js (shared service).
 */
async function extractDocxText(filePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
  const result = await extractDocumentTextFromFile({ filePath });

  if (result.ok) {
    return { success: true, content: result.text };
  }

  return { success: false, error: result.error || 'Failed to extract document content' };
}

export interface ListFilesOptions {
  directory?: string;
  pattern?: string;
}

export interface FileContentResult {
  success: boolean;
  content: string | null;
  error?: string;
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtime: string;
}

/**
 * Normalize a Windows path for comparison:
 * - Convert forward slashes to backslashes
 * - Uppercase drive letter (C:\ vs c:)
 */
function normalizeWindowsPath(p: string): string {
  // Handle both Unix-style and Windows-style paths
  let normalized = p.replace(/\//g, '\\');

  // Normalize drive letter to uppercase on Windows
  if (normalized.length >= 2 && normalized[1] === ':') {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  return normalized;
}

/**
 * Check if a path is within an allowed workspace directory.
 * Supports both the ROBIN project directory and user's .robin/inertiai-ops directory.
 */
function sanitizePath(userPath: string, baseDir: string): string {
  // Resolve the user path
  let resolved = path.resolve(baseDir, userPath);

  const normalizedBase = path.resolve(baseDir);

  // Allow paths within ROBIN project directory (prevents path traversal)
  if (!process.env.ROBIN_ALLOW_ALL_PATHS) {
    if (resolved.startsWith(normalizedBase + path.sep) || resolved === normalizedBase) {
      return resolved;
    }

    // Also allow .robin/inertiai-ops/documents paths (where uploaded documents are stored)
    const home = process.env.HOME || require('node:os').homedir();
    const documentDir = path.join(home, '.robin', 'inertiai-ops', 'documents');
    const resolvedDocDir = path.resolve(documentDir);

    // For robust comparison on Windows, normalize paths
    if (process.platform === 'win32') {
      const normResolved = normalizeWindowsPath(resolved);
      const normDocDir = normalizeWindowsPath(resolvedDocDir);

      if (normResolved.startsWith(normDocDir + '\\') || normResolved === normDocDir) {
        return resolved;
      }
    } else {
      // Unix-style comparison
      if (resolved.startsWith(resolvedDocDir + path.sep) || resolved === resolvedDocDir) {
        return resolved;
      }
    }
  }

  throw new Error('Access denied: path outside allowed directories');
}

/**
 * List files in a directory with optional pattern filtering.
 */
export async function listFiles(
  directory?: string,
  pattern?: string
): Promise<{ success: boolean; files: FileInfo[]; error?: string }> {
  try {
    const baseDir = process.cwd();
    const targetDir = directory ? sanitizePath(directory, baseDir) : baseDir;

    if (!fs.existsSync(targetDir)) {
      return { success: false, files: [], error: `Directory not found: ${targetDir}` };
    }

    const Dirent = fs.promises.readdir(targetDir, { withFileTypes: true });

    const files: FileInfo[] = [];
    for (const dirent of await Dirent) {
      const fullPath = path.join(targetDir, dirent.name);
      const stats = fs.statSync(fullPath);

      files.push({
        name: dirent.name,
        path: fullPath,
        size: stats.size,
        isFile: dirent.isFile(),
        isDirectory: dirent.isDirectory(),
        mtime: new Date(stats.mtime).toISOString(),
      });
    }

    // Filter by pattern if provided
    let filteredFiles = files;
    if (pattern) {
      const regex = new RegExp(pattern);
      filteredFiles = files.filter(f => regex.test(f.name));
    }

    return { success: true, files: filteredFiles };
  } catch (err) {
    return { success: false, files: [], error: (err as Error).message };
  }
}

/**
 * Read file content. Automatically handles .docx files by extracting text.
 */
export async function readFile(userPath: string): Promise<FileContentResult> {
  try {
    const baseDir = process.cwd();
    const fullPath = sanitizePath(userPath, baseDir);

    if (!fs.existsSync(fullPath)) {
      return { success: false, content: null, error: `File not found: ${fullPath}` };
    }

    // Check file size (limit to 10MB)
    const stats = fs.statSync(fullPath);
    if (stats.size > 10 * 1024 * 1024) {
      return { success: false, content: null, error: 'File too large (>10MB)' };
    }

    // Handle .docx files specially
    const lowerName = fullPath.toLowerCase();
    if (lowerName.endsWith('.docx')) {
      const result = await extractDocxText(fullPath);
      return { success: result.success, content: result.content ?? null, error: result.error };
    }

    // Check for binary file by attempting to read as text
    const buffer = fs.readFileSync(fullPath);

    // For text files, try to decode as UTF-8
    let content: string | null;
    try {
      content = buffer.toString('utf-8');
    } catch {
      return { success: false, content: null, error: 'File appears to be binary' };
    }

    return { success: true, content };
  } catch (err) {
    return { success: false, content: null, error: (err as Error).message };
  }
}

/**
 * Get file info without reading content.
 */
export async function fileInfo(userPath: string): Promise<{ success: boolean; info?: FileInfo; error?: string }> {
  try {
    const baseDir = process.cwd();
    const fullPath = sanitizePath(userPath, baseDir);

    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `File not found: ${fullPath}` };
    }

    const stats = fs.statSync(fullPath);
    return {
      success: true,
      info: {
        name: path.basename(fullPath),
        path: fullPath,
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        mtime: new Date(stats.mtime).toISOString(),
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
