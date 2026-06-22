import fs from 'fs/promises';
import path from 'path';
class GrepTool {
    cwd;
    constructor(cwd) {
        this.cwd = cwd || process.cwd();
    }
    async search(options) {
        const { pattern, cwd = this.cwd, files = [] } = options;
        const matcher = this.createMatcher(pattern, options.caseSensitive);
        const candidates = await this.collectCandidates(files.length > 0 ? files : [cwd], cwd);
        const matches = [];
        for (const filePath of candidates) {
            const contents = await fs.readFile(filePath, 'utf8').catch(() => null);
            if (contents == null)
                continue;
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
    createMatcher(pattern, caseSensitive) {
        const flags = caseSensitive ? '' : 'i';
        try {
            return new RegExp(pattern, flags);
        }
        catch {
            return new RegExp(escapeRegExp(pattern), flags);
        }
    }
    async collectCandidates(targets, cwd) {
        const results = new Set();
        for (const target of targets) {
            const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
            try {
                const stats = await fs.stat(absolute);
                if (stats.isDirectory()) {
                    await this.walkDirectory(absolute, results);
                }
                else if (stats.isFile()) {
                    results.add(absolute);
                }
            }
            catch {
                // Skip missing files and directories.
            }
        }
        return [...results].sort();
    }
    async walkDirectory(dir, results) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.walkDirectory(fullPath, results);
            }
            else if (entry.isFile()) {
                results.add(fullPath);
            }
        }
    }
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export const grepTool = new GrepTool();
