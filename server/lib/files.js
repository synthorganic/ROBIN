/**
 * Async file helpers for reading/writing JSON and text files.
 *
 * All functions swallow `ENOENT` errors and return a caller-supplied fallback,
 * making them safe to use before files exist.
 * @module
 */
import fs from 'node:fs/promises';
/**
 * Read and parse a JSON file. Returns `fallback` on any error.
 */
export async function readJSON(filePath, fallback) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    }
    catch (err) {
        // Log non-ENOENT errors (corruption, permissions, etc.)
        if (err.code !== 'ENOENT') {
            console.warn(`[files] readJSON failed for ${filePath}:`, err.message);
        }
        return fallback;
    }
}
/**
 * Write JSON to a file (pretty-printed).
 */
export async function writeJSON(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}
/**
 * Read a text file. Returns `fallback` on any error.
 */
export async function readText(filePath, fallback = '') {
    try {
        return await fs.readFile(filePath, 'utf8');
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`[files] readText failed for ${filePath}:`, err.message);
        }
        return fallback;
    }
}
