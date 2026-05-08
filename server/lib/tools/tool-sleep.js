/**
 * SleepTool - Pauses for async operations
 */
export class SleepTool {
    /**
     * Pause execution for a specified duration
     */
    async sleep(options = {}) {
        const { durationMs = 1000 } = options;
        console.log('[sleep] Pausing for ' + durationMs + 'ms...');
        return new Promise(resolve => {
            setTimeout(() => {
                console.log('[sleep] Resuming after ' + durationMs + 'ms');
                resolve();
            }, durationMs);
        });
    }
}
export const sleepTool = new SleepTool();
