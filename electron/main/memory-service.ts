import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type {
  AppState,
  Project,
  ProjectMemoryClearScope,
  ProjectMemoryEntryKind,
  ProjectMemoryFileContent,
  ProjectMemoryFileKind,
  ProjectMemoryFileSummary
} from '../../shared/types';

const MAX_MEMORY_WRITE_BYTES = 500_000;
const MEMORY_ENTRY_KIND_ORDER: ProjectMemoryEntryKind[] = ['user_preference', 'project_fact', 'decision', 'task_state'];
const MEMORY_ENTRY_KIND_TAGS: Record<ProjectMemoryEntryKind, string> = {
  user_preference: 'memory/user-preference',
  project_fact: 'memory/project-fact',
  decision: 'memory/decision',
  task_state: 'memory/task-state'
};

function expandHome(path: string): string {
  return path.replace(/^~/, process.env.HOME ?? '~');
}

function getProjectOrThrow(state: AppState, projectId: string): Project {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error('Project not found.');
  }
  return project;
}

function resolveProjectRoot(project: Project): string {
  if (!project.engine?.projectPath?.trim()) {
    throw new Error('当前项目还没有记录真实项目路径。');
  }
  return resolve(expandHome(project.engine.projectPath.trim()));
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split('\\').join('/');
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return Boolean(rel) && !rel.startsWith('..') && !/^(?:[A-Za-z]:)?[\\/]/.test(rel);
}

function normalizeMemoryPath(filePath: string): string {
  return filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function assertMemoryFilePath(filePath: string): string {
  const normalized = normalizeMemoryPath(filePath);
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    !/\.md$/i.test(normalized)
  ) {
    throw new Error('非法 memory 文件路径。');
  }
  if (!/^memory\.md$/i.test(normalized) && !normalized.startsWith('memory/')) {
    throw new Error('只能访问项目 memory.md 或 memory/ 目录下的 Markdown 文件。');
  }
  return normalized;
}

function resolveMemoryFilePath(rootPath: string, filePath: string): { absolutePath: string; relativePath: string } {
  const relativePath = assertMemoryFilePath(filePath);
  const absolutePath = resolve(rootPath, relativePath);
  if (absolutePath !== rootPath && !isInside(rootPath, absolutePath)) {
    throw new Error('非法 memory 文件路径。');
  }
  return { absolutePath, relativePath };
}

export async function ensureProjectMemoryFiles(rootPath: string): Promise<void> {
  await mkdir(resolve(rootPath, 'memory', 'daily'), { recursive: true });
  const longtermPath = resolve(rootPath, 'memory.md');
  if (!existsSync(longtermPath)) {
    await writeFile(longtermPath, '# Memory\n\n', 'utf8');
  }
}

function determineMemoryKind(relativePath: string): ProjectMemoryFileKind {
  if (/^memory\.md$/i.test(relativePath)) {
    return 'longterm';
  }
  if (/^memory\/daily\/\d{4}-\d{2}-\d{2}\.md$/i.test(relativePath)) {
    return 'daily';
  }
  return 'note';
}

export function extractMemoryTags(content: string): string[] {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const tagLines = frontmatter?.[1]?.match(/tags:\s*\[?([^\]\n]+)\]?/i)?.[1] ?? '';
  const frontmatterTags = tagLines.split(/[, ]+/).map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean);
  const inlineTags = [...content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[2]);
  return [...new Set([...frontmatterTags, ...inlineTags].map((tag) => tag.toLowerCase()))].sort((left, right) => left.localeCompare(right));
}

export function normalizeProjectMemoryEntryKind(value: string | undefined): ProjectMemoryEntryKind | undefined {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/^memory[/:_-]/, '')
    .replace(/[\s_]+/g, '-');
  if (!normalized) {
    return undefined;
  }
  if (['preference', 'preferences', 'user-preference', 'user-preferences', 'user'].includes(normalized)) {
    return 'user_preference';
  }
  if (['fact', 'facts', 'project-fact', 'project-facts', 'project'].includes(normalized)) {
    return 'project_fact';
  }
  if (['decision', 'decisions', 'choice', 'choices'].includes(normalized)) {
    return 'decision';
  }
  if (['task', 'tasks', 'task-state', 'task-states', 'temporary', 'temporary-task-state', 'state', 'todo'].includes(normalized)) {
    return 'task_state';
  }
  return undefined;
}

export function projectMemoryEntryKindTag(kind: ProjectMemoryEntryKind): string {
  return MEMORY_ENTRY_KIND_TAGS[kind];
}

export function inferProjectMemoryEntryKind(input: {
  note: string;
  memoryType?: 'longterm' | 'daily';
  tags?: string[];
}): ProjectMemoryEntryKind {
  for (const tag of input.tags ?? []) {
    const kind = normalizeProjectMemoryEntryKind(tag);
    if (kind) {
      return kind;
    }
  }
  const note = input.note.toLowerCase();
  if (/(prefer|preference|always|never|喜欢|偏好|以后都|不要再)/i.test(note)) {
    return 'user_preference';
  }
  if (/(decision|decided|choose|chosen|approved|决定|选定|确认采用|路线)/i.test(note)) {
    return 'decision';
  }
  if (/(todo|pending|blocked|next|unfinished|待办|下一步|未完成|阻塞|正在)/i.test(note)) {
    return 'task_state';
  }
  return input.memoryType === 'longterm' ? 'project_fact' : 'task_state';
}

export function extractMemoryEntryKinds(content: string): ProjectMemoryEntryKind[] {
  const candidates = new Set<string>();
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  for (const match of frontmatter.matchAll(/(?:memoryKinds?|entryKinds?|kind):\s*\[?([^\]\n]+)\]?/gi)) {
    for (const token of match[1].split(/[, ]+/)) {
      candidates.add(token);
    }
  }
  for (const tag of extractMemoryTags(content)) {
    candidates.add(tag);
  }
  for (const match of content.matchAll(/\[(?:memory[-_\s]?)?kind\s*:\s*([^\]]+)\]/gi)) {
    candidates.add(match[1]);
  }
  const kinds = [...candidates]
    .map((candidate) => normalizeProjectMemoryEntryKind(candidate))
    .filter((kind): kind is ProjectMemoryEntryKind => Boolean(kind));
  const uniqueKinds = [...new Set(kinds)];
  return MEMORY_ENTRY_KIND_ORDER.filter((kind) => uniqueKinds.includes(kind));
}

function titleFromContent(relativePath: string, content: string): string {
  const heading = content.split('\n').find((line) => /^#\s+\S/.test(line.trim()));
  if (heading) {
    return heading.replace(/^#\s+/, '').trim().slice(0, 120);
  }
  if (/^memory\.md$/i.test(relativePath)) {
    return 'Long-term Memory';
  }
  const fileName = basename(relativePath, '.md');
  return fileName || relativePath;
}

function excerptFromContent(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line !== '---')
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

async function summarizeMemoryFile(rootPath: string, relativePath: string): Promise<ProjectMemoryFileSummary> {
  const { absolutePath } = resolveMemoryFilePath(rootPath, relativePath);
  const [stats, content] = await Promise.all([
    stat(absolutePath),
    readFile(absolutePath, 'utf8')
  ]);
  return {
    path: relativePath,
    title: titleFromContent(relativePath, content),
    kind: determineMemoryKind(relativePath),
    memoryKinds: extractMemoryEntryKinds(content),
    tags: extractMemoryTags(content),
    excerpt: excerptFromContent(content),
    size: stats.size,
    lineCount: content.length ? content.split('\n').length : 0,
    updatedAt: stats.mtime.toISOString()
  };
}

async function walkMemoryFiles(rootPath: string, dirPath: string, output: string[]): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
      continue;
    }
    const absolutePath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkMemoryFiles(rootPath, absolutePath, output);
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      output.push(toPosixRelativePath(rootPath, absolutePath));
    }
  }
}

function sortMemoryFiles(files: ProjectMemoryFileSummary[]): ProjectMemoryFileSummary[] {
  return [...files].sort((left, right) => {
    const rank = (kind: ProjectMemoryFileKind): number => (kind === 'longterm' ? 0 : kind === 'daily' ? 1 : 2);
    const rankDiff = rank(left.kind) - rank(right.kind);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    if (left.kind === 'daily') {
      return right.path.localeCompare(left.path);
    }
    return left.path.localeCompare(right.path);
  });
}

function getDefaultMemoryContent(filePath: string): string {
  if (/^memory\.md$/i.test(filePath)) {
    return '# Memory\n\n';
  }
  const dailyMatch = filePath.match(/^memory\/daily\/(\d{4}-\d{2}-\d{2})\.md$/i);
  if (dailyMatch) {
    return `# ${dailyMatch[1]}\n\n`;
  }
  return `# ${basename(filePath, '.md')}\n\n`;
}

export async function listProjectMemoryFiles(state: AppState, projectId: string): Promise<ProjectMemoryFileSummary[]> {
  const rootPath = resolveProjectRoot(getProjectOrThrow(state, projectId));
  await ensureProjectMemoryFiles(rootPath);
  const memoryPaths = ['memory.md'];
  const memoryRootPath = resolve(rootPath, 'memory');
  if (existsSync(memoryRootPath)) {
    const memoryRootStats = await lstat(memoryRootPath);
    if (memoryRootStats.isDirectory() && !memoryRootStats.isSymbolicLink()) {
      await walkMemoryFiles(rootPath, memoryRootPath, memoryPaths);
    }
  }
  const uniquePaths = [...new Set(memoryPaths)];
  const summaries = await Promise.all(uniquePaths.map((filePath) => summarizeMemoryFile(rootPath, filePath)));
  return sortMemoryFiles(summaries);
}

export async function readProjectMemoryFile(state: AppState, projectId: string, filePath: string): Promise<ProjectMemoryFileContent> {
  const rootPath = resolveProjectRoot(getProjectOrThrow(state, projectId));
  await ensureProjectMemoryFiles(rootPath);
  const { absolutePath, relativePath } = resolveMemoryFilePath(rootPath, filePath);
  if (!existsSync(absolutePath)) {
    throw new Error('Memory file not found.');
  }
  const [summary, content] = await Promise.all([
    summarizeMemoryFile(rootPath, relativePath),
    readFile(absolutePath, 'utf8')
  ]);
  return {
    ...summary,
    content
  };
}

export async function saveProjectMemoryFile(
  state: AppState,
  projectId: string,
  filePath: string,
  content: string
): Promise<ProjectMemoryFileContent> {
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_WRITE_BYTES) {
    throw new Error('Memory content is too large.');
  }
  const rootPath = resolveProjectRoot(getProjectOrThrow(state, projectId));
  await ensureProjectMemoryFiles(rootPath);
  const { absolutePath, relativePath } = resolveMemoryFilePath(rootPath, filePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  return readProjectMemoryFile(state, projectId, relativePath);
}

export async function clearProjectMemory(
  state: AppState,
  projectId: string,
  input: { scope: ProjectMemoryClearScope; filePath?: string }
): Promise<ProjectMemoryFileSummary[]> {
  const rootPath = resolveProjectRoot(getProjectOrThrow(state, projectId));
  await ensureProjectMemoryFiles(rootPath);

  if (input.scope === 'file') {
    const filePath = input.filePath ? assertMemoryFilePath(input.filePath) : '';
    if (!filePath) {
      throw new Error('Missing memory file path.');
    }
    const { absolutePath, relativePath } = resolveMemoryFilePath(rootPath, filePath);
    if (!existsSync(absolutePath)) {
      throw new Error('Memory file not found.');
    }
    await writeFile(absolutePath, getDefaultMemoryContent(relativePath), 'utf8');
    return listProjectMemoryFiles(state, projectId);
  }

  if (input.scope === 'daily') {
    const dailyPath = resolve(rootPath, 'memory', 'daily');
    await rm(dailyPath, { recursive: true, force: true });
    await mkdir(dailyPath, { recursive: true });
    return listProjectMemoryFiles(state, projectId);
  }

  await writeFile(resolve(rootPath, 'memory.md'), '# Memory\n\n', 'utf8');
  await rm(resolve(rootPath, 'memory'), { recursive: true, force: true });
  await ensureProjectMemoryFiles(rootPath);
  return listProjectMemoryFiles(state, projectId);
}
