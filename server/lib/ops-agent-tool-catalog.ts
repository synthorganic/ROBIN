import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface OpsAgentToolCatalogItem {
  id: string;
  directoryName: string;
  displayName: string;
  aliases: string[];
  category: string;
  description: string;
  promptExcerpt: string;
  promptPath?: string;
  toolPath?: string;
}

export interface OpsAgentToolCatalog {
  sourcePath: string;
  tools: OpsAgentToolCatalogItem[];
  generatedAt: string;
}

const CATALOG_TTL_MS = 30_000;
const PROMPT_EXCERPT_LIMIT = 1400;
const REPO_ROOT = path.resolve(process.cwd());
const SOURCE_TOOL_PATH = path.join(REPO_ROOT, 'vendor', 'cli-agent', 'src', 'tools');

let cachedCatalog: OpsAgentToolCatalog | null = null;
let cachedAt = 0;

function candidateSourcePaths() {
  return [
    process.env.OPS_AGENT_TOOLS_SOURCE,
    SOURCE_TOOL_PATH,
  ].filter((value): value is string => Boolean(value));
}

function normalizePath(value: string) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isRepoScopedPath(value: string) {
  const resolved = normalizePath(path.resolve(value));
  const root = normalizePath(REPO_ROOT);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function pathExists(value: string) {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveSourcePath() {
  for (const candidate of candidateSourcePaths()) {
    if (!isRepoScopedPath(candidate)) continue;
    if (await pathExists(candidate)) return candidate;
  }
  return SOURCE_TOOL_PATH;
}

function extractConstants(raw: string, suffix: string) {
  const names = new Set<string>();
  const pattern = new RegExp(`export\\s+const\\s+[A-Z0-9_]*${suffix}\\w*\\s*(?::[^=]+)?=\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  for (const match of raw.matchAll(pattern)) {
    if (match[1]) names.add(match[1].trim());
  }
  return [...names];
}

function extractDescription(raw: string) {
  const descriptionPattern = /export\s+const\s+(?:\w+_)?DESCRIPTION\s*(?::[^=]+)?=\s*([`'"])([\s\S]*?)\1/m;
  const match = raw.match(descriptionPattern);
  if (!match?.[2]) return '';
  return match[2]
    .replace(/\$\{[\s\S]*?\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanPrompt(raw: string) {
  return raw
    .replace(/^import .*$/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROMPT_EXCERPT_LIMIT);
}

function categoryForTool(name: string) {
  const value = name.toLowerCase();
  if (/(read|write|edit|grep|glob|notebook|lsp)/.test(value)) return 'workspace';
  if (/(bash|powershell|repl|sleep|synthetic)/.test(value)) return 'runtime';
  if (/(web|mcp|resource|auth|toolsearch)/.test(value)) return 'external';
  if (/(agent|task|team|sendmessage|cron|remote)/.test(value)) return 'orchestration';
  if (/(plan|worktree|config|todo|question|brief|skill)/.test(value)) return 'coordination';
  return 'utility';
}

function fallbackDescription(name: string) {
  return `${name.replace(/Tool$/, '')} tool mapped from the Robin-Ops tool source.`;
}

async function readIfExists(filePath: string) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function catalogDirectory(sourcePath: string, directoryName: string): Promise<OpsAgentToolCatalogItem | null> {
  const dirPath = path.join(sourcePath, directoryName);
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const promptPath = fileNames.includes('prompt.ts') ? path.join(dirPath, 'prompt.ts') : undefined;
  const constantsPath = fileNames.includes('constants.ts') ? path.join(dirPath, 'constants.ts') : undefined;
  const toolNamePath = fileNames.includes('toolName.ts') ? path.join(dirPath, 'toolName.ts') : undefined;
  const toolFile = fileNames.find((name) => /Tool\.(ts|tsx)$/.test(name));
  const toolPath = toolFile ? path.join(dirPath, toolFile) : undefined;
  if (!promptPath && !toolPath && !constantsPath && !toolNamePath) return null;

  const promptRaw = promptPath ? await readIfExists(promptPath) : '';
  const constantsRaw = constantsPath ? await readIfExists(constantsPath) : '';
  const toolNameRaw = toolNamePath ? await readIfExists(toolNamePath) : '';
  const combined = [promptRaw, constantsRaw, toolNameRaw].join('\n');
  const aliases = Array.from(new Set([
    ...extractConstants(combined, 'TOOL_NAME'),
    ...extractConstants(combined, 'BRIEF_TOOL_NAME'),
  ])).filter((name) => name.length <= 80);
  const displayName = aliases[0] || directoryName.replace(/Tool$/, '');
  const description = extractDescription(promptRaw) || fallbackDescription(displayName);

  return {
    id: directoryName,
    directoryName,
    displayName,
    aliases: aliases.filter((alias) => alias !== displayName),
    category: categoryForTool(directoryName),
    description,
    promptExcerpt: cleanPrompt(promptRaw || constantsRaw || toolNameRaw),
    promptPath,
    toolPath,
  };
}

export async function getOpsAgentToolCatalog(force = false): Promise<OpsAgentToolCatalog> {
  if (!force && cachedCatalog && Date.now() - cachedAt < CATALOG_TTL_MS) {
    return cachedCatalog;
  }

  const sourcePath = await resolveSourcePath();
  const entries = await readdir(sourcePath, { withFileTypes: true }).catch(() => []);
  const tools = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => entry.name !== 'shared')
        .map((entry) => catalogDirectory(sourcePath, entry.name)),
    )
  )
    .filter((item): item is OpsAgentToolCatalogItem => Boolean(item))
    .sort((left, right) => left.category.localeCompare(right.category) || left.displayName.localeCompare(right.displayName));

  cachedCatalog = {
    sourcePath,
    tools,
    generatedAt: new Date().toISOString(),
  };
  cachedAt = Date.now();
  return cachedCatalog;
}

export async function buildOpsAgentToolContext(selectedToolIds?: string[]) {
  const catalog = await getOpsAgentToolCatalog();
  if (catalog.tools.length === 0) {
    return 'No Robin-Ops tool catalog entries are currently available.';
  }

  const selected = new Set(selectedToolIds ?? []);

  // Build the base catalog info
  const compactLines = catalog.tools.map((tool) => {
    const aliases = tool.aliases.length ? ` aliases=${tool.aliases.join(',')}` : '';
    return `- ${tool.displayName} (${tool.category})${aliases}: ${tool.description.slice(0, 180)}`;
  });

  // Add execute routes documentation if PowerShell is available
  const hasPowerShell = catalog.tools.some(t =>
    t.displayName.toLowerCase().includes('powershell') ||
    t.id.toLowerCase().includes('powershell')
  );

  const executeDocs = hasPowerShell ? [
    '',
    'ROBIN Execute Routes (direct command execution):',
    '- For immediate PowerShell or bash execution, use POST /api/execute/powershell or POST /api/execute/bash',
    '- These routes support: command (required), timeoutMs, description parameters',
    '- Use these for one-off commands rather than creating cron jobs',
    '- Requires GATEWAY_TOKEN configured in the server',
  ] : [];

  const detailed = catalog.tools
    .filter((tool) => selected.has(tool.id) || selected.has(tool.displayName))
    .slice(0, 8)
    .map((tool) => `\n${tool.displayName} detailed prompt excerpt:\n${tool.promptExcerpt}`);

  return [
    `Robin-Ops tool catalog mapped from ${catalog.sourcePath}.`,
    'When a task calls for a tool, name the tool and provide concrete arguments. Prefer project documents and file paths exactly as provided.',
    ...compactLines,
    ...detailed,
    ...executeDocs,
  ].join('\n');
}
