#!/usr/bin/env -S tsx run
/**
 * ROBIN Gateway Token Generator
 * 
 * Creates a gateway configuration with an auto-generated token.
 * Intended to replace the OpenClaw gateway setup for local-only operation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME = process.env.HOME || os.homedir();
const ROBIN_DIR = join(HOME, '.robin');
const CONFIG_PATH = join(ROBIN_DIR, 'gateway.json');

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function getDefaultConfig(token: string): Record<string, unknown> {
  return {
    gateway: {
      port: 18789,
      bind: '127.0.0.1',
      auth: {
        mode: 'token',
        token: token,
      },
      controlUi: {
        allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      },
      tools: {
        allow: ['bash', 'powershell', 'files_list', 'files_read', 'files_read_docx', 'files_info', 'memories_get', 'sessions_spawn'],
      },
    },
  };
}

async function main() {
  console.log('\n\x1b[36mROBIN Gateway Setup\x1b[0m');
  console.log('────────────────────\n');

  interface GatewayAuth { mode?: 'token' | 'none'; token?: string }
  interface GatewayConfig { gateway?: { port: number; bind: string; auth?: GatewayAuth } }

  // Check if already configured
  if (existsSync(CONFIG_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as GatewayConfig;
      const currentToken = existing.gateway?.auth?.token;
      
      if (currentToken) {
        const ans = process.stdin.isTTY ? await prompt('Gateway already configured. Replace token? (y/N): ') : 'n';
        if (ans.toLowerCase() !== 'y') {
          console.log('\nKeeping existing configuration.');
          return;
        }
      }
    } catch {
      // File exists but can't parse - proceed with overwrite
    }
  }

  // Generate new token
  const token = generateToken();
  console.log(`\n\x1b[32m✓ Generated gateway token:\x1b[0m`);
  console.log(`  ${token}`);
  
  // Confirm security mode
  let authMode: 'none' | 'token' = 'token';
  if (process.stdin.isTTY) {
    const ans = await prompt('\nSecurity level:\n[1] Development (no authentication)\n[2] Production (token required - recommended)\n\nSelect [1-2]: ');
    authMode = ans === '1' ? 'none' : 'token';
  }

  // Create config
  mkdirSync(ROBIN_DIR, { recursive: true });

  const config: GatewayConfig = getDefaultConfig(token) as GatewayConfig;
  if (authMode === 'none' && config.gateway) {
    delete config.gateway.auth;
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  console.log(`\n\x1b[32m✓ Configuration saved to:\x1b[0m ${CONFIG_PATH}`);
  console.log('\n\x1b[36mNext steps:\x1b[0m');
  if (authMode === 'token') {
    console.log('  1. Add this line to your ROBIN .env file:');
    console.log(`     GATEWAY_TOKEN=${token}`);
    console.log('  2. Restart the ROBIN server');
  } else {
    console.log('  1. Add to .env: NO_GATEWAY_AUTH=true');
    console.log('  2. Restart the ROBIN server');
  }
  console.log('');
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    let data = '';
    stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        stdin.removeAllListeners();
        resolve(data.trim());
      }
    });
  });
}

main().catch((err) => {
  console.error('\x1b[31mError:\x1b[0m', err.message);
  process.exit(1);
});
