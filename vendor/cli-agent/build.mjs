/**
 * Build script for Claude Code (external/non-Bun build).
 *
 * Uses esbuild to transpile all TS/TSX → JS while preserving directory
 * structure. Handles:
 *   1. bun:bundle → shim where feature() always returns false
 *   2. bun:ffi → shim with no-op exports
 *   3. MACRO.VERSION / MACRO.PACKAGE_URL etc. → real values
 *   4. .js extension imports (TypeScript ESM convention) → resolved correctly
 *
 * Output: dist/  (mirrors src/ structure as runnable ESM JavaScript)
 *         cli.js (root entry point that loads dist/entrypoints/cli.js)
 *
 * Usage: node build.mjs
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync } from 'fs';
import { basename, extname, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const DIST = join(__dirname, 'dist');
const TEXT_ASSET_EXTENSIONS = new Set(['.md', '.txt', '.yaml', '.yml', '.html', '.css', '.svg']);
const URL_ASSET_EXTENSIONS = new Set(['.png']);

function toImportSpecifier(value) {
  return value.split('\\').join('/');
}

console.log(`\n  Building Inerti.ai Ops CLI v${pkg.version}\n`);

// ── Step 0: Clean previous build ────────────────────────────────────────
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
  console.log('  ✓ Cleaned previous dist/');
}

// ── Step 1: Discover all TS/TSX source files ────────────────────────────
function walkDir(dir, exts) {
  const results = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'typings') continue;
        walk(full);
      } else if (exts.some(ext => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

const srcDir = join(__dirname, 'src');
const vendorDir = join(__dirname, 'vendor');
const srcFiles = walkDir(srcDir, ['.ts', '.tsx']);
const vendorFiles = existsSync(vendorDir) ? walkDir(vendorDir, ['.ts', '.tsx']) : [];
const allFiles = [...srcFiles, ...vendorFiles];

console.log(`  ✓ Found ${srcFiles.length} source files + ${vendorFiles.length} vendor files`);

// ── Step 2: Build with esbuild (transpile-only, no bundling) ────────────
// Note: esbuild plugins only work in bundle mode, so we post-process
// the output to replace bun:bundle / bun:ffi imports.
console.log('  ⏳ Transpiling TypeScript → JavaScript...');

try {
  await esbuild.build({
    entryPoints: allFiles,
    outdir: DIST,
    outbase: __dirname,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    jsx: 'automatic',
    bundle: false,
    define: {
      'MACRO.VERSION': JSON.stringify(pkg.version),
      'MACRO.PACKAGE_URL': JSON.stringify(pkg.homepage || 'https://github.com/anthropics/claude-code'),
      'MACRO.NATIVE_PACKAGE_URL': JSON.stringify('https://github.com/anthropics/claude-code'),
      'MACRO.FEEDBACK_CHANNEL': JSON.stringify('https://github.com/anthropics/claude-code/issues'),
    },
    logLevel: 'warning',
    logOverride: {
      // Expected in this transpile-only pipeline. We inject createRequire shims
      // in post-processing for runtime compatibility.
      'unsupported-require-call': 'silent',
      // False-positive in certain transpiled arrow-function contexts.
      'suspicious-logical-operator': 'silent',
    },
  });

  const outFiles = walkDir(DIST, ['.js', '.mjs']);
  console.log(`  ✓ Transpiled ${outFiles.length} files → dist/`);
} catch (err) {
  console.error('  ✗ esbuild transpilation failed:', err.message);
  process.exit(1);
}

// ── Step 3: Post-process — replace bun:bundle and bun:ffi imports ───────
console.log('  ⏳ Patching bun:bundle / bun:ffi imports...');

const BUN_BUNDLE_SHIM = `const feature = (name) => false;`;
const BUN_FFI_SHIM = `const dlopen = () => { throw new Error("bun:ffi not available"); };
const ptr = () => 0;
const toBuffer = () => Buffer.alloc(0);
const toArrayBuffer = () => new ArrayBuffer(0);
const CString = () => "";
const suffix = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";`;
const REQUIRE_SHIM = `import { createRequire as __inertiaiCreateRequire } from "node:module";
const require = __inertiaiCreateRequire(import.meta.url);`;

const distJsFiles = walkDir(DIST, ['.js']);
let patchedCount = 0;
let requireShimCount = 0;
for (const f of distJsFiles) {
  let code = readFileSync(f, 'utf-8');
  let changed = false;

  // Replace: import { feature } from "bun:bundle";
  // Also handles: import { feature } from 'bun:bundle';
  if (code.includes('bun:bundle')) {
    code = code.replace(
      /import\s*\{[^}]*\}\s*from\s*["']bun:bundle["']\s*;?/g,
      BUN_BUNDLE_SHIM
    );
    changed = true;
  }

  // Replace: import { ... } from "bun:ffi";
  if (code.includes('bun:ffi')) {
    code = code.replace(
      /import\s*\{[^}]*\}\s*from\s*["']bun:ffi["']\s*;?/g,
      BUN_FFI_SHIM
    );
    changed = true;
  }

  if (/\brequire\s*\(/.test(code) && !code.includes('__inertiaiCreateRequire')) {
    code = `${REQUIRE_SHIM}\n${code}`;
    changed = true;
    requireShimCount++;
  }

  if (changed) {
    writeFileSync(f, code);
    patchedCount++;
  }
}
console.log(`  ✓ Patched ${patchedCount} files with bun: shims`);
if (requireShimCount > 0) console.log(`  ✓ Injected createRequire shims in ${requireShimCount} files`);

// ── Step 3b: Rewrite bare "src/" imports to relative paths ─────────────
// The source uses tsconfig paths like `import ... from 'src/utils/foo.js'`.
// TypeScript resolves these via baseUrl, but Node.js can't. We convert them
// to relative paths based on each file's position within dist/src/.
console.log('  ⏳ Rewriting bare src/ imports to relative paths...');

const distSrcDir = join(DIST, 'src');
let srcImportCount = 0;
for (const f of distJsFiles) {
  let code = readFileSync(f, 'utf-8');
  if (!code.includes('"src/') && !code.includes("'src/")) continue;

  const fileDir = dirname(f);
  // Only rewrite files inside dist/src/
  if (!f.startsWith(distSrcDir)) continue;

  const fileDirRelToSrc = relative(distSrcDir, fileDir); // e.g. "utils/model"

  code = code.replace(
    /(from\s+["'])src\/([^"']+)(["'])/g,
    (match, prefix, importPath, suffix) => {
      // importPath is e.g. "utils/debug.js" or "components/Markdown.js"
      // We need the relative path from the current file's dir to dist/src/<importPath>
      const targetFromSrc = importPath; // already relative to src/
      let rel = toImportSpecifier(relative(fileDirRelToSrc, targetFromSrc));
      // Ensure it starts with ./ or ../
      if (!rel.startsWith('.')) rel = './' + rel;
      return prefix + rel + suffix;
    }
  );

  // Also handle dynamic import("src/...")
  code = code.replace(
    /(import\s*\(\s*["'])src\/([^"']+)(["']\s*\))/g,
    (match, prefix, importPath, suffix) => {
      const targetFromSrc = importPath;
      let rel = toImportSpecifier(relative(fileDirRelToSrc, targetFromSrc));
      if (!rel.startsWith('.')) rel = './' + rel;
      return prefix + rel + suffix;
    }
  );

  writeFileSync(f, code);
  srcImportCount++;
}
console.log(`  ✓ Rewrote bare src/ imports in ${srcImportCount} files`);

// ── Step 3c: Rewrite .jsx → .js in imports ──────────────────────────────
// esbuild outputs .tsx → .js but some imports reference .jsx explicitly
let jsxFixCount = 0;
for (const f of distJsFiles) {
  let code = readFileSync(f, 'utf-8');
  if (!code.includes('.jsx')) continue;
  const updated = code.replace(/(from\s+["'][^"']*?)\.jsx(["'])/g, '$1.js$2')
                       .replace(/(import\s*\(\s*["'][^"']*?)\.jsx(["']\s*\))/g, '$1.js$2');
  if (updated !== code) {
    writeFileSync(f, updated);
    jsxFixCount++;
  }
}
if (jsxFixCount > 0) console.log(`  ✓ Fixed .jsx → .js in ${jsxFixCount} files`);

// ── Step 3c2: Strip .d.ts imports (type-only, not valid at runtime) ─────
let dtsStripCount = 0;
for (const f of distJsFiles) {
  let code = readFileSync(f, 'utf-8');
  if (!code.includes('.d.ts')) continue;
  const updated = code.replace(/^import\s+.*["'][^"']*\.d\.ts["']\s*;?\s*$/gm, '// [stripped .d.ts import]');
  if (updated !== code) {
    writeFileSync(f, updated);
    dtsStripCount++;
  }
}
if (dtsStripCount > 0) console.log(`  ✓ Stripped .d.ts imports in ${dtsStripCount} files`);

// ── Step 3d: Generate empty stubs for missing internal modules ──────────
// Many imports reference Anthropic-internal modules (commands, types, tools)
// that were stripped from the public source. We create empty ES module stubs
// so Node.js can resolve them at runtime (they export nothing).
console.log('  ⏳ Generating stubs for missing internal modules...');

let stubCount = 0;
for (const f of distJsFiles) {
  const code = readFileSync(f, 'utf-8');
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const importPath = m[1];
    const resolved = join(dirname(f), importPath);
    if (!existsSync(resolved)) {
      mkdirSync(dirname(resolved), { recursive: true });
      if (resolved.endsWith('.js')) {
        writeFileSync(resolved, '// Auto-generated empty stub for missing internal module\nexport default null;\n');
        stubCount++;
      } else if (TEXT_ASSET_EXTENSIONS.has(extname(resolved).toLowerCase())) {
        writeFileSync(resolved, '');
        writeFileSync(`${resolved}.js`, 'export default "";\n');
        stubCount++;
      } else if (URL_ASSET_EXTENSIONS.has(extname(resolved).toLowerCase())) {
        writeFileSync(resolved, '');
        writeFileSync(
          `${resolved}.js`,
          `export default new URL(${JSON.stringify(`./${basename(resolved)}`)}, import.meta.url).toString();\n`,
        );
        stubCount++;
      }
    }
  }
}
console.log(`  ✓ Generated ${stubCount} empty module stubs`);

// ── Step 3e: Create runtime shims for @ant/* and internal packages ──────
// tsconfig paths only work for TypeScript. At runtime, Node.js needs
// actual packages in node_modules for bare specifier resolution.
console.log('  ⏳ Creating runtime shims for internal packages...');

const internalPackages = [
  '@ant/claude-for-chrome-mcp',
  '@ant/computer-use-input',
  '@ant/computer-use-mcp',
  '@ant/computer-use-mcp/types',
  '@ant/computer-use-mcp/sentinelApps',
  '@ant/computer-use-swift',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sandbox-runtime',
  'image-processor-napi',
  'audio-capture-napi',
  'url-handler-napi',
  'color-diff-napi',
];
const internalPackageSet = new Set(internalPackages);
const internalPackageExports = new Map();

for (const f of distJsFiles) {
  const code = readFileSync(f, 'utf-8');
  const importRegex = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const clause = match[1];
    const specifier = match[2];
    if (!internalPackageSet.has(specifier)) continue;

    const braceMatch = clause.match(/\{([^}]+)\}/);
    if (!braceMatch) continue;

    const exportNames = internalPackageExports.get(specifier) ?? new Set();
    for (const rawPart of braceMatch[1].split(',')) {
      const importedName = rawPart.split(/\s+as\s+/i)[0]?.trim();
      if (!importedName) continue;
      exportNames.add(importedName);
    }
    internalPackageExports.set(specifier, exportNames);
  }
}

function buildStubModule(specifier) {
  const exportNames = Array.from(internalPackageExports.get(specifier) ?? []).sort();
  const lines = [
    'const stubTarget = function inertiaiStub() {};',
    'const stub = new Proxy(stubTarget, {',
    '  get: () => stub,',
    '  apply: () => undefined,',
    '  construct: () => ({})',
    '});',
    'export default stub;',
  ];

  for (const name of exportNames) {
    if (name === 'default') continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
    lines.push(`export const ${name} = stub;`);
  }

  return `${lines.join('\n')}\n`;
}

let shimCount = 0;
for (const pkg of internalPackages) {
  // Handle subpath exports like @ant/computer-use-mcp/types
  const parts = pkg.startsWith('@') ? pkg.split('/') : [pkg];
  let pkgName, subpath;
  if (parts[0].startsWith('@')) {
    pkgName = parts[0] + '/' + parts[1];
    subpath = parts.slice(2).join('/');
  } else {
    pkgName = parts[0];
    subpath = parts.slice(1).join('/');
  }

  const pkgDir = join(__dirname, 'node_modules', pkgName);
  if (!existsSync(pkgDir)) {
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: pkgName,
      version: '0.0.0-stub',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js', './*': './*.js' },
    }, null, 2));
    shimCount++;
  }
  writeFileSync(join(pkgDir, 'index.js'), buildStubModule(pkgName));

  // Create subpath file if needed
  if (subpath) {
    const subFile = join(pkgDir, subpath + '.js');
    mkdirSync(dirname(subFile), { recursive: true });
    writeFileSync(subFile, buildStubModule(pkg));
  }
}
console.log(`  ✓ Created ${shimCount} runtime package shims`);

// ── Step 4: Copy non-TS assets (JSON, etc.) ─────────────────────────────
const assetExts = ['.json', '.md', '.txt', '.yaml', '.yml', '.html', '.css', '.svg', '.png'];
const assetFiles = walkDir(srcDir, assetExts);
for (const f of assetFiles) {
  const rel = relative(__dirname, f);
  const dest = join(DIST, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(f, dest);

  const extension = extname(f).toLowerCase();
  if (TEXT_ASSET_EXTENSIONS.has(extension)) {
    const assetContents = readFileSync(f, 'utf-8');
    writeFileSync(`${dest}.js`, `export default ${JSON.stringify(assetContents)};\n`);
    continue;
  }

  if (URL_ASSET_EXTENSIONS.has(extension)) {
    const fileName = rel.split('\\').join('/').split('/').pop();
    writeFileSync(
      `${dest}.js`,
      `export default new URL(${JSON.stringify(`./${fileName}`)}, import.meta.url).toString();\n`,
    );
  }
}
if (assetFiles.length > 0) {
  console.log(`  ✓ Copied ${assetFiles.length} asset files`);
}

// ── Step 4b: Redirect raw asset imports to generated JS wrappers ────────
let assetImportFixCount = 0;
for (const f of distJsFiles) {
  let code = readFileSync(f, 'utf-8');
  const updated = code
    .replace(
      /((?:import|export)\s[\s\S]*?\sfrom\s*["'][^"']+\.(?:md|txt|yaml|yml|html|css|svg|png))(["'])/g,
      '$1.js$2',
    )
    .replace(
      /(^\s*import\s*["'][^"']+\.(?:md|txt|yaml|yml|html|css|svg|png))(["'])/gm,
      '$1.js$2',
    )
    .replace(
      /(import\s*\(\s*["'][^"']+\.(?:md|txt|yaml|yml|html|css|svg|png))(["']\s*\))/g,
      '$1.js$2',
    );

  if (updated !== code) {
    writeFileSync(f, updated);
    assetImportFixCount++;
  }
}
if (assetImportFixCount > 0) console.log(`  ✓ Redirected asset imports in ${assetImportFixCount} files`);

// ── Step 5: Create root cli.js entry point ──────────────────────────────
writeFileSync(join(__dirname, 'cli.js'), `#!/usr/bin/env node
// Auto-generated by build.mjs — Inerti.ai Ops CLI v${pkg.version}
// Entry point that loads the transpiled CLI.
import './dist/src/entrypoints/cli.js';
`);
console.log('  ✓ Created cli.js entry point');

console.log(`\n  Build complete! 🎉\n`);
console.log(`  Run with:  node cli.js\n`);
