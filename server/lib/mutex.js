/**
 * Simple async mutex for serializing file read-modify-write operations.
 * @module
 */
/**
 * Create an independent mutex instance.
 *
 * Returns a `withLock` function: call it with an async callback to guarantee
 * that only one callback executes at a time for this mutex.
 */
export function createMutex() {
    let lock = Promise.resolve();
    return async function withLock(fn) {
        let release;
        const next = new Promise((resolve) => { release = resolve; });
        const prev = lock;
        lock = next;
        await prev;
        try {
            return await fn();
        }
        finally {
            release();
        }
    };
}
/**
 * Keyed mutex — one lock per key string.
 * Usage: await withMutex('memory-file', () => appendToMemoryFile(...));
 */
const mutexes = new Map();
export async function withMutex(key, fn) {
    let mutex = mutexes.get(key);
    if (!mutex) {
        mutex = createMutex();
        mutexes.set(key, mutex);
    }
    return mutex(fn);
}
