import type { Dirent } from 'node:fs';
import fs from 'fs/promises';
import path from 'path';

export interface GrepOptions {
  pattern: string;
  cwd?: string;
  files?: string[];
  caseSensitive?: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

class GrepTool {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
  }

  async search(options: GrepOptions): Promise<{ matches: GrepMatch[]; total: number }> {
    const { pattern, cwd = this.cwd, files = [] } = options;
    const matcher = this.createMatcher(pattern, options.caseSensitive);
    const candidates = await this.collectCandidates(files.length > 0 ? files : [cwd], cwd);
    const matches: GrepMatch[] = [];

    for (const filePath of candidates) {
      const contents = await fs.readFile(filePath, 'utf8').catch(() => null);
      if (contents == null) continue;

      const relativeFile = path.relative(cwd, filePath) || path.basename(filePath);
      const lines = contents.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        matcher.lastIndex = 0;
        if (matcher.test(line)) {
          matches.push({
            file: relativeFile,
            line: index + 1,
            text: line.trim(),
          });
        }
      }
    }

    return { matches, total: matches.length };
  }

  private createMatcher(pattern: string, caseSensitive?: boolean): RegExp {
    const flags = caseSensitive ? '' : 'i';
    try {
      return new RegExp(pattern, flags);
    } catch {
      return new RegExp(escapeRegExp(pattern), flags);
    }
  }

  private async collectCandidates(targets: string[], cwd: string): Promise<string[]> {
    const results = new Set<string>();

    for (const target of targets) {
      const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
      try {
        const stats = await fs.stat(absolute);
        if (stats.isDirectory()) {
          await this.walkDirectory(absolute, results);
        } else if (stats.isFile()) {
          results.add(absolute);
        }
      } catch {
        // Skip missing files and directories.
      }
    }

    return [...results].sort();
  }

  private async walkDirectory(dir: string, results: Set<string>): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, results);
      } else if (entry.isFile()) {
        results.add(fullPath);
      }
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const grepTool = new GrepTool();
