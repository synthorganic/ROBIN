/**
 * GlobTool - Pattern-based file finding
 */
import fs from 'fs/promises';
import path from 'path';

export interface GlobOptions {
  pattern: string;
  cwd?: string;
  ignore?: string[];
  maxDepth?: number;
}

export interface GlobResult {
  matches: string[];
  directories: string[];
  files: string[];
  total: number;
}

class GlobTool {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
  }

  async find(options: GlobOptions): Promise<GlobResult> {
    const { pattern, cwd = this.cwd } = options;
    
    // Simple glob implementation using Node.js fs.promises
    const matches = await this.searchRecursive(cwd, pattern);
    
    const files: string[] = [];
    const directories: string[] = [];
    
    for (const match of matches) {
      try {
        const stats = await fs.stat(match);
        const relativePath = path.relative(cwd, match);
        if (stats.isDirectory()) {
          directories.push(relativePath + '/');
        } else {
          files.push(relativePath);
        }
      } catch {
        // Skip missing files
      }
    }
    
    return {
      matches,
      directories: directories.sort(),
      files: files.sort(),
      total: matches.length,
    };
  }

  private async searchRecursive(dir: string, pattern: string): Promise<string[]> {
    const results: string[] = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Recurse into directories
          results.push(...await this.searchRecursive(fullPath, pattern));
        } else if (entry.isFile() && this.matchesPattern(entry.name, pattern)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
    
    return results;
  }

  private matchesPattern(filename: string, pattern: string): boolean {
    if (pattern === '**/*') return true;
    if (pattern.startsWith('**/')) {
      const suffix = pattern.substring(3);
      return filename.endsWith(suffix) || filename.includes('/' + suffix);
    }
    // Simple glob matching
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(filename);
  }
}

export const globTool = new GlobTool();
