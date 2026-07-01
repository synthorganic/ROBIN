/**
 * Interactive setup wizard for ROBIN.
 * Guides users through first-time configuration.
 *
 * Usage:
 *   npm run setup               # Interactive setup
 *   npm run setup -- --check    # Validate existing config
 *   npm run setup -- --defaults # Non-interactive with defaults
 */

/** Mask a token for display, with a guard for short tokens. */
// Show token in prompts so users can verify what they entered

import { existsSync, readdirSync, mkdirSync, copyFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { input, password, confirm, select } from '@inquirer/prompts';
import { printBanner, section, success, warn, fail, info, dim, promptTheme } from './lib/banner.js';
import { checkPrerequisites, type PrereqResult } from './lib/prereq-check.js';
import {
  isValidUrl,
  isValidPort,
  testGatewayConnection,
  isValidOpenAIKey,
  isValidReplicateToken,
} from './lib/validators.js';
import {
  writeEnvFile,
  backupExistingEnv,
  loadExistingEnv,
  cleanupTmp,
  DEFAULTS,
  type EnvConfig,
} from './lib/env-writer.js';
import { generateSelfSignedCert } from './lib/cert-gen.js';
// Removed gateway-detect imports - ROBIN Gateway is now fully standalone
import { applyAccessPlanToConfig, buildAccessPlan, type InstallerAccessProfile } from './lib/access-plan.js';
import { getTailscaleState, type TailscaleState } from './lib/tailscale.js';
import { detectAgentDisplayNameDefault } from './lib/agent-name-default.js';
import { printDeploymentGuides, shouldPrintDeploymentGuides } from './lib/deployment-guides.js';

const PROJECT_ROOT = resolve(process.cwd());
const ENV_PATH = resolve(PROJECT_ROOT, '.env');
const SKILLS_SRC = resolve(PROJECT_ROOT, 'skills');
const SKILLS_DEST = resolve(homedir(), '.robin', 'workspace', 'skills');
const TOTAL_SECTIONS = 6;

const args = process.argv.slice(2);
const isHelp = args.includes('--help') || args.includes('-h');
const isCheck = args.includes('--check');
const isDefaults = args.includes('--defaults');

type AccessMode = 'local' | 'network' | 'custom' | 'tailscale-ip' | 'tailscale-serve';

function getArgValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function normalizeAccessMode(value?: string | null): AccessMode | undefined {
  if (!value) return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'tailscale') return 'tailscale-ip';

  if (normalized === 'local' || normalized === 'network' || normalized === 'custom' || normalized === 'tailscale-ip' || normalized === 'tailscale-serve') {
    return normalized;
  }

  fail(`Invalid --access-mode value: ${value}`);
  console.log('  Supported values: local, network, custom, tailscale-ip, tailscale-serve');
  process.exit(1);
}

const requestedAccessMode = normalizeAccessMode(getArgValue('--access-mode'));

function detectPrimaryIpv4(): string | null {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (!addr.internal && addr.family === 'IPv4') return addr.address;
    }
  }
  return null;
}

/** Check whether a host string is a loopback address (IPv4, IPv6, or localhost). */
function isLoopback(host: string): boolean {
  return !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveTimer => setTimeout(resolveTimer, ms));
}

/**
 * ROBIN Gateway configuration is self-contained - no external dependencys.
 * Gateway config is written to ~/.robin/gateway.json and requires no external restart.
 */
async function applyConfigChanges(): Promise<void> {
  // No-op: ROBIN Gateway handles its own configuration internally
}

// ── ROBIN Gateway helpers ────────────────────────────────────────────

/**
 * Start the ROBIN Gateway in the background.
 * Returns a cleanup function to stop the process.
 */
function startRobinGateway(): { cleanup: () => void; pid?: number } {
  const PROJECT_ROOT = resolve(process.cwd());
  const gatewayJsPath = join(PROJECT_ROOT, 'server', 'lib', 'gateway-v1.js');
  const gatewayTsPath = join(PROJECT_ROOT, 'server', 'lib', 'gateway-v1.ts');

  let childProcess: import('node:child_process').ChildProcess | null = null;

  try {
    // Check for existing compiled JS first, otherwise use TS
    const usingTSX = existsSync(gatewayTsPath) && !existsSync(gatewayJsPath);

    if (!existsSync(gatewayJsPath) && !existsSync(gatewayTsPath)) {
      warn(`ROBIN Gateway script not found`);
      return { cleanup: () => {} };
    }

    // Use tsx to run the gateway script directly
    // This works across platforms and handles ESM correctly

    dim(`Starting ROBIN Gateway with: tsx server/lib/gateway-v1.ts`);

    childProcess = spawn('tsx', ['server/lib/gateway-v1.ts'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: PROJECT_ROOT
    });

    // Log any errors from the process
    childProcess.on('error', (err) => {
      warn(`Gateway process error: ${err.message}`);
    });

    // Capture stdout/stderr for debugging
    childProcess.stdout?.on('data', (data) => {
      console.log(data.toString());
    });
    childProcess.stderr?.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Gateway ready') || msg.includes('Listening on')) {
        // Gateway started successfully
        return;
      }
      if (msg.includes('Error') || msg.includes('Failed') || msg.includes('error:')) {
        warn(msg.trim());
      }
    });

    childProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        // Gateway exited - this is expected behavior since serve() waits forever
        // If it exits quickly with error, log it
        if (code !== 130 && code !== 143) { // Not a graceful shutdown
          warn(`Gateway exited with code ${code}${signal ? ` due to ${signal}` : ''}`);
        }
      }
    });

    return {
      cleanup: () => {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGTERM');
          try { childProcess.kill('SIGKILL'); } catch {}
        }
      },
      pid: childProcess.pid || undefined
    };
  } catch (err) {
    warn(`Failed to start ROBIN Gateway: ${(err as Error).message}`);
    return { cleanup: () => {} };
  }
}

// ── Ctrl+C handler ───────────────────────────────────────────────────

process.on('SIGINT', () => {
  cleanupTmp(ENV_PATH);
  console.log('\n\n  Setup cancelled.\n');
  process.exit(130);
});

// ── Skill installation ───────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = lstatSync(srcPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function installBundledSkills(): void {
  if (!existsSync(SKILLS_SRC)) return;

  let installed = 0;
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_SRC);
  } catch {
    return;
  }

  for (const skillName of entries) {
    try {
      const skillSrc = join(SKILLS_SRC, skillName);
      if (!lstatSync(skillSrc).isDirectory()) continue;
      if (!existsSync(join(skillSrc, 'SKILL.md'))) continue;

      const skillDest = join(SKILLS_DEST, skillName);
      copyDirSync(skillSrc, skillDest);
      installed++;
    } catch (err) {
      warn(`Failed to install skill "${skillName}": ${(err as Error).message}`);
    }
  }

  if (installed > 0) {
    success(`Installed ${installed} bundled skill${installed > 1 ? 's' : ''} to ${SKILLS_DEST}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (isHelp) {
    console.log(`
  Usage: npm run setup [options]

  Options:
    --check                   Validate existing .env config and test gateway connection
    --defaults                Non-interactive setup using auto-detected values
    --access-mode <mode>      Explicit non-interactive access mode
    --help, -h                Show this help message

  Access modes:
    local             Localhost only
    network           LAN-reachable
    custom            Manual bind and HTTPS choices
    tailscale-ip      Direct tailnet IP access
    tailscale-serve   Loopback + Tailscale Serve hostname

  The setup wizard guides you through 6 steps:
    1. Gateway Connection — local gateway setup
    2. Agent Identity     — set your agent's display name
    3. Access Mode        — local, Tailscale IP, Tailscale Serve, LAN, or custom
    4. Authentication     — password protection (network mode)
    5. TTS Configuration  — optional text-to-speech API keys
    6. Advanced Settings  — custom file paths (most users skip this)

Note: ROBIN Gateway is fully self-contained with no external installation required.

  Examples:
    npm run setup                                     # Interactive setup
    npm run setup -- --check                          # Validate existing config
    npm run setup -- --defaults                       # Auto-configure with detected values
    npm run setup -- --defaults --access-mode tailscale-serve
`);
    return;
  }

  printBanner(); // no-ops when ROBIN_INSTALLER is set

  // Clean up stale .env.tmp from previous interrupted runs
  cleanupTmp(ENV_PATH);

  // Prerequisite checks (skip verbose output when called from installer — already checked)
  const prereqs = checkPrerequisites({ quiet: !!process.env.ROBIN_INSTALLER });
  if (!prereqs.nodeOk) {
    console.log('');
    fail('Node.js ≥ 22 is required. Please upgrade and try again.');
    process.exit(1);
  }

  // Load existing config as defaults
  const hasExisting = existsSync(ENV_PATH);
  const existing: EnvConfig = hasExisting ? loadExistingEnv(ENV_PATH) : {};

  if (hasExisting) {
    info('Found existing .env configuration');
  } else {
    info('No existing .env found — starting fresh setup');
  }

  // --check mode: validate and exit
  if (isCheck) {
    await runCheck(existing);
    return;
  }

  // --defaults mode: non-interactive
  if (isDefaults) {
    await runDefaults(existing, prereqs);
    return;
  }

  // If .env exists, ask whether to update or start fresh
  // (Skip this when called from install.sh — the installer already asked)
  if (hasExisting && existing.GATEWAY_TOKEN && !process.env.ROBIN_INSTALLER) {
    const action = await select({
    theme: promptTheme,
      message: 'What would you like to do?',
      choices: [
        { name: 'Update existing configuration', value: 'update' },
        { name: 'Start fresh', value: 'fresh' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });
    if (action === 'cancel') {
      console.log('\n  Setup cancelled.\n');
      return;
    }
    if (action === 'fresh') {
      Object.keys(existing).forEach((k) => delete (existing as Record<string, unknown>)[k]);
    }
  }

  // Run interactive setup
  const config = await collectInteractive(existing, prereqs);

  // Write .env
  if (hasExisting) {
    const backupPath = backupExistingEnv(ENV_PATH);
    info(`Previous config backed up to ${backupPath.replace(PROJECT_ROOT + '/', '')}`);
  }
  writeEnvFile(ENV_PATH, config);

  console.log('');
  success('Configuration written to .env');

  // Install bundled agent skills
  installBundledSkills();

  printSummary(config);

  // When invoked from install.sh, build is already done — skip misleading "next steps"
  if (!process.env.ROBIN_INSTALLER) {
    printNextSteps(config);
    printDeploymentGuides();
  }
}

// ── Interactive setup ────────────────────────────────────────────────

async function collectInteractive(
  existing: EnvConfig,
  prereqs: PrereqResult,
): Promise<EnvConfig> {
  const config: EnvConfig = { ...existing };

  // ── 1/5: Gateway Connection ──────────────────────────────────────

  section(1, TOTAL_SECTIONS, 'Gateway Connection');
  dim('ROBIN connects to your local agent gateway.');
  console.log('');

  const HOME = process.env.HOME || os.homedir();
  const ROBIN_DIR = join(HOME, '.robin');
  const ROBIN_GATEWAY_CONFIG_PATH = join(ROBIN_DIR, 'gateway.json');
  dim('Setting up local ROBIN Gateway...');

  // Create .robin directory if needed
  mkdirSync(ROBIN_DIR, { recursive: true });

  // Generate token
  const robinToken = cryptoRandomBytes(32).toString('base64url');

  // Save to gateway config
  const robinConfig = {
    gateway: {
      port: 18789,
      bind: '127.0.0.1',
      auth: {
        mode: 'token',
        token: robinToken,
      },
      controlUi: {
        allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      },
      tools: {
        allow: ['bash', 'powershell', 'files_list', 'memories_get', 'sessions_spawn'],
      },
    },
  };

  writeFileSync(ROBIN_GATEWAY_CONFIG_PATH, JSON.stringify(robinConfig, null, 2) + '\n');
  success(`Created ROBIN Gateway config at ${ROBIN_DIR}`);

  // Store token
  config.GATEWAY_TOKEN = robinToken;
  config.GATEWAY_URL = 'http://127.0.0.1:18789';

  dim('Auto-generated local gateway token:');
  console.log(`  GATEWAY_TOKEN=${robinToken}`);

  // Start the gateway server in background
  success('Starting ROBIN Gateway server...');
  const gatewayCleanup = startRobinGateway();

  // Give the server time to start
  await sleep(2000);

  success('ROBIN Gateway is ready');

  // Test connection - ROBIN Gateway health check
  const rail = `  \x1b[2m│\x1b[0m`;
  const testPrefix = process.env.ROBIN_INSTALLER ? `${rail}  ` : '  ';
  let gwTest: { ok: boolean; message: string };
  // Use global fetch if available (Node.js 18+), otherwise use require
  const doFetch = typeof fetch !== 'undefined' ? fetch : (await import('node-fetch')).default;

  // Always test ROBIN Gateway
  process.stdout.write(`${testPrefix}Testing ROBIN Gateway connection... `);
  try {
    const res = await doFetch('http://127.0.0.1:18789/health', { method: 'GET' });
    if (res.ok) {
      gwTest = { ok: true, message: 'ROBIN Gateway is running' };
    } else {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
  } catch (err: any) {
    gwTest = { ok: false, message: `Cannot reach gateway: ${err.message}` };
  }

  if (gwTest.ok) {
    console.log(`\x1b[32m✓\x1b[0m ${gwTest.message}`);
  } else {
    console.log(`\x1b[31m✗\x1b[0m ${gwTest.message}`);
    dim('ROBIN Gateway failed to start. Run `npm run setup` again or manually start it.');
    console.log('\n  Setup could not verify your gateway token. Fix the gateway or token, then re-run setup.\n');
    process.exit(1);
  }

  // ── 2/5: Agent Identity ──────────────────────────────────────────

  section(2, TOTAL_SECTIONS, 'Agent Identity');

  config.AGENT_NAME = await input({
    theme: promptTheme,
    message: 'Agent display name',
    default: detectAgentDisplayNameDefault(existing.AGENT_NAME, DEFAULTS.AGENT_NAME),
  });

  // ── 3/5: Access Mode ──────────────────────────────────────────────

  section(3, TOTAL_SECTIONS, 'How will you access ROBIN?');

  const accessChoices: { name: string; value: AccessMode; description: string }[] = [
    { name: 'This machine only (localhost)', value: 'local', description: 'Safest, only accessible from this computer' },
    {
      name: prereqs.tailscale.ipv4 ? `Via Tailscale tailnet IP (${prereqs.tailscale.ipv4})` : 'Via Tailscale tailnet IP',
      value: 'tailscale-ip',
      description: prereqs.tailscale.installed
        ? 'Direct access from other devices on your tailnet'
        : 'Requires Tailscale on this machine',
    },
    {
      name: prereqs.tailscale.dnsName ? `Via Tailscale Serve (${prereqs.tailscale.dnsName})` : 'Via Tailscale Serve',
      value: 'tailscale-serve',
      description: 'Private by default, ROBIN stays on 127.0.0.1 and is exposed through *.ts.net',
    },
    { name: 'From other devices on my network', value: 'network', description: 'Opens to LAN, you may need to configure your firewall' },
    { name: 'Custom setup (I know what I\'m doing)', value: 'custom', description: 'Manual port, bind address, HTTPS, CORS configuration' },
  ];

  const accessMode = await select<AccessMode>({
    theme: promptTheme,
    message: 'How will you connect to ROBIN?',
    choices: accessChoices,
  });

  let port = existing.PORT || DEFAULTS.PORT;
  config.PORT = port;
  let sslPort: string | undefined;
  let accessPlan = buildAccessPlan({ profile: 'local', port });
  let tailscaleState: TailscaleState = prereqs.tailscale;

  function printFollowUpSteps(steps: string[]): void {
    if (steps.length === 0) return;
    for (const step of steps) {
      dim(`  • ${step}`);
    }
  }

  async function offerHttpsSetup(remoteHost: string): Promise<string | undefined> {
    console.log('');
    warn('Voice input (microphone) requires HTTPS on non-localhost connections.');
    dim('Browsers block microphone access over plain HTTP for security.');
    console.log('');

    const enableHttps = await confirm({
      theme: promptTheme,
      message: 'Enable HTTPS? (recommended for voice input)',
      default: true,
    });

    if (!enableHttps) {
      dim('Voice input will only work when accessing ROBIN from localhost');
      return undefined;
    }

    let certsReady = false;
    if (prereqs.opensslOk) {
      const certResult = generateSelfSignedCert(PROJECT_ROOT);
      if (certResult.ok) {
        success(certResult.message);
        certsReady = true;
      } else {
        fail(certResult.message);
      }
    } else {
      warn('openssl not found, cannot generate self-signed certificate');
      dim('Install openssl and run: mkdir -p certs && openssl req -x509 -newkey rsa:2048 \\');
      dim('  -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=localhost"');
    }

    if (!certsReady) {
      warn('HTTPS disabled, voice input will only work on localhost');
      return undefined;
    }

    const selectedSslPort = await input({
      theme: promptTheme,
      message: 'SSL port',
      default: existing.SSL_PORT || DEFAULTS.SSL_PORT,
      validate: (val) => {
        const n = parseInt(val, 10);
        if (!isValidPort(n)) return 'Please enter a valid port (1–65535)';
        if (n === parseInt(port, 10)) return 'SSL port must differ from HTTP port';
        return true;
      },
    });

    success(`HTTPS will be available at https://${remoteHost}:${selectedSslPort}`);
    dim('Note: Self-signed certs will show a browser warning on first visit, click "Advanced" then "Proceed"');
    return selectedSslPort;
  }

  async function ensureInteractiveTailscale(): Promise<TailscaleState> {
    let state = tailscaleState;

    if (!state.installed) {
      console.log('');
      warn('Tailscale is not installed on this machine.');
      dim('Install it first, then complete browser login with: tailscale up');
      dim('Download: https://tailscale.com/download/linux');
      console.log('\n  Re-run: \x1b[36mnpm run setup\x1b[0m\n');
      process.exit(1);
    }

    if (state.authenticated) {
      return state;
    }

    console.log('');
    warn('Tailscale is installed but not connected.');
    dim('In another terminal, start the browser URL login flow with: tailscale up');
    console.log('');

    const nextAction = await select<'wait' | 'exit'>({
      theme: promptTheme,
      message: 'How should setup continue?',
      choices: [
        { name: 'Wait and continue automatically once Tailscale is connected', value: 'wait' },
        { name: 'Exit and re-run setup later', value: 'exit' },
      ],
    });

    if (nextAction === 'exit') {
      console.log('\n  Finish login with: \x1b[36mtailscale up\x1b[0m');
      console.log('  Then re-run: \x1b[36mnpm run setup\x1b[0m\n');
      process.exit(1);
    }

    process.stdout.write('  Waiting for Tailscale login... ');
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(2000);
      state = getTailscaleState();
      if (state.authenticated) {
        tailscaleState = state;
        console.log(`\x1b[32m✓\x1b[0m ${state.dnsName || state.ipv4 || 'Connected'}`);
        return state;
      }
    }

    console.log('\x1b[31m✗\x1b[0m Timed out waiting for Tailscale login');
    dim('Finish login with: tailscale up');
    console.log('');
    process.exit(1);
  }

  if (accessMode === 'local') {
    accessPlan = buildAccessPlan({ profile: 'local', port });
    success(`ROBIN will be available at http://localhost:${port}`);

  } else if (accessMode === 'tailscale-ip') {
    tailscaleState = await ensureInteractiveTailscale();
    accessPlan = buildAccessPlan({ profile: 'tailscale-ip', port, tailscale: tailscaleState });
    if (accessPlan.followUpSteps.length > 0) {
      warn('Tailscale tailnet IP access is not ready yet.');
      printFollowUpSteps(accessPlan.followUpSteps);
      console.log('');
      process.exit(1);
    }
    success(`ROBIN will be available at ${accessPlan.browserOrigins[0]}`);
    dim('Accessible from any device on your Tailscale network');

  } else if (accessMode === 'tailscale-serve') {
    tailscaleState = await ensureInteractiveTailscale();

    console.log('');
    const configureServe = await confirm({
      theme: promptTheme,
      message: `Configure Tailscale Serve now? (tailscale serve --bg 443 http://127.0.0.1:${port})`,
      default: true,
    });

    if (configureServe) {
      try {
        execSync(`tailscale serve --bg 443 http://127.0.0.1:${port}`, { stdio: 'pipe', timeout: 15000, encoding: 'utf8' });
        success(`Tailscale Serve configured for http://127.0.0.1:${port}`);
      } catch (err) {
        const execErr = err as {
          stderr?: string | Buffer;
          message?: string;
          status?: number;
          signal?: string | null;
        };
        const stderr = typeof execErr.stderr === 'string'
          ? execErr.stderr.trim()
          : Buffer.isBuffer(execErr.stderr)
            ? execErr.stderr.toString('utf8').trim()
            : '';
        const status = typeof execErr.status === 'number'
          ? ` (exit ${execErr.status})`
          : execErr.signal
            ? ` (signal ${execErr.signal})`
            : '';
        const detail = stderr || execErr.message || String(err);
        const detailWithStatus = status && !detail.includes(status.trim()) ? `${detail}${status}` : detail;
        warn(`Failed to configure Tailscale Serve automatically: ${detailWithStatus}`);
      }
    } else {
      dim(`Run later: tailscale serve --bg 443 http://127.0.0.1:${port}`);
    }

    tailscaleState = getTailscaleState();
    accessPlan = buildAccessPlan({ profile: 'tailscale-serve', port, tailscale: tailscaleState });

    if (accessPlan.followUpSteps.length > 0) {
      console.log('');
      warn('Could not confirm a usable Tailscale Serve hostname.');
      printFollowUpSteps(accessPlan.followUpSteps);
      console.log('');

      const fallback = await select<'tailscale-ip' | 'stop'>({
        theme: promptTheme,
        message: 'How should setup continue?',
        choices: [
          { name: 'Continue with tailnet IP access instead', value: 'tailscale-ip' },
          { name: 'Stop setup and finish Tailscale Serve manually', value: 'stop' },
        ],
      });

      if (fallback === 'stop') {
        console.log('\n  Finish Tailscale Serve setup, then re-run: \x1b[36mnpm run setup\x1b[0m\n');
        process.exit(1);
      }

      accessPlan = buildAccessPlan({ profile: 'tailscale-ip', port, tailscale: tailscaleState });
      if (accessPlan.followUpSteps.length > 0) {
        warn('Tailnet IP fallback is also unavailable.');
        printFollowUpSteps(accessPlan.followUpSteps);
        console.log('');
        process.exit(1);
      }

      success(`Falling back to tailnet IP access at ${accessPlan.browserOrigins[0]}`);
    } else {
      success(`ROBIN will be available at ${accessPlan.browserOrigins[0]}`);
      dim('ROBIN will stay private on 127.0.0.1 and be reached through Tailscale Serve');
    }

  } else if (accessMode === 'network') {
    const detectedIp = detectPrimaryIpv4();
    const lanIp = await input({
      theme: promptTheme,
      message: 'Your LAN IP address',
      default: detectedIp || '',
      validate: (val) => {
        if (!val.trim()) return 'IP address is required for network access';
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(val.trim())) return 'Enter a valid IPv4 address';
        return true;
      },
    });
    const ip = lanIp.trim();
    sslPort = await offerHttpsSetup(ip);
    accessPlan = buildAccessPlan({ profile: 'network', port, remoteHost: ip, sslPort });
    success(`ROBIN will be available at http://${ip}:${port}`);
    dim(`Make sure your firewall allows traffic on port ${port}`);
    dim('Need access from multiple devices? Add more origins to ALLOWED_ORIGINS in .env');

  } else {
    port = await input({
      theme: promptTheme,
      message: 'HTTP port',
      default: existing.PORT || DEFAULTS.PORT,
      validate: (val) => {
        const n = parseInt(val, 10);
        if (!isValidPort(n)) return 'Please enter a valid port (1–65535)';
        return true;
      },
    });
    config.PORT = port;

    const customHost = await input({
      theme: promptTheme,
      message: 'Bind address (127.0.0.1 = local only, 0.0.0.0 = all interfaces)',
      default: existing.HOST || DEFAULTS.HOST,
    });

    if (!isLoopback(customHost)) {
      sslPort = await offerHttpsSetup(customHost);
    } else {
      delete config.SSL_PORT;
    }

    accessPlan = buildAccessPlan({ profile: 'custom', port, remoteHost: customHost, sslPort });
    success(`ROBIN will be available at http://${customHost}:${port}`);
  }

  delete config.ALLOWED_ORIGINS;
  delete config.CSP_CONNECT_EXTRA;
  delete config.WS_ALLOWED_HOSTS;
  delete config.SSL_PORT;
  Object.assign(config, applyAccessPlanToConfig(config, accessPlan));
  if (sslPort) config.SSL_PORT = sslPort;

  // ── Gateway config updates ─────────────────────────────────────────

  // ROBIN Gateway handles its own config internally - no external config needed

  // ── 4/6: Authentication ───────────────────────────────────────────

  // Always generate a session secret if not already set
  if (!config.ROBIN_SESSION_SECRET) {
    config.ROBIN_SESSION_SECRET = cryptoRandomBytes(32).toString('hex');
  }

  const isNetworkExposed = config.HOST === '0.0.0.0';

  if (isNetworkExposed) {
    section(4, TOTAL_SECTIONS, 'Authentication');
    warn('Your access mode exposes ROBIN to the network.');
    dim('Without a password, anyone on your network can access all endpoints.');
    console.log('');

    const setPassword = await confirm({
      theme: promptTheme,
      message: 'Set a password for ROBIN access? (recommended)',
      default: true,
    });

    if (setPassword) {
      const pw = await password({
        theme: promptTheme,
        message: 'Enter a password',
        validate: (val) => {
          if (!val || val.trim().length < 4) return 'Password must be at least 4 characters';
          return true;
        },
      });

      const pwConfirm = await password({
        theme: promptTheme,
        message: 'Confirm password',
        validate: (val) => {
          if (val !== pw) return 'Passwords do not match';
          return true;
        },
      });

      if (pw === pwConfirm) {
        // Hash the password using scrypt (inline to avoid importing server code)
        const { scrypt } = await import('node:crypto');
        const salt = cryptoRandomBytes(32);
        const hash = await new Promise<string>((resolve, reject) => {
          scrypt(pw, salt, 64, (err, derivedKey) => {
            if (err) return reject(err);
            resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
          });
        });
        config.ROBIN_PASSWORD_HASH = hash;
        config.ROBIN_AUTH = 'true';
        success('Password set. Authentication will be enabled.');
      }
    } else {
      // No password, but still enable auth if gateway token exists
      if (config.GATEWAY_TOKEN) {
        config.ROBIN_AUTH = 'true';
        success('Authentication enabled — your gateway token can be used as a password.');
      } else {
        warn('No password set and no gateway token. Authentication disabled.');
        dim('Run `npm run setup` again to set a password.');
      }
    }
  } else {
    // Localhost — skip auth setup, but preserve existing auth config
    if (existing.ROBIN_AUTH) config.ROBIN_AUTH = existing.ROBIN_AUTH;
    if (existing.ROBIN_PASSWORD_HASH) config.ROBIN_PASSWORD_HASH = existing.ROBIN_PASSWORD_HASH;
    if (existing.ROBIN_SESSION_SECRET) config.ROBIN_SESSION_SECRET = existing.ROBIN_SESSION_SECRET;
    if (existing.ROBIN_SESSION_TTL) config.ROBIN_SESSION_TTL = existing.ROBIN_SESSION_TTL;
  }

  // ── 5/6: TTS ─────────────────────────────────────────────────────

  section(5, TOTAL_SECTIONS, 'Text-to-Speech (optional)');
  dim('Edge TTS is always available (free, no API key needed).');
  dim('Add API keys below for higher-quality alternatives.');
  console.log('');

  const openaiKey = await password({
    theme: promptTheme,
    message: 'OpenAI API Key (press Enter to skip)',
  });

  if (openaiKey && openaiKey.trim()) {
    if (isValidOpenAIKey(openaiKey.trim())) {
      config.OPENAI_API_KEY = openaiKey.trim();
      success('OpenAI API key accepted (enables TTS + Whisper transcription)');
    } else {
      warn('Key doesn\'t look like a standard OpenAI key (expected sk-...)');
      const useAnyway = await confirm({
    theme: promptTheme,
        message: 'Use this key anyway?',
        default: true,
      });
      if (useAnyway) {
        config.OPENAI_API_KEY = openaiKey.trim();
      }
    }
  }

  const replicateToken = await password({
    theme: promptTheme,
    message: 'Replicate API Token (press Enter to skip)',
  });

  if (replicateToken && replicateToken.trim()) {
    if (isValidReplicateToken(replicateToken.trim())) {
      config.REPLICATE_API_TOKEN = replicateToken.trim();
      success('Replicate token accepted (enables Qwen TTS)');
      if (!prereqs.ffmpegOk) {
        warn('ffmpeg not found — Qwen TTS requires it for WAV→MP3 conversion');
      }
    } else {
      warn('Token seems too short');
      const useAnyway = await confirm({
    theme: promptTheme,
        message: 'Use this token anyway?',
        default: true,
      });
      if (useAnyway) {
        config.REPLICATE_API_TOKEN = replicateToken.trim();
      }
    }
  }

  // ── 6/6: Advanced Settings ────────────────────────────────────────

  section(6, TOTAL_SECTIONS, 'Advanced Settings (optional)');

  const configureAdvanced = await confirm({
    theme: promptTheme,
    message: 'Customize file paths? (most users should skip this)',
    default: false,
  });

  if (configureAdvanced) {
    const memPath = await input({
    theme: promptTheme,
      message: 'Custom memory file path (or Enter for default)',
      default: existing.MEMORY_PATH || '',
    });
    if (memPath.trim()) config.MEMORY_PATH = memPath.trim();

    const memDir = await input({
    theme: promptTheme,
      message: 'Custom memory directory path (or Enter for default)',
      default: existing.MEMORY_DIR || '',
    });
    if (memDir.trim()) config.MEMORY_DIR = memDir.trim();

    const sessDir = await input({
    theme: promptTheme,
      message: 'Custom sessions directory (or Enter for default)',
      default: existing.SESSIONS_DIR || '',
    });
    if (sessDir.trim()) config.SESSIONS_DIR = sessDir.trim();
  } else {
    // Preserve any existing advanced settings on update
    if (existing.MEMORY_PATH) config.MEMORY_PATH = existing.MEMORY_PATH;
    if (existing.MEMORY_DIR) config.MEMORY_DIR = existing.MEMORY_DIR;
    if (existing.SESSIONS_DIR) config.SESSIONS_DIR = existing.SESSIONS_DIR;
    if (existing.USAGE_FILE) config.USAGE_FILE = existing.USAGE_FILE;
  }

  return config;
}

// ── Summary and next steps ───────────────────────────────────────────

function printSummary(config: EnvConfig): void {
  const gwUrl = config.GATEWAY_URL || DEFAULTS.GATEWAY_URL;
  const agentName = config.AGENT_NAME || DEFAULTS.AGENT_NAME;
  const port = config.PORT || DEFAULTS.PORT;
  const sslPort = config.SSL_PORT || DEFAULTS.SSL_PORT;
  const host = config.HOST || DEFAULTS.HOST;
  const hasCerts = existsSync(resolve(PROJECT_ROOT, 'certs', 'cert.pem'));

  let ttsProvider = 'Edge (free)';
  if (config.OPENAI_API_KEY && config.REPLICATE_API_TOKEN) {
    ttsProvider = 'OpenAI + Replicate + Edge';
  } else if (config.OPENAI_API_KEY) {
    ttsProvider = 'OpenAI + Edge (fallback)';
  } else if (config.REPLICATE_API_TOKEN) {
    ttsProvider = 'Replicate + Edge (fallback)';
  }

  const hostLabel = host === '127.0.0.1' ? '127.0.0.1 (local only)' : `${host} (network)`;
  const authLabel = config.ROBIN_AUTH === 'true' ? '🔒 Enabled' : 'Disabled';

  if (process.env.ROBIN_INSTALLER) {
    // Rail-style summary — stays inside the installer's visual flow
    const r = `  \x1b[2m│\x1b[0m`;
    console.log('');
    console.log(`${r}  \x1b[2mGateway${' '.repeat(4)}\x1b[0m${gwUrl}`);
    console.log(`${r}  \x1b[2mAgent${' '.repeat(6)}\x1b[0m${agentName}`);
    console.log(`${r}  \x1b[2mHTTP${' '.repeat(7)}\x1b[0m:${port}`);
    if (hasCerts) {
      console.log(`${r}  \x1b[2mHTTPS${' '.repeat(6)}\x1b[0m:${sslPort}`);
    }
    console.log(`${r}  \x1b[2mTTS${' '.repeat(8)}\x1b[0m${ttsProvider}`);
    console.log(`${r}  \x1b[2mHost${' '.repeat(7)}\x1b[0m${hostLabel}`);
    console.log(`${r}  \x1b[2mAuth${' '.repeat(7)}\x1b[0m${authLabel}`);
  } else {
    // Standalone mode — boxed summary
    console.log('');
    console.log('  \x1b[2m┌─────────────────────────────────────────┐\x1b[0m');
    console.log(`  \x1b[2m│\x1b[0m  Gateway    ${gwUrl.padEnd(28)}\x1b[2m│\x1b[0m`);
    console.log(`  \x1b[2m│\x1b[0m  Agent      ${agentName.padEnd(28)}\x1b[2m│\x1b[0m`);
    console.log(`  \x1b[2m│\x1b[0m  HTTP       :${port.padEnd(27)}\x1b[2m│\x1b[0m`);
    if (hasCerts) {
      console.log(`  \x1b[2m│\x1b[0m  HTTPS      :${sslPort.padEnd(27)}\x1b[2m│\x1b[0m`);
    }
    console.log(`  \x1b[2m│\x1b[0m  TTS        ${ttsProvider.padEnd(28)}\x1b[2m│\x1b[0m`);
    console.log(`  \x1b[2m│\x1b[0m  Host       ${hostLabel.padEnd(28)}\x1b[2m│\x1b[0m`);
    console.log(`  \x1b[2m│\x1b[0m  Auth       ${authLabel.padEnd(28)}\x1b[2m│\x1b[0m`);
    console.log('  \x1b[2m└─────────────────────────────────────────┘\x1b[0m');
  }
}

function printNextSteps(config: EnvConfig): void {
  const port = config.PORT || DEFAULTS.PORT;
  console.log('');
  console.log('  \x1b[1mNext steps:\x1b[0m');
  console.log(`    Development:   \x1b[36mnpm run dev\x1b[0m && \x1b[36mnpm run dev:server\x1b[0m`);
  console.log(`    Production:    \x1b[36mnpm run prod\x1b[0m`);
  console.log('');
  console.log(`  Open \x1b[36mhttp://localhost:${port}\x1b[0m in your browser.`);
  console.log('');
}

// ── --check mode ─────────────────────────────────────────────────────

async function runCheck(config: EnvConfig): Promise<void> {
  console.log('');
  console.log('  \x1b[1mValidating configuration...\x1b[0m');
  console.log('');

  let errors = 0;

  // Gateway token (for local development, empty is acceptable)
  const isLocalGateway = ['127.0.0.1', 'localhost'].includes(config.GATEWAY_URL?.replace(/^https?:\/\//, '') || '');

  if (config.GATEWAY_TOKEN) {
    success('GATEWAY_TOKEN is set');
  } else if (isLocalGateway) {
    info('No GATEWAY_TOKEN (local gateway with no auth)');
  } else {
    fail('GATEWAY_TOKEN is missing (required for remote gateway)');
    errors++;
  }

  // Gateway URL
  const gwUrl = config.GATEWAY_URL || DEFAULTS.GATEWAY_URL;
  if (isValidUrl(gwUrl)) {
    success(`GATEWAY_URL is valid: ${gwUrl}`);

    // Test connectivity and token validity
    process.stdout.write('  Testing gateway connection... ');
    const gwTest = await testGatewayConnection(gwUrl, config.GATEWAY_TOKEN);
    if (gwTest.ok) {
      console.log(`\x1b[32m✓\x1b[0m ${gwTest.message}`);
    } else {
      console.log(`\x1b[31m✗\x1b[0m ${gwTest.message}`);
      errors++;
    }
  } else {
    fail(`GATEWAY_URL is invalid: ${gwUrl}`);
    errors++;
  }

  // Port
  const port = parseInt(config.PORT || DEFAULTS.PORT, 10);
  if (isValidPort(port)) {
    success(`PORT is valid: ${port}`);
  } else {
    fail(`PORT is invalid: ${config.PORT}`);
    errors++;
  }

  // TTS
  if (config.OPENAI_API_KEY) {
    success('OPENAI_API_KEY is set (OpenAI TTS + Whisper enabled)');
  } else {
    info('OPENAI_API_KEY not set (Edge TTS will be used as fallback)');
  }

  if (config.REPLICATE_API_TOKEN) {
    success('REPLICATE_API_TOKEN is set (Qwen TTS enabled)');
  } else {
    info('REPLICATE_API_TOKEN not set');
  }

  // Host binding
  const host = config.HOST || DEFAULTS.HOST;
  if (host === '0.0.0.0') {
    warn('HOST is 0.0.0.0 — server is accessible from the network');
  } else {
    success(`HOST: ${host}`);
  }

  // Auth
  if (config.ROBIN_AUTH === 'true') {
    success('Authentication is enabled');
    if (config.ROBIN_PASSWORD_HASH) {
      success('Password hash is set');
    } else if (config.GATEWAY_TOKEN) {
      info('No password hash — gateway token will be used as fallback');
    } else {
      fail('Auth is enabled but no password hash or gateway token is configured');
      errors++;
    }
    if (config.ROBIN_SESSION_SECRET) {
      success('Session secret is set');
    } else {
      warn('ROBIN_SESSION_SECRET not set — will be auto-generated (sessions won\'t survive restarts)');
    }
  } else if (host === '0.0.0.0') {
    warn('Authentication is DISABLED while server is network-exposed');
    dim('Run `npm run setup` to enable authentication');
  } else {
    info('Authentication disabled (localhost-only — OK)');
  }

  // HTTPS certs
  if (existsSync(resolve(PROJECT_ROOT, 'certs', 'cert.pem'))) {
    success('HTTPS certificates found at certs/');
  } else {
    info('No HTTPS certificates (HTTP only)');
  }

  console.log('');
  if (errors > 0) {
    fail(`${errors} issue(s) found. Run \x1b[36mnpm run setup\x1b[0m to fix.`);
    process.exit(1);
  } else {
    success('Configuration looks good!');
  }
  console.log('');
}

// ── --defaults mode ──────────────────────────────────────────────────

async function runDefaults(existing: EnvConfig, prereqs: PrereqResult): Promise<void> {
  console.log('');
  info('Non-interactive mode — using defaults where possible');
  console.log('');

  const config: EnvConfig = { ...existing };
  const followUpSteps: string[] = [];

  function appendFollowUp(steps: string[]): void {
    for (const step of steps) {
      if (step && !followUpSteps.includes(step)) followUpSteps.push(step);
    }
  }

  // Handle ROBIN Gateway auto-generation
  const HOME = process.env.HOME || os.homedir();
  const ROBIN_DIR = join(HOME, '.robin');
  const ROBIN_GATEWAY_CONFIG_PATH = join(ROBIN_DIR, 'gateway.json');

  // ROBIN Gateway is the only option in defaults mode
  dim('Setting up local ROBIN Gateway...');
  mkdirSync(ROBIN_DIR, { recursive: true });
  const robinToken = cryptoRandomBytes(32).toString('base64url');
  const robinConfig = {
    gateway: {
      port: 18789,
      bind: '127.0.0.1',
      auth: { mode: 'token', token: robinToken },
      controlUi: { allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'] },
      tools: {
        allow: [
          'bash',
          'powershell',
          'files_list',
          'files_read',
          'files_info',
          'memories_get',
          'sessions_spawn',
        ],
      },
    },
  };
  writeFileSync(ROBIN_GATEWAY_CONFIG_PATH, JSON.stringify(robinConfig, null, 2) + '\n');
  config.GATEWAY_TOKEN = robinToken;
  config.GATEWAY_URL = 'http://127.0.0.1:18789';
  success('Auto-generated ROBIN Gateway token at ~/.robin/gateway.json');

  // Start the gateway server
  dim('Starting ROBIN Gateway server...');
  startRobinGateway();

  // Give the server time to start (sleep in ms)
  await sleep(2000);

  if (requestedAccessMode) {
    // Ensure PORT is set before building access plan
    const port = String(config.PORT || DEFAULTS.PORT);
    const sslPort = config.SSL_PORT ? String(config.SSL_PORT) : undefined;
    const maybeRemoteHost = !isLoopback(config.HOST || '') ? config.HOST : detectPrimaryIpv4() || config.HOST || DEFAULTS.HOST;
    const remoteHost = (maybeRemoteHost as string | undefined)?.toString();

    let accessPlan = buildAccessPlan({
      profile: requestedAccessMode as InstallerAccessProfile,
      port,
      sslPort,
      remoteHost,
      tailscale: prereqs.tailscale,
    });

    if (requestedAccessMode === 'tailscale-serve' && accessPlan.followUpSteps.length > 0) {
      warn('Tailscale Serve could not be confirmed in non-interactive mode. Falling back to tailnet IP support only.');
      appendFollowUp(accessPlan.followUpSteps);
      const fallbackPort1 = String(config.PORT || DEFAULTS.PORT);
      accessPlan = buildAccessPlan({
        profile: 'tailscale-ip',
        port: fallbackPort1,
        tailscale: prereqs.tailscale,
      });
    }

    if ((requestedAccessMode === 'tailscale-ip' || requestedAccessMode === 'tailscale-serve') && accessPlan.followUpSteps.length > 0) {
      warn('Requested Tailscale access mode is not ready in non-interactive mode. Keeping localhost-only access for now.');
      appendFollowUp(accessPlan.followUpSteps);
      const fallbackPort2 = String(config.PORT || DEFAULTS.PORT);
      accessPlan = buildAccessPlan({ profile: 'local', port: fallbackPort2 });
    }

    delete config.ALLOWED_ORIGINS;
    delete config.CSP_CONNECT_EXTRA;
    delete config.WS_ALLOWED_HOSTS;
    Object.assign(config, applyAccessPlanToConfig(config, accessPlan));

    success(`Using access mode: ${accessPlan.profile}`);
    if (accessPlan.browserOrigins[0]) {
      dim(`Primary origin: ${accessPlan.browserOrigins[0]}`);
    }
  }

  // Auth: auto-enable when network-exposed with gateway token, generate session secret
  if (!config.ROBIN_SESSION_SECRET) {
    config.ROBIN_SESSION_SECRET = cryptoRandomBytes(32).toString('hex');
  }
  if (config.HOST === '0.0.0.0' && !config.ROBIN_AUTH) {
    if (config.GATEWAY_TOKEN) {
      config.ROBIN_AUTH = 'true';
      success('Authentication auto-enabled (gateway token can be used as password)');
    } else {
      warn('Network-exposed without authentication — consider running interactive setup');
    }
  }

  // Determine gateway type - check if using ROBIN Gateway (localhost:18789)
  const isRobinGateway = config.GATEWAY_URL?.includes('127.0.0.1:18789') || config.GATEWAY_URL?.includes('localhost:18789');

  process.stdout.write(`  Testing ${isRobinGateway ? 'ROBIN Gateway' : 'gateway'} connection... `);
  let gwTest: { ok: boolean; message: string };
  const doFetch = typeof fetch !== 'undefined' ? fetch : (await import('node-fetch')).default;

  if (isRobinGateway) {
    // Use direct health check for ROBIN Gateway
    try {
      const res = await doFetch(config.GATEWAY_URL! + '/health', { method: 'GET' });
      if (res.ok) {
        gwTest = { ok: true, message: 'ROBIN Gateway is running' };
      } else {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
    } catch (err: any) {
      gwTest = { ok: false, message: `Cannot reach gateway: ${err.message}` };
    }
  } else {
    // Use testGatewayConnection for remote gateway
    gwTest = await testGatewayConnection(config.GATEWAY_URL!, config.GATEWAY_TOKEN);
  }

  if (gwTest.ok) {
    console.log(`\x1b[32m✓\x1b[0m ${gwTest.message}`);
  } else {
    console.log(`\x1b[31m✗\x1b[0m ${gwTest.message}`);
    fail('Refusing to write .env because gateway auth could not be verified.');
    console.log('');
    process.exit(1);
  }

  if (existsSync(ENV_PATH)) {
    const backupPath = backupExistingEnv(ENV_PATH);
    info(`Previous config backed up to ${backupPath.replace(PROJECT_ROOT + '/', '')}`);
  }
  writeEnvFile(ENV_PATH, config);

  success('Configuration written to .env');

  installBundledSkills();

  printSummary(config);
  if (shouldPrintDeploymentGuides({ invokedFromInstaller: process.env.ROBIN_INSTALLER === '1', defaultsMode: true })) {
    printDeploymentGuides();
  }

  // ROBIN Gateway handles its own config internally - no external config needed

  if (followUpSteps.length > 0) {
    console.log('');
    warn('Additional follow-up is required:');
    for (const step of followUpSteps) {
      dim(`  • ${step}`);
    }
  }

  console.log('');
}

// ── Run ──────────────────────────────────────────────────────────────

main().catch((err) => {
  // ExitPromptError is thrown when user presses Ctrl+C during a prompt
  if (err?.name === 'ExitPromptError') {
    cleanupTmp(ENV_PATH);
    console.log('\n\n  Setup cancelled.\n');
    process.exit(130);
  }
  console.error('\n  Setup failed:', err.message || err);
  cleanupTmp(ENV_PATH);
  process.exit(1);
});
