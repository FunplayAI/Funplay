import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project } from '../../../shared/types';
import {
  ensureProjectMemoryFiles,
  extractMemoryEntryKinds,
  extractMemoryTags,
  inferProjectMemoryEntryKind,
  normalizeProjectMemoryEntryKind,
  projectMemoryEntryKindTag
} from '../memory-service';
import { resolveProjectRootPathForProject } from '../project-file-service';
import type { WorkspaceToolAction, WorkspaceToolActionResult } from './workspace-tools';

const MAX_MEMORY_SEARCH_RESULTS = 10;
const MAX_MEMORY_TOOL_CHARS = 12_000;
const RECENT_MEMORY_DAYS = 3;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function memoryDateString(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function normalizeMemoryPath(filePath: string): string {
  const normalized = filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    !/\.md$/i.test(normalized) ||
    (!/^memory\.md$/i.test(normalized) && !normalized.startsWith('memory/'))
  ) {
    throw new Error('非法 memory 文件路径。');
  }
  return normalized;
}

function resolveMemoryPath(rootPath: string, filePath: string): {
  relativePath: string;
  absolutePath: string;
} {
  const relativePath = normalizeMemoryPath(filePath);
  const absolutePath = resolve(rootPath, relativePath);
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}/`)) {
    throw new Error('非法 memory 文件路径。');
  }
  return { relativePath, absolutePath };
}

async function walkMemoryMarkdown(rootPath: string, dirPath: string, output: string[]): Promise<void> {
  if (!existsSync(dirPath)) {
    return;
  }
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
      continue;
    }
    const absolute = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkMemoryMarkdown(rootPath, absolute, output);
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      output.push(absolute.slice(rootPath.length + 1).split('\\').join('/'));
    }
  }
}

async function listMemoryMarkdownPaths(rootPath: string): Promise<string[]> {
  await ensureProjectMemoryFiles(rootPath);
  const paths = ['memory.md'];
  await walkMemoryMarkdown(rootPath, resolve(rootPath, 'memory'), paths);
  return [...new Set(paths)].sort();
}

function tokenizeMemoryQuery(value: string): string[] {
  return [...new Set(
    [
      ...value.toLowerCase().matchAll(/\b[a-z0-9_.#:/-]{2,}\b/g),
      ...value.matchAll(/[\u4e00-\u9fa5]{2,}/g)
    ].map((match) => match[0])
  )].slice(0, 20);
}

function scoreMemoryFile(path: string, content: string, query: string, tags: string[]): number {
  const tokens = tokenizeMemoryQuery(query);
  if (tokens.length === 0) {
    return 0;
  }
  const lower = `${path}\n${content}`.toLowerCase();
  let score = tokens.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0);
  if (tags.length > 0) {
    const fileTags = extractMemoryTags(content);
    if (!tags.some((tag) => fileTags.includes(tag.toLowerCase().replace(/^#/, '')))) {
      return 0;
    }
    score += 1;
  }
  const dateMatch = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  if (dateMatch) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(dateMatch[1])) / 86_400_000);
    score *= Math.exp(-(Math.log(2) / 30) * ageDays);
  }
  return score;
}

function memorySnippet(content: string, query: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  const token = tokenizeMemoryQuery(query)[0];
  if (!token) {
    return truncate(normalized, 260);
  }
  const index = normalized.toLowerCase().indexOf(token.toLowerCase());
  if (index < 0) {
    return truncate(normalized, 260);
  }
  return truncate(normalized.slice(Math.max(0, index - 100), index + 260), 420);
}

function sanitizeMemoryTag(value: string): string {
  return value
    .trim()
    .replace(/^#/, '')
    .replace(/[^\p{L}\p{N}_/-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildMemoryTagText(tags: string[] | undefined, memoryKind: ReturnType<typeof inferProjectMemoryEntryKind>): string {
  const normalizedTags = unique((tags ?? []).map(sanitizeMemoryTag).filter(Boolean));
  const kindTag = projectMemoryEntryKindTag(memoryKind);
  if (!normalizedTags.includes(kindTag)) {
    normalizedTags.push(kindTag);
  }
  return normalizedTags.length ? ` ${normalizedTags.map((tag) => `#${tag}`).join(' ')}` : '';
}

export async function performMemorySearch(project: Project, action: Extract<WorkspaceToolAction, { type: 'funplay_memory_search' }>): Promise<WorkspaceToolActionResult> {
  const rootPath = resolveProjectRootPathForProject(project);
  const paths = await listMemoryMarkdownPaths(rootPath);
  const tags = action.tags ?? [];
  const limit = Math.max(1, Math.min(action.limit ?? 5, MAX_MEMORY_SEARCH_RESULTS));
  const results: Array<{ path: string; content: string; score: number }> = [];
  for (const path of paths) {
    if (action.fileType === 'daily' && !path.startsWith('memory/daily/')) continue;
    if (action.fileType === 'longterm' && !/^memory\.md$/i.test(path)) continue;
    const content = await readFile(resolve(rootPath, path), 'utf8');
    const memoryKind = normalizeProjectMemoryEntryKind(action.memoryKind === 'all' ? undefined : action.memoryKind);
    if (memoryKind && !extractMemoryEntryKinds(content).includes(memoryKind)) continue;
    const score = scoreMemoryFile(path, content, action.query, tags);
    if (score > 0) {
      results.push({ path, content, score });
    }
  }
  const selected = results.sort((left, right) => right.score - left.score).slice(0, limit);
  return {
    ok: true,
    summary: selected.length
      ? selected.map((result, index) => {
          const tagText = extractMemoryTags(result.content).map((tag) => `#${tag}`).join(' ');
          return `${index + 1}. [${result.path}]${tagText ? ` ${tagText}` : ''} (score: ${result.score.toFixed(2)})\n${memorySnippet(result.content, action.query)}`;
        }).join('\n\n')
      : `No matching memories found: ${action.query}`
  };
}

export async function performMemoryGet(project: Project, action: Extract<WorkspaceToolAction, { type: 'funplay_memory_get' }>): Promise<WorkspaceToolActionResult> {
  const rootPath = resolveProjectRootPathForProject(project);
  await ensureProjectMemoryFiles(rootPath);
  const { relativePath, absolutePath } = resolveMemoryPath(rootPath, action.filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Memory file not found: ${relativePath}`);
  }
  let content = await readFile(absolutePath, 'utf8');
  if (action.lineStart || action.lineEnd) {
    const lines = content.split('\n');
    const start = Math.max(0, (action.lineStart ?? 1) - 1);
    const end = Math.min(lines.length, action.lineEnd ?? lines.length);
    content = lines.slice(start, end).join('\n');
  }
  return {
    ok: true,
    summary: `[${relativePath}]\n${truncate(content || '(empty file)', MAX_MEMORY_TOOL_CHARS)}`
  };
}

export async function performMemoryRecent(project: Project): Promise<WorkspaceToolActionResult> {
  const rootPath = resolveProjectRootPathForProject(project);
  await ensureProjectMemoryFiles(rootPath);
  const parts: string[] = [];
  const longtermPath = resolve(rootPath, 'memory.md');
  if (existsSync(longtermPath)) {
    const content = (await readFile(longtermPath, 'utf8')).trim();
    if (content) {
      parts.push(`## Long-term Memory\n${truncate(content, 1200)}`);
    }
  }
  const dailyDir = resolve(rootPath, 'memory', 'daily');
  if (existsSync(dailyDir)) {
    const files = (await readdir(dailyDir))
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/i.test(file))
      .sort()
      .reverse()
      .slice(0, RECENT_MEMORY_DAYS);
    for (const file of files) {
      const content = (await readFile(resolve(dailyDir, file), 'utf8')).trim();
      if (content) {
        parts.push(`## ${file.replace(/\.md$/i, '')}\n${truncate(content, 1400)}`);
      }
    }
  }
  return {
    ok: true,
    summary: parts.join('\n\n') || 'No recent memories found.'
  };
}

export async function performMemoryRemember(project: Project, action: Extract<WorkspaceToolAction, { type: 'funplay_memory_remember' }>): Promise<WorkspaceToolActionResult> {
  const rootPath = resolveProjectRootPathForProject(project);
  await ensureProjectMemoryFiles(rootPath);
  const note = action.note.trim();
  if (!note) {
    throw new Error('funplay_memory_remember 缺少 note。');
  }
  const memoryKind = action.memoryKind ?? inferProjectMemoryEntryKind({
    note,
    memoryType: action.memoryType,
    tags: action.tags
  });
  const tagText = buildMemoryTagText(action.tags, memoryKind);
  if (action.memoryType === 'longterm') {
    await appendFile(resolve(rootPath, 'memory.md'), `\n- ${note}${tagText}\n`, 'utf8');
    return {
      ok: true,
      summary: `Saved to memory.md. Kind: ${memoryKind}.`
    };
  }
  const date = memoryDateString();
  const dailyPath = resolve(rootPath, 'memory', 'daily', `${date}.md`);
  if (!existsSync(dailyPath)) {
    await mkdir(resolve(rootPath, 'memory', 'daily'), { recursive: true });
    await writeFile(dailyPath, `# ${date}\n\n`, 'utf8');
  }
  await appendFile(dailyPath, `\n- ${note}${tagText}\n`, 'utf8');
  return {
    ok: true,
    summary: `Saved to memory/daily/${date}.md. Kind: ${memoryKind}.`
  };
}
