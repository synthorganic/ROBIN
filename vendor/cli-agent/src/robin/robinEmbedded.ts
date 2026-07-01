/**
 * ROBIN Embedded Mode Entry Point
 * 
 * When ROBIN_MODE=1 is set, runs simplified agent loop without Ink TUI.
 * Outputs agent loop to stdout/stderr (xterm captures these streams).
 * Maps ROBIN_* environment variables to gateway/LLM config.
 */

import { exitWithError } from '../utils/process.js';
import { printStartupBanner } from '../../../server/lib/config.js';

// Map ROBIN environment variables to claude config environment
function mapRobinEnvVars(): void {
  // LLM configuration (local API / OpenAI-compatible endpoint)
  if (process.env.ROBIN_LLM_BASE_URL) {
    process.env.LOCAL_API_BASE_URL = process.env.ROBIN_LLM_BASE_URL;
  }
  if (process.env.ROBIN_LLM_API_KEY) {
    process.env.LOCAL_API_KEY = process.env.ROBIN_LLM_API_KEY;
  }
  if (process.env.ROBIN_MODEL_ID) {
    process.env.LOCAL_API_MODEL = process.env.ROBIN_MODEL_ID;
  }

  // Gateway configuration (for tool calls)
  if (process.env.ROBIN_GATEWAY_URL) {
    process.env.GATEWAY_URL = process.env.ROBIN_GATEWAY_URL;
  }
  if (process.env.ROBIN_GATEWAY_TOKEN) {
    process.env.GATEWAY_TOKEN = process.env.ROBIN_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = process.env.ROBIN_GATEWAY_TOKEN;
  }

  // Workspace configuration
  if (process.env.ROBIN_WORKSPACE_DIR) {
    // CLAUDE_CODE_PROJECT_DIR tells the CLI which project/workspace to use
    process.env.CLAUDE_CODE_PROJECT_DIR = process.env.ROBIN_WORKSPACE_DIR;
    // Also set CWD for file operations
    process.chdir(process.env.ROBIN_WORKSPACE_DIR);
  }

  // Document directory for agent file access
  if (process.env.ROBIN_DOCUMENT_DIR) {
    // Make document directory accessible to gateway tools
    // Gateway should look here for documents when executing files_read_docx etc.
    process.env.ROBIN_DOCUMENTS_ROOT = process.env.ROBIN_DOCUMENT_DIR;
  }

  // Agent name (optional)
  if (process.env.ROBIN_AGENT_NAME) {
    process.env.AGENT_NAME = process.env.ROBIN_AGENT_NAME;
  }
}

// Validate required ROBIN environment variables
function validateRobinMode(): void {
  const errors: string[] = [];

  // ROBIN_MODE=1 must be set
  if (process.env.ROBIN_MODE !== '1') {
    errors.push('ROBIN_MODE=1 is not set');
  }

  // Check for at least one LLM configuration option
  const hasLocalApi = !!process.env.ROBIN_LLM_BASE_URL;
  const hasGateway = !!(process.env.ROBIN_GATEWAY_URL && process.env.ROBIN_GATEWAY_TOKEN);

  if (!hasLocalApi && !hasGateway) {
    errors.push('Must configure either ROBIN_LLM_BASE_URL (local API) or ROBIN_GATEWAY_URL + ROBIN_GATEWAY_TOKEN');
  }

  // Workspace directory is recommended
  if (!process.env.ROBIN_WORKSPACE_DIR) {
    console.warn('[robin] ROBIN_WORKSPACE_DIR not set, using current directory');
  }

  if (errors.length > 0) {
    console.error('[robin] Invalid configuration:');
    errors.forEach(e => console.error(`  - ${e}`));
    exitWithError('[robin] Please set the required environment variables.');
  }
}

/**
 * Main entry point for ROBIN embedded mode
 * Runs agent loop without Ink TUI, outputs to stdout/stderr
 */
export async function main(): Promise<void> {
  console.log('[robin] Starting ROBIN Ops Agent (embedded mode)...');

  // Validate environment
  validateRobinMode();

  // Map ROBIN env vars to claude config format
  mapRobinEnvVars();

  // Print startup banner with configured values
  const version = process.env.npm_package_version || '0.0.0';
  printStartupBanner(version);

  console.log('[robin] Agent loop starting (outputs to stdout/stderr for xterm capture)...');
  console.log('[robin] To stop, send SIGINT (Ctrl+C) or EOF (Ctrl+D)');

  // Import the main CLI entrypoint
  const { main: cliMain } = await import('../main.js');

  // Override argv to simulate -p flag (headless mode) + pass through any args
  const originalArgv = process.argv;
  process.argv = ['node', 'claude', '-p', ...process.argv.slice(2)];

  try {
    const result = await cliMain();
    
    // Restore argv (though process may exit in some paths)
    process.argv = originalArgv;
    
    return result;
  } catch (err) {
    console.error('[robin] Agent loop error:', err);
    exitWithError('Agent loop failed');
  }
}

// Export main for direct invocation
export default main;
