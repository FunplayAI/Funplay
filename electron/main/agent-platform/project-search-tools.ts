import { extname } from 'node:path';
import type {
  ChatMediaBlock,
  Project,
  ProjectFileEntry
} from '../../../shared/types';
import {
  findProjectFilesOnDisk,
  listProjectFilesForProject,
  readProjectFileForProject,
  writeProjectTextFileForProject
} from '../project-file-service';
import { recordFileCheckpoint } from './file-checkpoint-store';
import type {
  WorkspaceToolAction,
  WorkspaceToolActionResult,
  WorkspaceWriteOperation,
  WorkspaceWriteResult
} from './workspace-tools';

const MAX_TREE_ITEMS = 80;
const MAX_FILE_PREVIEW_CHARS = 4000;
const MAX_SEARCH_RESULTS = 8;
const MAX_DIRECTORY_ITEMS = 18;
const MAX_WRITE_OPERATIONS = 5;
const MAX_FIND_FILE_RESULTS = 120;
const MAX_PROJECT_SEARCH_RESULTS = 50;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function onlyFiles(files: ProjectFileEntry[]): ProjectFileEntry[] {
  return files.filter((file) => file.type !== 'directory');
}

function normalizePathToken(token: string): string {
  return token.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/^\.\//, '');
}

function normalizeOptionalDirectoryPath(path: string | undefined): string {
  const normalized = (path ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.') {
    return '';
  }

  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('非法目录路径。');
  }

  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  let expression = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const nextCharacter = normalized[index + 1];
    const followingCharacter = normalized[index + 2];

    if (character === '*' && nextCharacter === '*' && followingCharacter === '/') {
      expression += '(?:.*/)?';
      index += 2;
      continue;
    }

    if (character === '*' && nextCharacter === '*') {
      expression += '.*';
      index += 1;
      continue;
    }

    if (character === '*') {
      expression += '[^/]*';
      continue;
    }

    if (character === '?') {
      expression += '[^/]';
      continue;
    }

    if (character === '{') {
      const closeIndex = normalized.indexOf('}', index + 1);
      if (closeIndex > index + 1) {
        const choices = normalized
          .slice(index + 1, closeIndex)
          .split(',')
          .map((choice) => escapeRegExp(choice.trim()))
          .filter(Boolean);
        if (choices.length > 0) {
          expression += `(?:${choices.join('|')})`;
          index = closeIndex;
          continue;
        }
      }
    }

    expression += escapeRegExp(character);
  }

  return new RegExp(`^${expression}$`);
}

export function findProjectFiles(files: ProjectFileEntry[], input: {
  pattern: string;
  path?: string;
  maxResults?: number;
}): ProjectFileEntry[] {
  const pattern = input.pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!pattern) {
    throw new Error('find_files 缺少 pattern。');
  }

  const directory = normalizeOptionalDirectoryPath(input.path);
  const matcher = globToRegExp(pattern);
  const shouldMatchPath = pattern.includes('/');
  const maxResults = Math.max(1, Math.min(input.maxResults ?? MAX_FIND_FILE_RESULTS, MAX_FIND_FILE_RESULTS));

  return onlyFiles(files)
    .filter((file) => !directory || file.path === directory || file.path.startsWith(`${directory}/`))
    .filter((file) => matcher.test(shouldMatchPath ? file.path : file.name))
    .sort((left, right) => {
      const leftTime = left.modifiedAt ? Date.parse(left.modifiedAt) : 0;
      const rightTime = right.modifiedAt ? Date.parse(right.modifiedAt) : 0;
      return rightTime - leftTime || left.path.localeCompare(right.path);
    })
    .slice(0, maxResults);
}

// find_files matched against the in-memory listing (listProjectFilesForProject),
// which is capped at MAX_FILE_ENTRIES (1200) — so in large projects (e.g. Unity,
// where every asset has a .meta sidecar) files in later folders were never in the
// list and looked "missing" even though they exist. This variant walks the project
// tree directly so glob matches are found regardless of the listing cap.
export async function findProjectFilesFromDisk(project: Project, input: {
  pattern: string;
  path?: string;
  maxResults?: number;
}): Promise<ProjectFileEntry[]> {
  const pattern = input.pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!pattern) {
    throw new Error('find_files 缺少 pattern。');
  }

  const directory = normalizeOptionalDirectoryPath(input.path);
  const matcher = globToRegExp(pattern);
  const shouldMatchPath = pattern.includes('/');
  const maxResults = Math.max(1, Math.min(input.maxResults ?? MAX_FIND_FILE_RESULTS, MAX_FIND_FILE_RESULTS));

  const matched = await findProjectFilesOnDisk(
    project,
    (relativePath, name) => matcher.test(shouldMatchPath ? relativePath : name),
    { startDir: directory || undefined, maxMatches: maxResults }
  );

  return matched.sort((left, right) => {
    const leftTime = left.modifiedAt ? Date.parse(left.modifiedAt) : 0;
    const rightTime = right.modifiedAt ? Date.parse(right.modifiedAt) : 0;
    return rightTime - leftTime || left.path.localeCompare(right.path);
  });
}

export function formatFileMatches(files: ProjectFileEntry[], pattern: string): string {
  if (files.length === 0) {
    return `没有找到匹配文件：${pattern}`;
  }

  return files
    .map((file) => {
      const size = typeof file.size === 'number' ? ` (${file.size} bytes)` : '';
      return `- ${file.path}${size}`;
    })
    .join('\n');
}

function extractPathTokens(message: string): string[] {
  const mentionMatches = [...message.matchAll(/@([^\s]+)/g)].map((match) => normalizePathToken(match[1]));
  const inlineCodeMatches = [...message.matchAll(/`([^`]+)`/g)].map((match) => normalizePathToken(match[1]));
  const slashMatches = [...message.matchAll(/([A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.]+)+)/g)].map((match) => normalizePathToken(match[1]));
  const extensionMatches = [...message.matchAll(/\b([A-Za-z0-9_\-.]+\.(?:ts|tsx|js|jsx|json|md|markdown|html|htm|css|scss|cs|txt|yml|yaml|toml))\b/g)].map((match) => normalizePathToken(match[1]));

  return unique([...mentionMatches, ...inlineCodeMatches, ...slashMatches, ...extensionMatches]).filter(Boolean);
}

function shouldInspectFileTree(message: string): boolean {
  return /(项目结构|文件树|目录结构|有哪些文件|看看项目|scan project|list files|file tree|project structure|folder structure)/i.test(message);
}

function shouldSearchProjectContent(message: string): boolean {
  return /(搜索|查找|在哪|哪里定义|引用了|谁在用|find|search|grep|where is|references?|who uses|look for)/i.test(message);
}

function shouldSummarizeDirectory(message: string): boolean {
  return /(@[^\s]+|目录|文件夹|folder|directory|这个目录|这个文件夹|summarize dir|summarize folder)/i.test(message);
}

function extractSearchTerms(message: string): string[] {
  const quotedTerms = [...message.matchAll(/[""'`]{1}([^"'`""]{2,80})[""'`]{1}/g)].map((match) => match[1].trim());
  const keywordTerms = [...message.matchAll(/(?:搜索|查找|find|search|grep)\s+([A-Za-z0-9_\-.:/#@-]{2,80})/gi)].map((match) => match[1].trim());
  const camelTerms = [...message.matchAll(/\b([A-Z][A-Za-z0-9_]{2,}|\w+\([^)]*\)|[A-Za-z0-9_-]{3,})\b/g)].map((match) => match[1].trim());

  return unique([...quotedTerms, ...keywordTerms, ...camelTerms]).filter((term) => term.length >= 2).slice(0, 6);
}

function extractDirectoryTokens(message: string): string[] {
  const pathTokens = extractPathTokens(message);
  return unique(
    pathTokens
      .map((token) => token.replace(/\/[^/]+\.[A-Za-z0-9]+$/, ''))
      .filter(Boolean)
  ).slice(0, 4);
}

function resolveMatchedFiles(tokens: string[], files: ProjectFileEntry[]): string[] {
  const fileEntries = onlyFiles(files);
  const lowerFileMap = new Map(fileEntries.map((file) => [file.path.toLowerCase(), file.path]));

  const matched = tokens.flatMap((token) => {
    const lowerToken = token.toLowerCase();
    const exact = lowerFileMap.get(lowerToken);
    if (exact) {
      return [exact];
    }

    return fileEntries
      .filter((file) => file.path.toLowerCase().endsWith(lowerToken) || file.name.toLowerCase() === lowerToken)
      .map((file) => file.path);
  });

  return unique(matched).slice(0, 6);
}

function resolveMatchedDirectories(tokens: string[], files: ProjectFileEntry[]): string[] {
  const directories = unique(
    files.flatMap((file) => {
      if (file.type === 'directory') {
        return [file.path];
      }
      const segments = file.path.split('/');
      return segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'));
    })
  );

  const matched = tokens.flatMap((token) => {
    const lowerToken = token.toLowerCase();
    return directories.filter((directory) => directory.toLowerCase() === lowerToken || directory.toLowerCase().endsWith(lowerToken));
  });

  return unique(matched).slice(0, 4);
}

export function buildDirectorySummary(directory: string, files: ProjectFileEntry[]): string {
  const related = files.filter((file) => file.path.startsWith(`${directory}/`));
  const relatedFiles = onlyFiles(related);
  const directChildren = unique(
    related.map((file) => file.path.slice(directory.length + 1).split('/')[0]).filter(Boolean)
  ).slice(0, MAX_DIRECTORY_ITEMS);

  return [
    `目录：${directory}`,
    `文件数：${relatedFiles.length}`,
    directChildren.length > 0 ? `直接子项：${directChildren.join(', ')}` : '直接子项：无'
  ].join('\n');
}

function normalizeProjectSearchPath(path: string | undefined): string | undefined {
  const normalized = path?.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.') {
    return undefined;
  }
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('非法搜索路径。');
  }
  return normalized;
}

function normalizeProjectSearchFileTypes(fileType: string | undefined): string[] {
  return unique((fileType ?? '')
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase().replace(/^\./, ''))
    .filter((value) => /^[a-z0-9]+$/.test(value)))
    .slice(0, 8);
}

function createProjectSearchMatcher(action: Extract<WorkspaceToolAction, { type: 'search_project_content' }>): {
  test: (line: string) => boolean;
  label: string;
} {
  if (action.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(action.query, action.caseInsensitive === false ? '' : 'i');
    } catch (error) {
      throw new Error(`非法正则表达式：${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      test: (line) => expression.test(line),
      label: `regex:${action.query}`
    };
  }

  const needle = action.caseInsensitive === false ? action.query : action.query.toLowerCase();
  return {
    test: (line) => (action.caseInsensitive === false ? line : line.toLowerCase()).includes(needle),
    label: action.query
  };
}

function filterProjectSearchFiles(files: ProjectFileEntry[], action: Extract<WorkspaceToolAction, { type: 'search_project_content' }>): ProjectFileEntry[] {
  const searchPath = normalizeProjectSearchPath(action.path);
  const fileTypes = normalizeProjectSearchFileTypes(action.fileType);
  const globMatcher = action.glob?.trim() ? globToRegExp(action.glob.trim()) : undefined;
  return onlyFiles(files).filter((file) => {
    if (searchPath && file.path !== searchPath && !file.path.startsWith(`${searchPath}/`)) {
      return false;
    }
    if (fileTypes.length > 0) {
      const extension = extname(file.path).toLowerCase().replace(/^\./, '');
      if (!fileTypes.includes(extension)) {
        return false;
      }
    }
    if (globMatcher && !globMatcher.test(file.path)) {
      return false;
    }
    return true;
  });
}

export async function performAdvancedProjectSearch(
  project: Project,
  files: ProjectFileEntry[],
  action: Extract<WorkspaceToolAction, { type: 'search_project_content' }>
): Promise<WorkspaceToolActionResult> {
  const matcher = createProjectSearchMatcher(action);
  const contextBefore = Math.max(0, Math.min(action.contextBefore ?? 0, 20));
  const contextAfter = Math.max(0, Math.min(action.contextAfter ?? 0, 20));
  const limit = Math.max(1, Math.min(action.limit ?? MAX_SEARCH_RESULTS, MAX_PROJECT_SEARCH_RESULTS));
  const offset = Math.max(0, Math.floor(action.offset ?? 0));
  const outputMode = action.outputMode ?? 'content';
  const candidateFiles = filterProjectSearchFiles(files, action);
  const fileMatches: Array<{
    path: string;
    count: number;
    matches: Array<{
      lineNumber: number;
      excerpt: string;
    }>;
  }> = [];
  let totalMatches = 0;

  for (const file of candidateFiles) {
    if (file.size > 200_000) {
      continue;
    }
    try {
      const readResult = await readProjectFileForProject(project, file.path);
      if (readResult.isBinary) {
        continue;
      }
      const lines = readResult.content.split('\n');
      const matches: Array<{
        lineNumber: number;
        excerpt: string;
      }> = [];
      lines.forEach((line, index) => {
        if (!matcher.test(line)) {
          return;
        }
        totalMatches += 1;
        const start = Math.max(0, index - contextBefore);
        const end = Math.min(lines.length, index + contextAfter + 1);
        matches.push({
          lineNumber: index + 1,
          excerpt: lines
            .slice(start, end)
            .map((contextLine, contextIndex) => `${start + contextIndex + 1}\t${truncate(contextLine, 240)}`)
            .join('\n')
        });
      });
      if (matches.length > 0) {
        fileMatches.push({
          path: file.path,
          count: matches.length,
          matches
        });
      }
    } catch {
      // ignore unreadable files
    }
  }

  if (fileMatches.length === 0) {
    return {
      ok: true,
      summary: [
        `Search: ${matcher.label}`,
        action.glob ? `Glob: ${action.glob}` : '',
        action.path ? `Path: ${action.path}` : '',
        action.fileType ? `File-Type: ${action.fileType}` : '',
        '',
        `没有找到匹配：${action.query}`
      ].filter((line) => line !== '').join('\n')
    };
  }

  if (outputMode === 'count') {
    return {
      ok: true,
      summary: [
        `Search: ${matcher.label}`,
        `Files: ${fileMatches.length}`,
        `Matches: ${totalMatches}`,
        '',
        ...fileMatches.slice(offset, offset + limit).map((file) => `${file.path}: ${file.count}`)
      ].join('\n')
    };
  }

  if (outputMode === 'files_with_matches') {
    return {
      ok: true,
      summary: [
        `Search: ${matcher.label}`,
        `Files: ${fileMatches.length}`,
        `Matches: ${totalMatches}`,
        `Window: offset=${offset}, limit=${limit}`,
        '',
        ...fileMatches.slice(offset, offset + limit).map((file) => `- ${file.path} (${file.count} matches)`)
      ].join('\n')
    };
  }

  const flattened = fileMatches.flatMap((file) =>
    file.matches.map((match) => ({
      path: file.path,
      count: file.count,
      ...match
    }))
  );
  const selected = flattened.slice(offset, offset + limit);
  return {
    ok: true,
    summary: [
      `Search: ${matcher.label}`,
      `Mode: ${action.regex ? 'regex' : 'literal'} | Case: ${action.caseInsensitive === false ? 'sensitive' : 'insensitive'}`,
      action.glob ? `Glob: ${action.glob}` : '',
      action.path ? `Path: ${action.path}` : '',
      action.fileType ? `File-Type: ${action.fileType}` : '',
      `Files: ${fileMatches.length}`,
      `Matches: ${totalMatches}`,
      `Window: offset=${offset}, limit=${limit}`,
      '',
      ...selected.map((match) => [
        `[${match.path}:${match.lineNumber}]`,
        match.excerpt
      ].join('\n'))
    ].filter((line) => line !== '').join('\n\n')
  };
}

async function searchProjectContent(project: Project, files: ProjectFileEntry[], terms: string[]): Promise<Array<{
  path: string;
  excerpts: string[];
}>> {
  const loweredTerms = terms.map((term) => term.toLowerCase()).filter(Boolean);
  if (loweredTerms.length === 0) {
    return [];
  }

  const results: Array<{
    path: string;
    excerpts: string[];
  }> = [];

  for (const file of onlyFiles(files)) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }

    const lowerPath = file.path.toLowerCase();
    if (loweredTerms.some((term) => lowerPath.includes(term))) {
      results.push({
        path: file.path,
        excerpts: ['路径命中搜索词']
      });
      continue;
    }

    if (file.size > 200_000) {
      continue;
    }

    try {
      const content = (await readProjectFileForProject(project, file.path)).content;
      const lines = content.split('\n');
      const excerpts = lines
        .filter((line) => loweredTerms.some((term) => line.toLowerCase().includes(term)))
        .slice(0, 3)
        .map((line) => truncate(line.trim(), 180))
        .filter(Boolean);

      if (excerpts.length > 0) {
        results.push({
          path: file.path,
          excerpts
        });
      }
    } catch {
      // ignore unreadable file
    }
  }

  return results;
}

export async function collectWorkspaceToolEvidence(project: Project, message: string): Promise<{
  fileTreeSummary: string | undefined;
  directorySummaries: Array<{
    path: string;
    summary: string;
  }>;
  searchResults: Array<{
    path: string;
    excerpts: string[];
  }>;
  filesRead: Array<{
    path: string;
    content: string;
    truncated?: boolean;
  }>;
}> {
  if (!project.engine?.projectPath) {
    return {
      fileTreeSummary: undefined,
      directorySummaries: [],
      searchResults: [],
      filesRead: []
    };
  }

  const files = await listProjectFilesForProject(project);
  const shouldScanTree = shouldInspectFileTree(message);
  const shouldSearch = shouldSearchProjectContent(message);
  const shouldSummarizeDirs = shouldSummarizeDirectory(message);
  const pathTokens = extractPathTokens(message);
  const matchedFiles = resolveMatchedFiles(pathTokens, files);
  const matchedDirectories = shouldSummarizeDirs ? resolveMatchedDirectories(extractDirectoryTokens(message), files) : [];
  const searchTerms = shouldSearch ? extractSearchTerms(message) : [];

  const filesRead = await Promise.all(
    matchedFiles.map(async (filePath) => {
      const file = await readProjectFileForProject(project, filePath);
      return {
        path: file.path,
        content: truncate(file.content, MAX_FILE_PREVIEW_CHARS),
        truncated: file.truncated
      };
    })
  );

  const searchResults = shouldSearch ? await searchProjectContent(project, files, searchTerms) : [];
  const directorySummaries = matchedDirectories.map((directory) => ({
    path: directory,
    summary: buildDirectorySummary(directory, files)
  }));

  return {
    fileTreeSummary: shouldScanTree
      ? files
          .slice(0, MAX_TREE_ITEMS)
          .map((file) => `- ${file.type === 'directory' ? `${file.path}/` : file.path}`)
          .join('\n')
      : undefined,
    directorySummaries,
    searchResults,
    filesRead
  };
}

export async function applyWorkspaceWriteOperations(
  project: Project,
  operations: WorkspaceWriteOperation[],
  options?: {
    checkpointSnapshotId?: string;
  }
): Promise<WorkspaceWriteResult[]> {
  const limitedOperations = operations.slice(0, MAX_WRITE_OPERATIONS);
  const results: WorkspaceWriteResult[] = [];

  for (const operation of limitedOperations) {
    try {
      await recordFileCheckpoint({
        snapshotId: options?.checkpointSnapshotId,
        project,
        filePath: operation.path
      });
      const file = await writeProjectTextFileForProject(project, operation.path, operation.content);
      results.push({
        path: file.path,
        size: file.size ?? Buffer.byteLength(operation.content, 'utf8'),
        success: true
      });
    } catch (error) {
      results.push({
        path: operation.path,
        size: 0,
        success: false,
        error: error instanceof Error ? error.message : '写入失败。'
      });
    }
  }

  return results;
}
