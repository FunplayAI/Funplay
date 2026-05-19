import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentSkillCatalogItem, AgentSkillCatalogResult } from '../../shared/types';

export const FUNPLAY_SKILL_REPOSITORY_URL = 'https://github.com/FunplayAI/funplay-skill.git';
export const FUNPLAY_SKILL_REPOSITORY_WEB_URL = 'https://github.com/FunplayAI/funplay-skill';
export const FUNPLAY_SKILL_REPOSITORY_REF = 'main';

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  dependencies?: string[];
  inputs?: string[];
  outputs?: string[];
  examples?: string[];
}

function runGit(args: string[], cwd?: string): GitCommandResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function resolveSkillCachePath(userDataPath: string): string {
  return join(userDataPath, 'skill-catalog', 'funplay-skill');
}

function ensureFunplaySkillRepository(userDataPath: string, refresh: boolean): {
  checkoutPath: string;
  cached: boolean;
} {
  const checkoutPath = resolveSkillCachePath(userDataPath);
  const gitPath = join(checkoutPath, '.git');
  mkdirSync(join(userDataPath, 'skill-catalog'), { recursive: true });

  if (!existsSync(gitPath)) {
    if (existsSync(checkoutPath)) {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
    const clone = runGit([
      'clone',
      '--depth',
      '1',
      '--branch',
      FUNPLAY_SKILL_REPOSITORY_REF,
      FUNPLAY_SKILL_REPOSITORY_URL,
      checkoutPath
    ]);
    if (!clone.ok) {
      throw new Error(`无法获取 Funplay Skill 仓库：${clone.stderr || clone.stdout || 'git clone failed'}`);
    }
    return {
      checkoutPath,
      cached: false
    };
  }

  if (!refresh) {
    return {
      checkoutPath,
      cached: true
    };
  }

  const fetch = runGit(['-C', checkoutPath, 'fetch', '--depth', '1', 'origin', FUNPLAY_SKILL_REPOSITORY_REF]);
  const checkout = fetch.ok
    ? runGit(['-C', checkoutPath, 'checkout', '--force', 'FETCH_HEAD'])
    : fetch;
  return {
    checkoutPath,
    cached: !fetch.ok || !checkout.ok
  };
}

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  if (!content.startsWith('---')) {
    return {
      frontmatter: '',
      body: content
    };
  }

  const closingIndex = content.indexOf('\n---', 3);
  if (closingIndex < 0) {
    return {
      frontmatter: '',
      body: content
    };
  }

  const frontmatter = content.slice(3, closingIndex).trim();
  const body = content.slice(closingIndex + 4).replace(/^\s*\n/, '');
  return {
    frontmatter,
    body
  };
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function cleanListValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '[]') {
    return [];
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(cleanScalar)
      .filter(Boolean);
  }
  return [cleanScalar(trimmed)].filter(Boolean);
}

function parseSkillFrontmatter(value: string): SkillFrontmatter {
  const result: Record<string, string | string[]> = {};
  let currentListKey = '';

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/g, '');
    const listMatch = line.match(/^\s*-\s*(.+)$/);
    if (listMatch && currentListKey) {
      const list = Array.isArray(result[currentListKey]) ? result[currentListKey] as string[] : [];
      list.push(cleanScalar(listMatch[1]));
      result[currentListKey] = list;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1];
    const scalar = keyMatch[2] ?? '';
    if (scalar.trim()) {
      result[key] = cleanListValue(scalar);
      currentListKey = '';
      continue;
    }

    result[key] = [];
    currentListKey = key;
  }

  const getString = (key: string): string | undefined => {
    const raw = result[key];
    if (Array.isArray(raw)) {
      return raw[0];
    }
    return raw;
  };
  const getList = (key: string): string[] => {
    const raw = result[key];
    if (!raw) {
      return [];
    }
    return Array.isArray(raw) ? raw.filter(Boolean) : [raw].filter(Boolean);
  };

  return {
    name: getString('name'),
    description: getString('description'),
    dependencies: getList('dependencies'),
    inputs: getList('inputs'),
    outputs: getList('outputs'),
    examples: getList('examples')
  };
}

function readCommitSha(checkoutPath: string): string | undefined {
  const result = runGit(['-C', checkoutPath, 'rev-parse', 'HEAD']);
  return result.ok ? result.stdout : undefined;
}

export function parseFunplaySkillCatalogFromDirectory(checkoutPath: string, options: {
  repositoryUrl?: string;
  repositoryWebUrl?: string;
  repositoryRef?: string;
  commitSha?: string;
  fetchedAt?: string;
} = {}): AgentSkillCatalogItem[] {
  const skillsPath = join(checkoutPath, 'skills');
  if (!existsSync(skillsPath) || !statSync(skillsPath).isDirectory()) {
    return [];
  }

  const repositoryUrl = options.repositoryUrl ?? FUNPLAY_SKILL_REPOSITORY_URL;
  const repositoryWebUrl = options.repositoryWebUrl ?? FUNPLAY_SKILL_REPOSITORY_WEB_URL;
  const repositoryRef = options.repositoryRef ?? FUNPLAY_SKILL_REPOSITORY_REF;
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();

  return readdirSync(skillsPath)
    .map((entry) => join(skillsPath, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory() && existsSync(join(entryPath, 'SKILL.md')))
    .map((entryPath) => {
      const id = basename(entryPath);
      const sourcePath = `skills/${id}/SKILL.md`;
      const raw = readFileSync(join(entryPath, 'SKILL.md'), 'utf8');
      const parsed = splitFrontmatter(raw);
      const frontmatter = parseSkillFrontmatter(parsed.frontmatter);
      const sourceRef = options.commitSha || repositoryRef;
      return {
        id,
        name: frontmatter.name || id,
        description: frontmatter.description,
        dependencies: frontmatter.dependencies ?? [],
        inputs: frontmatter.inputs ?? [],
        outputs: frontmatter.outputs ?? [],
        examples: frontmatter.examples ?? [],
        instruction: parsed.body.trim() || raw.trim(),
        sourcePath,
        sourceUrl: `${repositoryWebUrl}/blob/${sourceRef}/${sourcePath}`,
        repositoryUrl,
        repositoryRef,
        commitSha: options.commitSha,
        fetchedAt
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function listFunplaySkillCatalog(userDataPath: string, options: {
  refresh?: boolean;
} = {}): AgentSkillCatalogResult {
  const fetchedAt = new Date().toISOString();
  const repository = ensureFunplaySkillRepository(userDataPath, Boolean(options.refresh));
  const commitSha = readCommitSha(repository.checkoutPath);
  const skills = parseFunplaySkillCatalogFromDirectory(repository.checkoutPath, {
    repositoryUrl: FUNPLAY_SKILL_REPOSITORY_URL,
    repositoryWebUrl: FUNPLAY_SKILL_REPOSITORY_WEB_URL,
    repositoryRef: FUNPLAY_SKILL_REPOSITORY_REF,
    commitSha,
    fetchedAt
  });

  return {
    repositoryUrl: FUNPLAY_SKILL_REPOSITORY_URL,
    repositoryRef: FUNPLAY_SKILL_REPOSITORY_REF,
    commitSha,
    fetchedAt,
    cached: repository.cached,
    skills
  };
}
