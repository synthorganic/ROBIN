import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const cliRoot = path.resolve(appRoot, 'vendor', 'cli-agent');
const cliEntry = path.join(cliRoot, 'cli.js');
const cliDistEntry = path.join(cliRoot, 'dist', 'src', 'entrypoints', 'cli.js');
const cliNodeModules = path.join(cliRoot, 'node_modules');
const compatibilityMarker = path.join(cliNodeModules, '.inertiai-ops-cli-patched');
const npmCliPath =
  process.env.npm_execpath ||
  (process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null);
const mode = process.argv[2] ?? 'launch';
const forwardedArgs = process.argv.slice(3);
const configDir =
  process.env.INERTIAI_OPS_CLI_CONFIG_DIR ??
  process.env.CLAUDE_CONFIG_DIR ??
  path.join(os.homedir(), '.inertiai-ops', 'cli-agent');

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function ensureCliPresent() {
  if (!existsSync(path.join(cliRoot, 'package.json'))) {
    fail(`[ROBIN CLI] missing vendored runtime at ${cliRoot}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    fail(`[ROBIN CLI] failed to run ${command}: ${result.error.message}`);
  }
}

function ensureDependenciesInstalled() {
  if (existsSync(cliNodeModules)) return;
  console.log('[ROBIN CLI] installing vendored dependencies...');
  // Rollup ships platform binaries as optional deps; force-include them to
  // avoid npm optional-dependency omission bugs on some environments.
  runNpm(['ci', '--include=optional']);
}

function ensureEsbuildBinaryCompatibility() {
  const esbuildPkgPath = path.join(cliNodeModules, 'esbuild', 'package.json');
  if (!existsSync(esbuildPkgPath)) return;
  const esbuildMainPath = path.join(cliNodeModules, 'esbuild', 'lib', 'main.js');

  const esbuildBinPath = path.join(cliNodeModules, 'esbuild', 'bin', 'esbuild');
  if (!existsSync(esbuildBinPath)) return;

  const versionProbe = spawnSync(process.execPath, [esbuildBinPath, '--version'], {
    cwd: cliRoot,
    env: process.env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const binaryVersion = typeof versionProbe.stdout === 'string' ? versionProbe.stdout.trim() : '';
  if (!binaryVersion || versionProbe.status !== 0) return;

  const pkg = JSON.parse(readFileSync(esbuildPkgPath, 'utf8'));
  const packageVersion = typeof pkg.version === 'string' ? pkg.version : '';
  const mainSource = existsSync(esbuildMainPath) ? readFileSync(esbuildMainPath, 'utf8') : '';
  const hostMainMatches = mainSource.includes(`"${binaryVersion}"`);
  if (packageVersion === binaryVersion && hostMainMatches) return;

  if (packageVersion !== binaryVersion) {
    pkg.version = binaryVersion;
    if (pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object') {
      for (const key of Object.keys(pkg.optionalDependencies)) {
        if (key.startsWith('@esbuild/')) {
          pkg.optionalDependencies[key] = binaryVersion;
        }
      }
    }
    writeFileSync(esbuildPkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[ROBIN CLI] patched esbuild package metadata ${packageVersion || 'unknown'} -> ${binaryVersion}`);
  }

  if (mainSource) {
    const patchedMain = mainSource.replace(/"0\.\d+\.\d+"/g, `"${binaryVersion}"`);
    if (patchedMain !== mainSource) {
      writeFileSync(esbuildMainPath, patchedMain);
      console.log(`[ROBIN CLI] patched esbuild host runtime to ${binaryVersion}`);
    }
  }
}

function ensureBuild(force = false) {
  if (!force && existsSync(cliDistEntry)) return;
  console.log('[ROBIN CLI] building embedded runtime...');
  ensureEsbuildBinaryCompatibility();
  runNpm(['run', 'build']);
}

function walkJsFiles(dir, bucket = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, bucket);
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.js')) {
      bucket.push(fullPath);
    }
  }

  return bucket;
}

function resolveImportReplacement(filePath, specifier) {
  if (!specifier.startsWith('.')) return null;
  if (/[?#]/.test(specifier)) return null;
  if (/\.(?:[cm]?js|json|node)$/i.test(specifier)) return null;

  const absolute = path.resolve(path.dirname(filePath), specifier);
  if (existsSync(`${absolute}.js`)) {
    return `${specifier}.js`;
  }

  if (existsSync(path.join(absolute, 'index.js'))) {
    return `${specifier}/index.js`;
  }

  return null;
}

function patchRelativeImportSpecifiers(code, filePath) {
  let changed = false;
  const applySpecifierPatch = (match, prefix, specifier, suffix) => {
    const replacement = resolveImportReplacement(filePath, specifier);
    if (!replacement) return match;
    changed = true;
    return `${prefix}${replacement}${suffix}`;
  };

  let nextCode = code.replace(
    /((?:import|export)\s[\s\S]*?\sfrom\s*["'])(\.\.?\/[^"'?#]+)(["'])/g,
    applySpecifierPatch,
  );
  nextCode = nextCode.replace(
    /(^\s*import\s*["'])(\.\.?\/[^"'?#]+)(["'])/gm,
    applySpecifierPatch,
  );
  nextCode = nextCode.replace(
    /(import\s*\(\s*["'])(\.\.?\/[^"'?#]+)(["']\s*\))/g,
    applySpecifierPatch,
  );

  return { changed, code: nextCode };
}

function ensureDependencyCompatibility() {
  if (!existsSync(cliNodeModules) || existsSync(compatibilityMarker)) return;

  console.log('[ROBIN CLI] normalizing vendored ESM dependency imports...');

  let patchedFiles = 0;
  for (const filePath of walkJsFiles(cliNodeModules)) {
    const source = readFileSync(filePath, 'utf8');
    if (
      !source.includes("from './") &&
      !source.includes('from "./') &&
      !source.includes("from '../") &&
      !source.includes('from "../') &&
      !source.includes("import('./") &&
      !source.includes('import("./') &&
      !source.includes("import '../") &&
      !source.includes('import "../')
    ) {
      continue;
    }

    const { changed, code } = patchRelativeImportSpecifiers(source, filePath);
    if (!changed || code === source) continue;
    writeFileSync(filePath, code);
    patchedFiles += 1;
  }

  writeFileSync(compatibilityMarker, JSON.stringify({ patchedFiles }, null, 2));
  console.log(`[ROBIN CLI] patched ${patchedFiles} dependency files for Node ESM.`);
}

function runNpm(args) {
  if (npmCliPath) {
    run(process.execPath, [npmCliPath, ...args], cliRoot);
    return;
  }

  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cliRoot);
}

function launchCli(args) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: appRoot,
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      INERTIAI_OPS_CLI_SOURCE: cliRoot,
      INERTIAI_OPS_CLI_CONFIG_DIR: configDir,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? configDir,
    },
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    fail(`[ROBIN CLI] launch failed: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

ensureCliPresent();

switch (mode) {
  case 'build':
    ensureDependenciesInstalled();
    ensureDependencyCompatibility();
    ensureBuild(false);
    break;
  case 'launch':
    ensureDependenciesInstalled();
    ensureDependencyCompatibility();
    ensureBuild(false);
    launchCli(forwardedArgs);
    break;
  default:
    fail(`[ROBIN CLI] unknown mode '${mode}'`);
}
