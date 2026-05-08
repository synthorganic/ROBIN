import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
const execAsync = promisify(exec);
class GrepTool {
    cwd;
    constructor(cwd) {
        this.cwd = cwd || process.cwd();
    }
    async search(options) {
        const { pattern, cwd = this.cwd } = options;
        try {
            let command = 'grep -rEi  + pattern +  .';
            if (options.caseSensitive) {
                command = command.replace('i', '');
            }
            const targetPath = options.files && options.files.length > 0 ? '.' : cwd;
            command = 'grep -rEi  + pattern +  -C2  + targetPath + ';
            const { stdout } = await execAsync(command, { cwd });
            const matches = [];
            let currentFile = '';
            for (const line of stdout.split('\n')) {
                if (!line.trim() || line.startsWith('--'))
                    continue;
                const parts = line.split(':');
                if (parts.length >= 2) {
                    matches.push({
                        file: currentFile,
                        line: parseInt(parts[1]) || 0,
                        text: parts.slice(2).join(':').trim(),
                    });
                }
            }
            return { matches, total: matches.length };
        }
        catch (error) {
            throw new Error(error.message || 'Grep search failed');
        }
    }
}
export const grepTool = new GrepTool();
