/**
 * Skills API Routes
 *
 * GET /api/skills — List ROBIN skills from the repo, agent workspace, and
 * bundled Robin-Ops skill sources without invoking external CLIs.
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimitGeneral } from '../middleware/rate-limit.js';
import { InvalidAgentIdError, resolveAgentWorkspace } from '../lib/agent-workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const REPO_SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');
const BUNDLED_SKILLS_DIR = path.join(PROJECT_ROOT, 'vendor', 'cli-agent', 'src', 'skills', 'bundled');

interface SkillMissing {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
}

interface RawSkill {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  missing?: SkillMissing;
}

const app = new Hono();

function parseFrontmatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: {}, body: markdown };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const delimiterIndex = line.indexOf(':');
    if (delimiterIndex <= 0) continue;
    const key = line.slice(0, delimiterIndex).trim();
    const value = line.slice(delimiterIndex + 1).trim();
    if (key && value) fields[key] = value.replace(/^['"]|['"]$/g, '');
  }

  return { fields, body: markdown.slice(match[0].length) };
}

function firstDescriptionLine(markdownBody: string): string {
  const lines = markdownBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  return lines[0] || 'Skill available in ROBIN.';
}

async function findSkillMarkdownFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const discovered: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        discovered.push(...await findSkillMarkdownFiles(fullPath));
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        discovered.push(fullPath);
      }
    }

    return discovered;
  } catch {
    return [];
  }
}

async function readMarkdownSkill(filePath: string, source: 'workspace' | 'bundled'): Promise<RawSkill | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const { fields, body } = parseFrontmatter(raw);
    const name = fields.name?.trim() || path.basename(path.dirname(filePath));
    if (!name) return null;

    return {
      name,
      description: fields.description?.trim() || firstDescriptionLine(body),
      emoji: fields.emoji?.trim() || '',
      eligible: true,
      disabled: false,
      blockedByAllowlist: false,
      source,
      bundled: source === 'bundled',
      ...(fields.homepage?.trim() ? { homepage: fields.homepage.trim() } : {}),
    };
  } catch {
    return null;
  }
}

function parseBundledSkillSource(raw: string, filePath: string): RawSkill | null {
  if (!raw.includes('registerBundledSkill({')) return null;
  if (/\buserInvocable:\s*false\b/.test(raw)) return null;

  const name = raw.match(/\bname:\s*['"`]([^'"`]+)['"`]/)?.[1]?.trim();
  if (!name) return null;

  const directDescription = raw.match(/\bdescription:\s*['"`]([\s\S]*?)['"`]\s*,/)?.[1]?.replace(/\s+/g, ' ').trim();
  const constDescription = raw.match(/const\s+DESCRIPTION[\s\S]*?:\s*['"`]([\s\S]*?)['"`]\s*;/)?.[1]?.replace(/\s+/g, ' ').trim();
  const description = directDescription || constDescription || `Bundled Robin-Ops skill from ${path.basename(filePath)}.`;

  return {
    name,
    description,
    emoji: '',
    eligible: true,
    disabled: false,
    blockedByAllowlist: false,
    source: 'bundled',
    bundled: true,
  };
}

async function listBundledSourceSkills(): Promise<RawSkill[]> {
  try {
    const entries = await fs.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true });
    const skills: RawSkill[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name === 'index.ts' || entry.name.endsWith('Content.ts')) continue;
      const filePath = path.join(BUNDLED_SKILLS_DIR, entry.name);
      const raw = await fs.readFile(filePath, 'utf8');
      const skill = parseBundledSkillSource(raw, filePath);
      if (skill) skills.push(skill);
    }

    return skills;
  } catch {
    return [];
  }
}

async function listWorkspaceSkills(agentId?: string): Promise<RawSkill[]> {
  const workspace = resolveAgentWorkspace(agentId);
  const workspaceSkillsDir = path.join(workspace.workspaceRoot, 'skills');
  const roots = Array.from(new Set([REPO_SKILLS_DIR, workspaceSkillsDir]));

  const discovered = await Promise.all(roots.map(async (rootDir) => {
    const files = await findSkillMarkdownFiles(rootDir);
    const skills = await Promise.all(files.map((filePath) => readMarkdownSkill(filePath, 'workspace')));
    return skills.filter((skill): skill is RawSkill => Boolean(skill));
  }));

  return discovered.flat();
}

async function listRobinSkills(agentId?: string): Promise<RawSkill[]> {
  const [workspaceSkills, bundledSourceSkills] = await Promise.all([
    listWorkspaceSkills(agentId),
    listBundledSourceSkills(),
  ]);

  const deduped = new Map<string, RawSkill>();
  for (const skill of [...workspaceSkills, ...bundledSourceSkills]) {
    if (!deduped.has(skill.name)) deduped.set(skill.name, skill);
  }

  return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
}

app.get('/api/skills', rateLimitGeneral, async (c) => {
  try {
    const skills = await listRobinSkills(c.req.query('agentId'));
    return c.json({ ok: true, skills });
  } catch (err) {
    if (err instanceof InvalidAgentIdError) {
      return c.json({ ok: false, error: err.message }, 400);
    }

    const message = err instanceof Error ? err.message : 'Failed to list skills';
    console.error('[skills] list error:', message);
    return c.json({ ok: false, error: message }, 502);
  }
});

export default app;
