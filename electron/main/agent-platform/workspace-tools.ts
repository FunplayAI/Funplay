import { spawn, type ChildProcess } from 'node:child_process';
import { resolveRunCommandShell } from './system-shell';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { DEFAULT_AGENT_SETTINGS, DEFAULT_AI_SETTINGS, DEFAULT_MCP_SETTINGS } from '../../../shared/types';
import type {
  AppState,
  AppNotificationPriority,
  AgentToolArtifact,
  AgentUserInputOption,
  ChatMediaBlock,
  EngineProjectDimension,
  EnvironmentActionKind,
  EnvironmentActionResult,
  EnvironmentDiagnostics,
  McpPlugin,
  McpPluginKind,
  PlatformChoice,
  Project,
  ProjectRuntimeState,
  ProjectSetupMode,
  ProjectFileContent,
  ProjectFileEntry,
  ScheduledNotificationTaskType,
  UnityMcpCallResult,
  UnityMcpResource,
  UnityMcpTool
} from '../../../shared/types';
import { executeUnityTool } from '../game-tool-layer';
import type { McpClientRequestHandler } from '../mcp-connection-manager';
import { cancelNotificationTask, listNotificationTasks, scheduleNotificationTask, sendAppNotification } from '../notification-service';
import {
  listProjectFilesForProject,
  applyProjectTextPatchForProject,
  previewProjectTextDiffForProject,
  previewProjectTextPatchForProject,
  readProjectFileForProject,
  replaceMultipleProjectTextInFileForProject,
  replaceProjectTextInFileForProject,
  resolveProjectRootPathForProject,
  writeProjectTextFileForProject
} from '../project-file-service';
import { listUnityResources, listUnityTools, readUnityResource } from '../unity-mcp-client';
import { diagnoseEnvironment, getProjectRuntimeState, runEnvironmentAction } from '../environment-service';
import { generateAssetForProject, importGeneratedAsset, listAssetGenerationProviders } from '../asset-generation-service';
import { inspectGameProject } from './game-project-inspector';
import { inferMcpToolReadOnly, resolveMcpToolPolicy } from './mcp-policy';
import {
  applyWorkspaceWriteOperations as _applyWorkspaceWriteOperations,
  buildDirectorySummary,
  findProjectFiles as _findProjectFiles,
  formatFileMatches as _formatFileMatches,
  performAdvancedProjectSearch as _performAdvancedProjectSearch
} from './project-search-tools';
import {
  captureBrowserScreenshot,
  clickBrowserPage,
  closeBrowserPage,
  listBrowserPages,
  navigateBrowserPage,
  openBrowserPage,
  readBrowserConsole,
  readBrowserSnapshot,
  typeBrowserPage
} from './browser-inspection-store';
import { previewFileCheckpointChanges, recordFileCheckpoint, restoreFileCheckpoint } from './file-checkpoint-store';
import {
  listPersistentTerminals,
  readPersistentTerminal,
  readPersistentTerminalMetadata,
  snapshotPersistentTerminalOutput,
  startPersistentTerminal,
  stopPersistentTerminal,
  writePersistentTerminal
} from './persistent-terminal-store';
import {
  performImageGenerate,
  performMediaAttach,
  performMediaSaveBase64,
  performReadDocument,
  performWebFetch,
  performWebSearch
} from './media-tools';
import { performMemoryGet, performMemoryRecent, performMemoryRemember, performMemorySearch } from './memory-tools';
import { buildAgentSkillRegistry, findAgentSkillPackage, listAgentSkillSupportingFiles, readAgentSkillSupportingFile } from './skill-registry';
import { createUnsupportedEngineResult, getEngineAdapter, type EngineAdapterCapability } from './engine-adapters';
import {
  MAX_TREE_ITEMS,
  MAX_FILE_PREVIEW_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_DIRECTORY_ITEMS,
  MAX_WRITE_OPERATIONS,
  MAX_FIND_FILE_RESULTS,
  MAX_PROJECT_SEARCH_RESULTS,
  MAX_READ_RANGE_LINES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_CHARS,
  MAX_MEMORY_SEARCH_RESULTS,
  MAX_MEMORY_TOOL_CHARS,
  RECENT_MEMORY_DAYS,
  MAX_DOCUMENT_CHARS,
  DEFAULT_DOCUMENT_CHARS,
  MAX_ZIP_TEXT_BYTES,
  type WorkspaceWriteOperation,
  type WorkspaceWriteResult,
  type WorkspaceToolAction,
  type WorkspaceToolActionResult,
  type AgentToolExecutionOptions,
  type TodoListAction,
  unique,
  truncate,
  isDocumentLikePath,
  normalizeWorkspaceFilePath
} from './workspace-tools-types';
export {
  type WorkspaceWriteOperation,
  type WorkspaceWriteResult,
  type WorkspaceToolAction,
  type WorkspaceToolActionResult,
  type AgentToolExecutionOptions
} from './workspace-tools-types';

const MCP_TOOL_TIMEOUT_MS = 45_000;
const MAX_MCP_URI_CHARS = 2048;
const MAX_MCP_TOOL_NAME_CHARS = 160;
const MAX_MCP_ARGS_JSON_CHARS = 64_000;
const MAX_SKILL_INSTRUCTION_CHARS = 24_000;
const COMMAND_OUTPUT_ARTIFACT_DIR = 'funplay-agent-artifacts';

function normalizeDocumentMaxChars(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) {
    return DEFAULT_DOCUMENT_CHARS;
  }
  return Math.max(1000, Math.min(Math.floor(maxChars), MAX_DOCUMENT_CHARS));
}

function normalizeExtractedText(value: string, maxChars: number): string {
  return value
    .replace(/\u0000/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripXmlToText(value: string, maxChars: number): string {
  const expanded = value
    .replace(/<\/(?:w:p|a:p|p|row|si|sst|slide)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeExtractedText(decodeXmlEntities(expanded), maxChars);
}

function extractReadableBinaryText(bytes: Buffer, maxChars: number): string {
  const text = bytes.toString('latin1')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]+/g, ' ')
    .replace(/\s{2,}/g, '\n');
  return normalizeExtractedText(text, maxChars);
}

function decodePdfLiteral(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, char: string) => {
      if (char === 'n') return '\n';
      if (char === 'r') return '\r';
      if (char === 't') return '\t';
      if (char === 'b' || char === 'f') return ' ';
      return char;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function extractPdfLiteralText(source: string, maxChars: number): string {
  const literals = [...source.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)]
    .map((match) => decodePdfLiteral(match[0]).replace(/\s+/g, ' ').trim())
    .filter((value) => /[A-Za-z0-9\u4e00-\u9fff]/.test(value) && value.length > 1);
  return normalizeExtractedText(literals.join('\n'), maxChars);
}

interface PageSelection {
  label: string;
  ranges: Array<{
    start: number;
    end: number;
  }>;
}

function parsePageSelection(pages?: string): PageSelection | undefined {
  const trimmed = pages?.trim();
  if (!trimmed) {
    return undefined;
  }
  const ranges = trimmed.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`);
    }
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (start < 1 || end < start) {
      throw new Error(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`);
    }
    return { start, end };
  });
  return {
    label: trimmed,
    ranges
  };
}

function pageSelectionIncludes(selection: PageSelection | undefined, pageNumber: number): boolean {
  if (!selection) {
    return true;
  }
  return selection.ranges.some((range) => pageNumber >= range.start && pageNumber <= range.end);
}

function selectIndexedPages(pages: string[], selection: PageSelection | undefined, maxChars: number): string {
  const selected = pages
    .map((text, index) => ({
      pageNumber: index + 1,
      text
    }))
    .filter((page) => pageSelectionIncludes(selection, page.pageNumber));
  return normalizeExtractedText(
    selected.map((page) => `## Page ${page.pageNumber}\n${page.text}`).join('\n\n') || '(no text in requested pages)',
    maxChars
  );
}

function extractPdfText(bytes: Buffer, selection: PageSelection | undefined, maxChars: number): {
  text: string;
  pageCount?: number;
  extraction: string;
} {
  const source = bytes.toString('latin1');
  const pageSegments = source
    .split(/(?=\/Type\s*\/Page\b)/g)
    .filter((segment) => /\/Type\s*\/Page\b/.test(segment));
  if (pageSegments.length > 0) {
    const pageTexts = pageSegments.map((segment) => extractPdfLiteralText(segment, maxChars)).filter(Boolean);
    if (pageTexts.join('\n').length >= 60) {
      return {
        text: selectIndexedPages(pageTexts, selection, maxChars),
        pageCount: pageTexts.length,
        extraction: 'pdf-page-text'
      };
    }
  }
  const text = extractPdfLiteralText(source, maxChars);
  return {
    text: text || extractReadableBinaryText(bytes, maxChars),
    extraction: 'pdf-text'
  };
}

async function runUnzip(args: string[], maxBytes = MAX_ZIP_TEXT_BYTES): Promise<string | undefined> {
  return await new Promise((resolveResult) => {
    const child = spawn('unzip', args, {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let killed = false;
    child.stdout?.on('data', (data: Buffer) => {
      byteLength += data.length;
      if (byteLength > maxBytes) {
        killed = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(data);
    });
    child.on('error', () => resolveResult(undefined));
    child.on('close', (code) => {
      if (code !== 0 && !killed) {
        resolveResult(undefined);
        return;
      }
      resolveResult(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function listZipEntries(absolutePath: string): Promise<string[]> {
  const output = await runUnzip(['-Z1', absolutePath], 300_000);
  return output?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
}

async function readZipEntryText(absolutePath: string, entry: string): Promise<string | undefined> {
  return await runUnzip(['-p', absolutePath, entry]);
}

async function extractOfficeDocumentText(
  absolutePath: string,
  extension: string,
  selection: PageSelection | undefined,
  maxChars: number
): Promise<{
  text: string;
  pageCount?: number;
  extraction: string;
}> {
  if (extension === '.docx') {
    const xml = await readZipEntryText(absolutePath, 'word/document.xml');
    return {
      text: xml ? stripXmlToText(xml, maxChars) : '',
      extraction: 'docx-xml'
    };
  }

  if (extension === '.pptx') {
    const entries = (await listZipEntries(absolutePath))
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
      .sort((left, right) => Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0) - Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0));
    const slideTexts = await Promise.all(entries.map(async (entry) => stripXmlToText(await readZipEntryText(absolutePath, entry) ?? '', maxChars)));
    return {
      text: selectIndexedPages(slideTexts, selection, maxChars),
      pageCount: slideTexts.length,
      extraction: 'pptx-slides'
    };
  }

  if (extension === '.xlsx') {
    const entries = (await listZipEntries(absolutePath))
      .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))
      .sort((left, right) => Number(left.match(/sheet(\d+)\.xml$/i)?.[1] ?? 0) - Number(right.match(/sheet(\d+)\.xml$/i)?.[1] ?? 0));
    const sharedStrings = stripXmlToText(await readZipEntryText(absolutePath, 'xl/sharedStrings.xml') ?? '', maxChars);
    const sheetTexts = await Promise.all(entries.map(async (entry, index) => {
      const sheetText = stripXmlToText(await readZipEntryText(absolutePath, entry) ?? '', maxChars);
      return [`Sheet ${index + 1}`, sheetText].filter(Boolean).join('\n');
    }));
    return {
      text: normalizeExtractedText([sharedStrings ? `Shared strings:\n${sharedStrings}` : '', selectIndexedPages(sheetTexts, selection, maxChars)].filter(Boolean).join('\n\n'), maxChars),
      pageCount: sheetTexts.length,
      extraction: 'xlsx-sheets'
    };
  }

  return {
    text: '',
    extraction: 'zip-unsupported'
  };
}

async function extractLocalDocumentText(
  absolutePath: string,
  relativePath: string,
  bytes: Buffer,
  options: {
    pages?: string;
    maxChars?: number;
  }
): Promise<{
  text: string;
  extraction: string;
  pageCount?: number;
  pages?: string;
}> {
  const maxChars = normalizeDocumentMaxChars(options.maxChars);
  const selection = parsePageSelection(options.pages);
  const extension = extname(relativePath).toLowerCase();
  const body = bytes.toString('utf8');
  if (extension === '.pdf') {
    const extracted = extractPdfText(bytes, selection, maxChars);
    return {
      ...extracted,
      pages: selection?.label
    };
  }
  if (extension === '.rtf') {
    const text = body
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'[0-9a-f]{2}/gi, ' ')
      .replace(/\\[a-z]+\d* ?/gi, '')
      .replace(/[{}]/g, ' ');
    return {
      text: normalizeExtractedText(text, maxChars),
      extraction: 'rtf-text',
      pages: selection?.label
    };
  }
  if (['.xml', '.svg', '.html', '.htm'].includes(extension)) {
    return {
      text: stripXmlToText(body, maxChars),
      extraction: 'markup-text',
      pages: selection?.label
    };
  }
  if (['.docx', '.pptx', '.xlsx'].includes(extension)) {
    const extracted = await extractOfficeDocumentText(absolutePath, extension, selection, maxChars);
    return {
      ...extracted,
      text: extracted.text || extractReadableBinaryText(bytes, maxChars),
      pages: selection?.label
    };
  }

  const textPages = body.split('\f');
  return {
    text: textPages.length > 1
      ? selectIndexedPages(textPages, selection, maxChars)
      : normalizeExtractedText(body, maxChars),
    pageCount: textPages.length > 1 ? textPages.length : undefined,
    extraction: textPages.length > 1 ? 'text-pages' : 'plain-text',
    pages: selection?.label
  };
}

function truncateCommandOutput(value: string): {
  output: string;
  truncated: boolean;
} {
  if (value.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return {
      output: value,
      truncated: false
    };
  }

  return {
    output: `${value.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n\n[Output truncated by Funplay: exceeded ${MAX_COMMAND_OUTPUT_CHARS} chars]`,
    truncated: true
  };
}

function truncateStructuredOutput(value: string, maxLength = 16_000): {
  output: string;
  truncated: boolean;
} {
  if (value.length <= maxLength) {
    return {
      output: value,
      truncated: false
    };
  }
  return {
    output: `${value.slice(0, maxLength)}\n\n[Structured output truncated by Funplay: exceeded ${maxLength} chars]`,
    truncated: true
  };
}

function parseBrowserSummary(summary: string): WorkspaceToolActionResult['browser'] {
  const sessionId = summary.match(/Browser session: (browser_[a-z0-9]+)/)?.[1];
  const url = summary.match(/^URL: (.+)$/m)?.[1];
  const title = summary.match(/^Title: (.+)$/m)?.[1];
  const viewportMatch = summary.match(/^Viewport: (\d+)x(\d+)$/m);
  return {
    sessionId,
    url,
    title: title && title !== '(untitled)' ? title : undefined,
    viewport: viewportMatch
      ? {
          width: Number(viewportMatch[1]),
          height: Number(viewportMatch[2])
        }
      : undefined
  };
}

function parseBrowserScreenshotSummary(summary: string): {
  browser: WorkspaceToolActionResult['browser'];
  artifacts?: WorkspaceToolActionResult['artifacts'];
} {
  const screenshotPath = summary.match(/^Screenshot saved: (.+)$/m)?.[1];
  const size = Number(summary.match(/^Bytes: (\d+)$/m)?.[1] ?? 0);
  const url = summary.match(/^URL: (.+)$/m)?.[1];
  return {
    browser: {
      screenshotPath,
      url
    },
    artifacts: screenshotPath
      ? [{
          type: 'browser_screenshot',
          path: screenshotPath,
          title: 'Browser screenshot',
          mimeType: 'image/png',
          size: Number.isFinite(size) && size > 0 ? size : undefined
        }]
      : undefined
  };
}

function parseTerminalReadSummary(summary: string, sessionId: string): WorkspaceToolActionResult['terminal'] {
  const status = summary.match(/\bstatus=([^|\n]+)/)?.[1]?.trim();
  const cwd = summary.match(/\bcwd=([^|\n]+)/)?.[1]?.trim();
  const command = summary.match(/\bcommand=([^|\n]+)/)?.[1]?.trim();
  const nextSeq = Number(summary.match(/^nextSeq=(\d+)$/m)?.[1] ?? 0);
  return {
    sessionId,
    status,
    cwd,
    command,
    nextSeq: Number.isFinite(nextSeq) && nextSeq > 0 ? nextSeq : undefined
  };
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

async function createWorkspaceDirectory(project: Project, path: string): Promise<WorkspaceToolActionResult> {
  const rootPath = resolveProjectRootPathForProject(project);
  const relativePath = normalizeOptionalDirectoryPath(path);
  if (!relativePath) {
    throw new Error('目录路径不能为空。');
  }

  const directoryPath = resolve(rootPath, relativePath);
  if (directoryPath !== rootPath && !directoryPath.startsWith(`${rootPath}/`)) {
    throw new Error('非法目录路径。');
  }

  await mkdir(directoryPath, { recursive: true });
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error('目标路径不是目录。');
  }

  return {
    ok: true,
    summary: `已创建目录 ${relativePath}`,
    changedFiles: [{
      path: relativePath,
      operation: 'directory_created'
    }]
  };
}

function resolveCommandCwd(project: Project, cwd?: string): {
  rootPath: string;
  cwdPath: string;
  relativeCwd: string;
} {
  const rootPath = resolveProjectRootPathForProject(project);
  const relativeCwd = normalizeOptionalDirectoryPath(cwd);
  const cwdPath = relativeCwd ? resolve(rootPath, relativeCwd) : rootPath;
  if (cwdPath !== rootPath && !cwdPath.startsWith(`${rootPath}/`)) {
    throw new Error('非法命令工作目录。');
  }

  return {
    rootPath,
    cwdPath,
    relativeCwd: relativeCwd || '.'
  };
}

function normalizeCommandTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }

  return Math.max(1_000, Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS));
}

function hasShellBackgroundControlOperator(command: string): boolean {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '&') {
      continue;
    }

    const previous = command[index - 1];
    const next = command[index + 1];
    if (previous === '&' || next === '&' || previous === '>' || next === '>') {
      continue;
    }
    if (next === undefined || /\s|[;|)]/.test(next) || previous === undefined || /\s|[;|(<]/.test(previous)) {
      return true;
    }
  }
  return false;
}

function stripTrailingShellBackgroundControlOperator(command: string): string | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let backgroundIndex = -1;
  let backgroundCount = 0;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '&') {
      continue;
    }

    const previous = command[index - 1];
    const next = command[index + 1];
    if (previous === '&' || next === '&' || previous === '>' || next === '>') {
      continue;
    }
    if (next === undefined || /\s|[;|)]/.test(next) || previous === undefined || /\s|[;|(<]/.test(previous)) {
      backgroundIndex = index;
      backgroundCount += 1;
    }
  }

  if (backgroundCount !== 1 || backgroundIndex < 0 || command.slice(backgroundIndex + 1).trim()) {
    return undefined;
  }

  const foregroundCommand = command.slice(0, backgroundIndex).trim();
  return foregroundCommand || undefined;
}

function stopCommandProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
    }
  }
  try {
    child.kill(signal);
  } catch {
  }
}

function formatReadFileSummary(file: ProjectFileContent, options: {
  offset?: number;
  limit?: number;
}): string {
  if (typeof options.offset !== 'number' && typeof options.limit !== 'number') {
    return [
      `[${file.path}]${file.truncated ? ' (truncated)' : ''}`,
      truncate(file.content, MAX_FILE_PREVIEW_CHARS)
    ].join('\n');
  }

  const lines = file.content.split('\n');
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 200), MAX_READ_RANGE_LINES));
  const end = Math.min(offset + limit, lines.length);
  const selectedLines = offset < lines.length ? lines.slice(offset, end) : [];
  const body = selectedLines
    .map((line, index) => `${offset + index + 1}\t${line}`)
    .join('\n');

  return [
    `[${file.path}] lines ${offset + 1}-${end} of ${lines.length}${file.truncated ? ' (source truncated)' : ''}`,
    body || '(no lines in requested range)'
  ].join('\n');
}

function formatTodoListSummary(action: TodoListAction): string {
  const statusLabels: Record<TodoListAction['items'][number]['status'], string> = {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
    cancelled: 'cancelled'
  };
  const items = action.items.slice(0, 20);

  if (items.length === 0) {
    return '任务清单为空。';
  }

  return [
    `任务清单已更新（${items.length} 项）：`,
    ...items.map((item, index) => {
      const id = item.id?.trim() || String(index + 1);
      const priority = item.priority ? ` (${item.priority})` : '';
      return `- [${statusLabels[item.status]}] ${id}${priority}: ${truncate(item.content.trim(), 180)}`;
    })
  ].join('\n');
}

function createEditMetrics(input: WorkspaceToolActionResult['edit']): WorkspaceToolActionResult['edit'] {
  return input;
}

function classifyEditFailure(action: WorkspaceToolAction, errorMessage: string): NonNullable<WorkspaceToolActionResult['edit']>['failureKind'] | undefined {
  if (action.type === 'preview_patch' || action.type === 'patch_file') {
    return 'invalid_patch';
  }
  if (action.type === 'edit_file' || action.type === 'multi_edit') {
    if (/匹配了 \d+ 处/.test(errorMessage)) return 'ambiguous_match';
    if (/没有.*找到|未找到|not found|no match|匹配了 0 处/i.test(errorMessage)) return 'missing_match';
    return 'unknown';
  }
  if (action.type === 'write_file') {
    return /非法|路径|目录/.test(errorMessage) ? 'path_error' : 'unknown';
  }
  return undefined;
}

function createFailedEditMetrics(action: WorkspaceToolAction, errorMessage: string): WorkspaceToolActionResult['edit'] | undefined {
  if (action.type === 'edit_file') {
    return createEditMetrics({
      strategy: 'search_replace',
      patchFirst: false,
      preflight: 'failed',
      failureKind: classifyEditFailure(action, errorMessage),
      recoveryHint: '读取目标片段后使用更精确 oldText，或改用 preview_patch/patch_file 提交统一 diff。'
    });
  }
  if (action.type === 'multi_edit') {
    return createEditMetrics({
      strategy: 'multi_edit',
      patchFirst: false,
      preflight: 'failed',
      editCount: action.edits.length,
      failureKind: classifyEditFailure(action, errorMessage),
      recoveryHint: 'multi_edit 已在写入前失败，文件未修改；读取目标片段后重试，或改用 unified patch。'
    });
  }
  if (action.type === 'preview_patch' || action.type === 'patch_file') {
    return createEditMetrics({
      strategy: 'unified_patch',
      patchFirst: true,
      preflight: 'failed',
      failureKind: classifyEditFailure(action, errorMessage),
      recoveryHint: '重新读取目标文件上下文，生成包含准确上下文行的 unified diff 后重试。'
    });
  }
  if (action.type === 'write_file') {
    return createEditMetrics({
      strategy: 'write_file',
      patchFirst: false,
      preflight: 'failed',
      failureKind: classifyEditFailure(action, errorMessage),
      recoveryHint: '确认路径在项目目录内，必要时先创建父目录。'
    });
  }
  return undefined;
}

function summarizeMcpResult(result: UnityMcpCallResult): string {
  const text = result.content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n')
    .trim();

  if (text) {
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }

  const imageCount = result.content.filter((part) => part.type === 'image').length;
  return imageCount > 0 ? `工具返回 ${imageCount} 张图片。` : '工具没有返回文本内容。';
}

function summarizeAssetGenerationProviders(state: AppState, kind?: string): string {
  const providers = listAssetGenerationProviders(state)
    .filter((provider) => !kind || (provider.supportedKinds as readonly string[]).includes(kind));
  return providers.length
    ? providers.map((provider, index) =>
        [
          `${index + 1}. ${provider.name} [${provider.adapter}]`,
          `ID: ${provider.id}`,
          `Enabled: ${provider.enabled ? 'yes' : 'no'}`,
          provider.modelLabel ? `Model: ${provider.modelLabel}` : '',
          provider.endpointLabel ? `Endpoint: ${provider.endpointLabel}` : '',
          `Kinds: ${provider.supportedKinds.join(', ')}`,
          provider.notes ? `Notes: ${provider.notes}` : ''
        ].filter(Boolean).join('\n')
      ).join('\n\n')
    : 'No asset generation providers match the requested kind.';
}

function createAssetGenerationState(options: AgentToolExecutionOptions, project: Project): AppState {
  if (options.appState) {
    return options.appState;
  }
  return createDetachedEngineToolState(project);
}

async function persistAssetGenerationState(options: AgentToolExecutionOptions): Promise<void> {
  if (options.appState && options.persistAppState) {
    await options.persistAppState(options.appState);
  }
}

function createDetachedEngineToolState(project: Project): AppState {
  return {
    settings: {
      baseUrl: project.runtimeState?.mcpSettings?.url ?? 'http://127.0.0.1:8765/',
      profile: 'core',
      lastStatus: 'idle',
      lastAssignedMcpPort: project.runtimeState?.mcpSettings?.port ?? 8765
    },
    aiSettings: DEFAULT_AI_SETTINGS,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    providers: [],
    mcpSettings: DEFAULT_MCP_SETTINGS,
    mcpPlugins: [],
    assetGenerationProviders: [],
    projects: [project]
  };
}

function resolveEnginePlatform(project: Project, platform?: PlatformChoice): PlatformChoice {
  return platform ?? project.engine?.platform ?? 'web';
}

function resolveEngineProjectPath(project: Project, projectPath?: string): string {
  return projectPath?.trim() || project.engine?.projectPath?.trim() || '';
}

function resolveEngineDimension(project: Project, dimension?: EngineProjectDimension): EngineProjectDimension {
  return dimension ?? project.engine?.dimension ?? project.runtimeState?.detectedDimension ?? 'unknown';
}

function buildEngineEnvironmentInput(
  project: Project,
  input: {
    platform?: PlatformChoice;
    mode?: ProjectSetupMode;
    dimension?: EngineProjectDimension;
    projectName?: string;
    projectPath?: string;
    enginePluginId?: string;
    unityEditorVersion?: string;
  }
): {
  platform: PlatformChoice;
  mode: ProjectSetupMode;
  dimension: EngineProjectDimension;
  projectName?: string;
  projectPath: string;
  enginePluginId?: string;
  unityEditorVersion?: string;
} {
  return {
    platform: resolveEnginePlatform(project, input.platform),
    mode: input.mode ?? 'import',
    dimension: resolveEngineDimension(project, input.dimension),
    projectName: input.projectName,
    projectPath: resolveEngineProjectPath(project, input.projectPath),
    enginePluginId: input.enginePluginId ?? project.mcpBindings?.engine ?? project.mcpPluginId,
    unityEditorVersion: input.unityEditorVersion ?? project.engine?.unityEditorVersion
  };
}

function formatStatusBadge(status: EnvironmentDiagnostics['checks'][number]['status']): string {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'warning':
      return 'warning';
    case 'failed':
      return 'failed';
    case 'pending':
    default:
      return 'pending';
  }
}

function formatEnvironmentDiagnostics(diagnostics: EnvironmentDiagnostics): string {
  const checks = diagnostics.checks.map((check, index) => {
    const actions = check.actions.length
      ? `\n  Actions: ${check.actions.map((action) => action.id).join(', ')}`
      : '';
    return `${index + 1}. [${formatStatusBadge(check.status)}] ${check.title}\n  ${check.detail}${actions}`;
  });
  return [
    `Engine platform: ${diagnostics.platform}`,
    `Mode: ${diagnostics.mode}`,
    `Project path: ${diagnostics.projectPath || '(none)'}`,
    `Ready: ${diagnostics.ready ? 'yes' : 'no'}`,
    '',
    ...checks
  ].join('\n');
}

function formatRuntimeState(runtimeState: ProjectRuntimeState, platform: PlatformChoice, projectPath: string): string {
  const bridgeHealth = runtimeState.bridgeHealth;
  return [
    `Engine platform: ${platform}`,
    `Project path: ${projectPath || '(none)'}`,
    `Checked at: ${runtimeState.checkedAt}`,
    `Project exists: ${runtimeState.projectExists ? 'yes' : 'no'}`,
    platform === 'unity' ? `Unity project valid: ${runtimeState.unityProjectValid ? 'yes' : 'no'}` : '',
    `Project open: ${runtimeState.projectOpen ? 'yes' : 'no'}`,
    `Bridge installed: ${runtimeState.bridgeInstalled ? 'yes' : 'no'}`,
    runtimeState.detectedDimension ? `Detected dimension: ${runtimeState.detectedDimension}` : '',
    runtimeState.mcpSettings ? `MCP settings: ${runtimeState.mcpSettings.url} (${runtimeState.mcpSettings.toolExportProfile})` : '',
    bridgeHealth ? `MCP health: ${bridgeHealth.status} - ${bridgeHealth.message}` : 'MCP health: not checked',
    runtimeState.availableResourceUris?.length ? `MCP resources: ${runtimeState.availableResourceUris.join(', ')}` : '',
    runtimeState.activeSceneSummary ? `Active scene:\n${runtimeState.activeSceneSummary}` : '',
    runtimeState.currentSelectionSummary ? `Selection:\n${runtimeState.currentSelectionSummary}` : '',
    runtimeState.recentConsoleSummary ? `Recent console:\n${runtimeState.recentConsoleSummary}` : ''
  ].filter(Boolean).join('\n');
}

function summarizeEnvironmentAction(result: EnvironmentActionResult, diagnostics?: EnvironmentDiagnostics): string {
  return [
    `Action: ${result.actionId}`,
    `Status: ${result.status}`,
    `Message: ${result.message}`,
    result.taskId ? `Task id: ${result.taskId}` : '',
    diagnostics ? ['', 'Post-action diagnostics:', formatEnvironmentDiagnostics(diagnostics)].join('\n') : ''
  ].filter(Boolean).join('\n');
}

function sanitizeArtifactSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'command';
}

async function writeCommandOutputArtifact(input: {
  project: Project;
  command: string;
  cwd: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  combined: string;
}): Promise<AgentToolArtifact | undefined> {
  try {
    const output = [
      `Command: ${input.command}`,
      `Cwd: ${input.cwd}`,
      `Exit code: ${input.exitCode ?? 'none'}`,
      input.signal ? `Signal: ${input.signal}` : '',
      input.timedOut ? 'Timed out: yes' : 'Timed out: no',
      '',
      input.combined
    ].filter(Boolean).join('\n');
    const artifactDir = join(tmpdir(), COMMAND_OUTPUT_ARTIFACT_DIR, sanitizeArtifactSegment(input.project.id));
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(
      artifactDir,
      `${Date.now()}-${sanitizeArtifactSegment(input.command)}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    await writeFile(artifactPath, output, 'utf8');
    return {
      type: 'command_output',
      path: artifactPath,
      title: input.command,
      mimeType: 'text/plain',
      size: Buffer.byteLength(output, 'utf8')
    };
  } catch {
    return undefined;
  }
}

async function writeTerminalOutputArtifact(input: {
  project: Project;
  sessionId: string;
  title?: string;
}): Promise<AgentToolArtifact | undefined> {
  try {
    const snapshot = snapshotPersistentTerminalOutput(input.sessionId);
    const artifactDir = join(tmpdir(), COMMAND_OUTPUT_ARTIFACT_DIR, sanitizeArtifactSegment(input.project.id));
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(
      artifactDir,
      `${Date.now()}-terminal-${sanitizeArtifactSegment(input.sessionId)}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    await writeFile(artifactPath, snapshot.output, 'utf8');
    return {
      type: 'command_output',
      path: artifactPath,
      title: input.title ?? `Terminal ${input.sessionId}`,
      mimeType: 'text/plain',
      size: snapshot.size
    };
  } catch {
    return undefined;
  }
}

async function executeEngineControlAction(
  project: Project,
  action: Extract<WorkspaceToolAction, {
    type:
      | 'diagnose_engine_status'
      | 'refresh_engine_runtime_state'
      | 'open_engine_hub'
      | 'open_engine_project'
      | 'install_engine_bridge'
      | 'run_engine_environment_action';
  }>,
  options: AgentToolExecutionOptions
): Promise<WorkspaceToolActionResult> {
  const state = options.appState ?? createDetachedEngineToolState(project);
  const platform = resolveEnginePlatform(project, action.platform);
  const adapter = getEngineAdapter(platform);
  const capability: EngineAdapterCapability =
    action.type === 'diagnose_engine_status'
      ? 'diagnose'
      : action.type === 'refresh_engine_runtime_state'
        ? 'refresh'
        : action.type === 'open_engine_hub'
          ? 'openHub'
          : action.type === 'open_engine_project'
            ? 'openProject'
            : action.type === 'install_engine_bridge'
              ? 'installBridge'
              : action.actionId === 'open_unity_hub' || action.actionId === 'select_unity_hub'
                ? 'openHub'
                : action.actionId === 'open_unity_project' || action.actionId === 'import_unity_project' || action.actionId === 'create_unity_project'
                  ? 'openProject'
                  : action.actionId === 'install_project_bridge'
                    ? 'installBridge'
                    : 'diagnose';
  if (!adapter.capabilities[capability].supported) {
    return createUnsupportedEngineResult({
      platform,
      capability,
      projectPath: resolveEngineProjectPath(project, 'projectPath' in action ? action.projectPath : undefined)
    });
  }
  const persistState = async () => {
    if (options.appState && options.persistAppState) {
      await options.persistAppState(options.appState);
    }
  };

  if (action.type === 'refresh_engine_runtime_state') {
    const projectPath = resolveEngineProjectPath(project, action.projectPath);
    const runtimeState = await getProjectRuntimeState(state, {
      platform,
      projectPath
    });
    await persistState();
    return {
      ok: true,
      summary: formatRuntimeState(runtimeState, platform, projectPath)
    };
  }

  const environmentInput = buildEngineEnvironmentInput(project, action);
  if (action.type === 'diagnose_engine_status') {
    const diagnostics = await diagnoseEnvironment(state, environmentInput);
    await persistState();
    return {
      ok: true,
      summary: formatEnvironmentDiagnostics(diagnostics)
    };
  }

  const actionId =
    action.type === 'open_engine_hub'
      ? 'open_unity_hub'
      : action.type === 'open_engine_project'
        ? 'open_unity_project'
        : action.type === 'install_engine_bridge'
          ? 'install_project_bridge'
          : action.actionId;
  const result = await runEnvironmentAction(state, {
    ...environmentInput,
    actionId
  });
  const diagnostics = await diagnoseEnvironment(state, environmentInput).catch(() => undefined);
  await persistState();
  return {
    ok: result.status !== 'failed',
    isError: result.status === 'failed',
    summary: summarizeEnvironmentAction(result, diagnostics)
  };
}

async function runWorkspaceCommand(
  project: Project,
  action: Extract<WorkspaceToolAction, { type: 'run_command' }>,
  options: AgentToolExecutionOptions
): Promise<WorkspaceToolActionResult> {
  const command = action.command.trim();
  if (!command) {
    throw new Error('run_command 缺少 command。');
  }

  const { cwdPath, relativeCwd } = resolveCommandCwd(project, action.cwd);
  const timeoutMs = normalizeCommandTimeout(action.timeoutMs);
  const { shell, args: shellArgs } = resolveRunCommandShell(command);
  if (hasShellBackgroundControlOperator(command)) {
    const terminalCommand = stripTrailingShellBackgroundControlOperator(command);
    if (terminalCommand) {
      const started = startPersistentTerminal(project, {
        name: 'Background command',
        command: terminalCommand,
        cwd: action.cwd
      });
      return {
        ok: true,
        summary: [
          'run_command 检测到末尾后台符 &，已改用持久终端启动该任务。',
          `原命令：${command}`,
          `终端命令：${terminalCommand}`,
          `工作目录：${relativeCwd}`,
          '',
          started.summary
        ].join('\n'),
        command: {
          command,
          cwd: relativeCwd,
          timedOut: false,
          stdout: started.summary
        },
        terminal: {
          ...started.terminal,
          command: terminalCommand
        },
        artifacts: [{
          type: 'terminal',
          title: terminalCommand
        }]
      };
    }
    const message = 'run_command 不执行 shell 后台控制符 &。需要启动 dev server、HTTP server、watch 或长期运行任务时，请改用 terminal_start，然后用 terminal_read 查看输出。';
    return {
      ok: false,
      isError: true,
      summary: [
        `命令：${command}`,
        `工作目录：${relativeCwd}`,
        '状态：已拒绝执行后台命令',
        '',
        message
      ].join('\n'),
      command: {
        command,
        cwd: relativeCwd,
        timedOut: false,
        stderr: message
      }
    };
  }

  return await new Promise<WorkspaceToolActionResult>((resolveResult) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const child = spawn(shell, shellArgs, {
      cwd: cwdPath,
      env: {
        ...process.env,
        TERM: 'dumb'
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const finish = (result: WorkspaceToolActionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stopCommandProcess(child, 'SIGTERM');
      setTimeout(() => {
        if (!settled) {
          stopCommandProcess(child, 'SIGKILL');
        }
      }, 2_000).unref?.();
    }, timeoutMs);
    timeout.unref?.();

    const abort = () => {
      timedOut = true;
      stopCommandProcess(child, 'SIGTERM');
    };
    options.abortSignal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (data: Buffer) => {
      stdoutChunks.push(data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener('abort', abort);
      finish({
        ok: false,
        isError: true,
        summary: `命令启动失败：${error.message}`,
        command: {
          command,
          cwd: relativeCwd,
          timedOut: false,
          stderr: error.message
        }
      });
    });

    child.on('close', async (code, signal) => {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener('abort', abort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const combined = [
        stdout ? `stdout:\n${stdout.trimEnd()}` : '',
        stderr ? `stderr:\n${stderr.trimEnd()}` : ''
      ].filter(Boolean).join('\n\n') || '(no output)';
      const truncated = truncateCommandOutput(combined);
      const structuredStdout = truncateStructuredOutput(stdout);
      const structuredStderr = truncateStructuredOutput(stderr);
      const ok = code === 0 && !timedOut && !signal;
      const fullOutputArtifact = truncated.truncated || structuredStdout.truncated || structuredStderr.truncated
        ? await writeCommandOutputArtifact({
            project,
            command,
            cwd: relativeCwd,
            exitCode: code,
            signal,
            timedOut,
            stdout,
            stderr,
            combined
          })
        : undefined;

      finish({
        ok,
        isError: !ok,
        summary: [
          `命令：${command}`,
          `工作目录：${relativeCwd}`,
          `退出码：${code ?? 'none'}`,
          signal ? `信号：${signal}` : '',
          timedOut ? `状态：timeout (${timeoutMs}ms)` : '',
          truncated.truncated ? '输出：已截断' : '',
          '',
          truncated.output
        ].filter((line) => line !== '').join('\n'),
        command: {
          command,
          cwd: relativeCwd,
          exitCode: code,
          signal,
          timedOut,
          stdout: structuredStdout.output,
          stderr: structuredStderr.output,
          outputTruncated: truncated.truncated || structuredStdout.truncated || structuredStderr.truncated
        },
        artifacts: [fullOutputArtifact ?? {
          type: 'command_output' as const,
          title: command,
          size: stdout.length + stderr.length
        }]
      });
    });
  });
}

function isConnectableMcpPlugin(plugin: McpPlugin): boolean {
  return plugin.transport === 'stdio' ? Boolean(plugin.command?.trim()) : Boolean(plugin.baseUrl?.trim());
}

function resolvePluginForAction(plugins: McpPlugin[], action: Extract<WorkspaceToolAction, {
  type: 'list_mcp_tools' | 'list_mcp_resources' | 'read_mcp_resource' | 'call_mcp_tool';
}>): McpPlugin | undefined {
  if (action.pluginId) {
    return plugins.find((plugin) => plugin.id === action.pluginId && plugin.enabled && isConnectableMcpPlugin(plugin));
  }

  if (action.pluginKind) {
    return plugins.find((plugin) => plugin.kind === action.pluginKind && plugin.enabled && isConnectableMcpPlugin(plugin));
  }

  return plugins.find((plugin) => plugin.enabled && isConnectableMcpPlugin(plugin));
}

function validateMcpResourceUri(uri: string): void {
  if (!uri.trim() || uri.length > MAX_MCP_URI_CHARS || /\s/.test(uri)) {
    throw new Error('MCP resource uri 不合法或过长。');
  }
}

function validateMcpToolName(toolName: string): void {
  if (!toolName.trim() || toolName.length > MAX_MCP_TOOL_NAME_CHARS || /\s/.test(toolName)) {
    throw new Error('MCP toolName 不合法或过长。');
  }
}

function serializeMcpArgs(args: Record<string, unknown>): string {
  let serialized = '';
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw new Error('MCP tool args 必须是可 JSON 序列化对象。');
  }
  if (serialized.length > MAX_MCP_ARGS_JSON_CHARS) {
    throw new Error(`MCP tool args 过大：${serialized.length} chars，最大 ${MAX_MCP_ARGS_JSON_CHARS}。`);
  }
  return serialized;
}

function createMcpAbortSignal(abortSignal?: AbortSignal): AbortSignal {
  return abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS)]) : AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstElicitationProperty(schema: Record<string, unknown> | undefined): {
  name: string;
  schema: Record<string, unknown>;
} | undefined {
  const properties = asRecord(schema?.properties);
  if (!properties) {
    return undefined;
  }
  const [name, propertySchema] = Object.entries(properties)[0] ?? [];
  const normalized = asRecord(propertySchema);
  return name && normalized ? { name, schema: normalized } : undefined;
}

function enumOptionsForElicitation(propertySchema: Record<string, unknown> | undefined): AgentUserInputOption[] {
  const values = Array.isArray(propertySchema?.enum) ? propertySchema.enum : [];
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 20)
    .map((value) => ({
      id: value,
      label: value
    }));
}

function createMcpElicitationHandler(options: AgentToolExecutionOptions): McpClientRequestHandler | undefined {
  const requestUserInput = options.requestUserInput;
  if (!requestUserInput) {
    return undefined;
  }

  return async (request) => {
    if (request.method !== 'elicitation/create') {
      throw new Error(`Unsupported MCP client request: ${request.method}`);
    }

    const schema = asRecord(request.params.requestedSchema) ?? asRecord(request.params.requestSchema);
    const property = firstElicitationProperty(schema);
    const optionsForUser = enumOptionsForElicitation(property?.schema);
    const schemaTitle = typeof schema?.title === 'string' ? schema.title : '';
    const schemaDescription = typeof schema?.description === 'string' ? schema.description : '';
    const propertyDescription = typeof property?.schema.description === 'string' ? property.schema.description : '';
    const response = await requestUserInput({
      title: 'MCP 需要你的输入',
      question: typeof request.params.message === 'string' ? request.params.message : 'MCP server requested user input.',
      detail: [schemaTitle, schemaDescription, propertyDescription].filter(Boolean).join('\n'),
      options: optionsForUser,
      allowFreeText: optionsForUser.length === 0,
      multiSelect: false,
      toolName: 'mcp_elicitation'
    });

    if (response.cancelled) {
      return {
        action: 'cancel'
      };
    }

    const value = response.optionId ?? response.answer;
    return {
      action: 'accept',
      content: property?.name
        ? { [property.name]: value }
        : {
            answer: response.answer,
            optionId: response.optionId,
            optionIds: response.optionIds
          }
    };
  };
}

function createMcpMetadata(input: {
  action: Extract<WorkspaceToolAction, { type: 'list_mcp_tools' | 'list_mcp_resources' | 'read_mcp_resource' | 'call_mcp_tool' }>;
  plugin?: McpPlugin;
  argsSize?: number;
  contentPartCount?: number;
  schemaGuard: 'passed' | 'failed';
  failureKind?: NonNullable<WorkspaceToolActionResult['mcp']>['failureKind'];
}): WorkspaceToolActionResult['mcp'] {
  const metadata: NonNullable<WorkspaceToolActionResult['mcp']> = {
    pluginId: input.plugin?.id ?? input.action.pluginId,
    pluginKind: input.plugin?.kind ?? input.action.pluginKind,
    operation:
      input.action.type === 'list_mcp_tools' ? 'list_tools' :
      input.action.type === 'list_mcp_resources' ? 'list_resources' :
      input.action.type === 'read_mcp_resource' ? 'read_resource' :
      'call_tool',
    target:
      input.action.type === 'list_mcp_tools' ? 'tools' :
      input.action.type === 'list_mcp_resources' ? 'resources' :
      input.action.type === 'read_mcp_resource' ? input.action.uri :
      input.action.toolName,
    timeoutMs: MCP_TOOL_TIMEOUT_MS,
    schemaGuard: input.schemaGuard
  };
  if (input.action.type === 'call_mcp_tool' && input.action.exposedToolName) metadata.exposedName = input.action.exposedToolName;
  if (input.action.type === 'call_mcp_tool' && input.action.mcpPolicySummary) metadata.policySummary = input.action.mcpPolicySummary;
  if (typeof input.argsSize === 'number') metadata.argsSize = input.argsSize;
  if (typeof input.contentPartCount === 'number') metadata.contentPartCount = input.contentPartCount;
  if (input.failureKind) metadata.failureKind = input.failureKind;
  return metadata;
}

function createFailedMcpMetadata(action: WorkspaceToolAction, errorMessage: string): WorkspaceToolActionResult['mcp'] | undefined {
  if (
    action.type !== 'list_mcp_tools' &&
    action.type !== 'list_mcp_resources' &&
    action.type !== 'read_mcp_resource' &&
    action.type !== 'call_mcp_tool'
  ) {
    return undefined;
  }
  const failureKind =
    /没有找到/.test(errorMessage) ? 'missing_plugin' :
    /uri/.test(errorMessage) ? 'invalid_uri' :
    /toolName/.test(errorMessage) ? 'invalid_tool_name' :
    /args/.test(errorMessage) ? 'args_too_large' :
    /timeout|aborted|超时/i.test(errorMessage) ? 'timeout' :
    'unknown';
  return createMcpMetadata({
    action,
    schemaGuard: 'failed',
    failureKind
  });
}

function summarizeMcpTools(plugin: McpPlugin, tools: UnityMcpTool[]): string {
  if (tools.length === 0) {
    return `${plugin.name} 没有暴露 MCP tools。`;
  }

  return [
    `${plugin.name} 暴露 ${tools.length} 个 MCP tools：`,
    ...tools.slice(0, 60).map((tool) => {
      const schema = tool.inputSchema ? `\n  inputSchema: ${JSON.stringify(tool.inputSchema).slice(0, 1200)}` : '';
      return `- ${tool.name}${tool.description ? `：${tool.description}` : ''}${schema}`;
    }),
    tools.length > 60 ? `...其余 ${tools.length - 60} 个已省略。` : ''
  ].filter(Boolean).join('\n');
}

function summarizeMcpResources(plugin: McpPlugin, resources: UnityMcpResource[]): string {
  if (resources.length === 0) {
    return `${plugin.name} 没有暴露 MCP resources。`;
  }

  return [
    `${plugin.name} 暴露 ${resources.length} 个 MCP resources：`,
    ...resources.slice(0, 80).map((resource) =>
      `- ${resource.uri}${resource.name ? ` (${resource.name})` : ''}${resource.description ? `：${resource.description}` : ''}`
    ),
    resources.length > 80 ? `...其余 ${resources.length - 80} 个已省略。` : ''
  ].filter(Boolean).join('\n');
}

export function isWriteLikeToolAction(action: WorkspaceToolAction): boolean {
  if (
    action.type === 'write_file' ||
    action.type === 'create_directory' ||
    action.type === 'edit_file' ||
    action.type === 'multi_edit' ||
    action.type === 'patch_file' ||
    action.type === 'run_command' ||
    action.type === 'terminal_start' ||
    action.type === 'terminal_write' ||
    action.type === 'terminal_stop' ||
    action.type === 'browser_open' ||
    action.type === 'browser_navigate' ||
    action.type === 'browser_click' ||
    action.type === 'browser_type' ||
    action.type === 'browser_close' ||
    action.type === 'open_engine_hub' ||
    action.type === 'open_engine_project' ||
    action.type === 'install_engine_bridge' ||
    action.type === 'run_engine_environment_action' ||
    action.type === 'checkpoint_rollback' ||
    action.type === 'funplay_memory_remember' ||
    action.type === 'funplay_schedule_task' ||
    action.type === 'funplay_cancel_task' ||
    action.type === 'media_save_base64' ||
    action.type === 'image_generate' ||
    action.type === 'generate_asset' ||
    action.type === 'import_generated_asset'
  ) {
    return true;
  }

  if (action.type !== 'call_mcp_tool') {
    return false;
  }

  return !inferMcpToolReadOnly(action.toolName);
}

export async function executeAgentToolAction(
  project: Project,
  action: WorkspaceToolAction,
  options: AgentToolExecutionOptions = {}
): Promise<WorkspaceToolActionResult> {
  if (action.type === 'update_todo_list') {
    return {
      ok: true,
      summary: formatTodoListSummary(action)
    };
  }

  if (
    action.type === 'ask_user' ||
    action.type === 'run_subagent' ||
    action.type === 'run_subagents' ||
    action.type === 'subagent_start' ||
    action.type === 'subagent_status'
  ) {
    return {
      ok: false,
      isError: true,
      summary: `${action.type} 只能在 Native 真实 tool-calling 主链中执行。`
    };
  }

  try {
    if (action.type === 'web_search') {
      return await performWebSearch(action, options);
    }

    if (action.type === 'web_fetch') {
      return await performWebFetch(action, options);
    }

    if (action.type === 'funplay_notify') {
      const notification = await sendAppNotification({
        title: action.title,
        body: action.body,
        priority: action.priority,
        source: 'funplay-native-tool'
      });
      return {
        ok: true,
        summary: `Notification sent: "${notification.title}"`
      };
    }

    if (action.type === 'funplay_schedule_task') {
      const task = await scheduleNotificationTask({
        name: action.name,
        prompt: action.prompt,
        scheduleType: action.scheduleType,
        scheduleValue: action.scheduleValue,
        priority: action.priority,
        notifyOnComplete: action.notifyOnComplete,
        durable: action.durable
      });
      return {
        ok: true,
        summary: `Task "${task.name}" scheduled. ID: ${task.id}, next run: ${task.nextRun}`
      };
    }

    if (action.type === 'funplay_list_tasks') {
      const status = action.status ?? 'all';
      const tasks = listNotificationTasks().filter((task) => status === 'all' || task.status === status);
      return {
        ok: true,
        summary: tasks.length
          ? tasks.map((task, index) =>
              `${index + 1}. [${task.id}] ${task.name}\nType: ${task.scheduleType} (${task.scheduleValue})\nStatus: ${task.status} | Next: ${task.nextRun ?? '-'} | Durable: ${task.durable ? 'yes' : 'no'}`
            ).join('\n\n')
          : 'No scheduled tasks found.'
      };
    }

    if (action.type === 'funplay_cancel_task') {
      await cancelNotificationTask(action.taskId);
      return {
        ok: true,
        summary: `Task ${action.taskId} cancelled.`
      };
    }

    if (action.type === 'list_asset_generation_capabilities') {
      const state = createAssetGenerationState(options, project);
      return {
        ok: true,
        summary: summarizeAssetGenerationProviders(state, action.kind)
      };
    }

    if (action.type === 'generate_asset') {
      if (!options.appState || !options.persistAppState) {
        return {
          ok: false,
          isError: true,
          summary: 'generate_asset 需要主运行时 appState，不能在 detached 工具上下文中执行。'
        };
      }
      const outputSpec = {
        width: action.width,
        height: action.height,
        durationSeconds: action.durationSeconds,
        transparentBackground: action.transparentBackground
      };
      const updated = await generateAssetForProject(options.appState, project.id, {
        title: action.title,
        kind: action.kind,
        prompt: action.prompt,
        negativePrompt: action.negativePrompt,
        providerId: action.providerId,
        outputSpec,
        count: action.count,
        createdBy: 'agent',
        targetEngine: project.engine?.platform
      }, {
        onProjectUpdate: () => persistAssetGenerationState(options)
      });
      await persistAssetGenerationState(options);
      const job = [...(updated.assetGenerationJobs ?? [])]
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      const outputs = job?.outputs ?? [];
      return {
        ok: job?.status === 'completed',
        isError: job?.status !== 'completed',
        summary: [
          `Asset generation: ${job?.status ?? 'unknown'}`,
          `Job id: ${job?.id ?? '(unknown)'}`,
          `Kind: ${action.kind}`,
          `Provider: ${job?.providerName ?? action.providerId ?? 'default'}`,
          outputs.length ? 'Outputs:' : 'No outputs.',
          ...outputs.map((output) => `- ${output.path} (${output.format}, ${output.size} bytes)`)
        ].join('\n'),
        changedFiles: outputs.map((output) => ({
          path: output.path,
          operation: 'created' as const,
          size: output.size
        }))
      };
    }

    if (action.type === 'import_generated_asset') {
      if (!options.appState || !options.persistAppState) {
        return {
          ok: false,
          isError: true,
          summary: 'import_generated_asset 需要主运行时 appState，不能在 detached 工具上下文中执行。'
        };
      }
      const updated = importGeneratedAsset(options.appState, project.id, action.jobId);
      await persistAssetGenerationState(options);
      const job = (updated.assetGenerationJobs ?? []).find((candidate) => candidate.id === action.jobId);
      return {
        ok: Boolean(job),
        isError: !job,
        summary: job
          ? [
              `Imported generated asset job: ${job.id}`,
              `Status: ${job.status}`,
              ...job.outputs.map((output) => `- ${output.path}${output.importedAt ? ` importedAt=${output.importedAt}` : ''}`)
            ].join('\n')
          : `Asset generation job not found: ${action.jobId}`,
        changedFiles: job?.outputs.map((output) => ({
          path: output.path,
          operation: 'modified' as const,
          size: output.size
        }))
      };
    }

    if (
      action.type === 'diagnose_engine_status' ||
      action.type === 'refresh_engine_runtime_state' ||
      action.type === 'open_engine_hub' ||
      action.type === 'open_engine_project' ||
      action.type === 'install_engine_bridge' ||
      action.type === 'run_engine_environment_action'
    ) {
      return await executeEngineControlAction(project, action, options);
    }

    if (action.type === 'list_agent_skills') {
      const registry = buildAgentSkillRegistry({
        projectPath: project.engine?.projectPath
      });
      const query = action.query?.trim().toLowerCase();
      const skills = registry.index.filter((skill) =>
        !query ||
        skill.name.toLowerCase().includes(query) ||
        skill.description?.toLowerCase().includes(query)
      );
      return {
        ok: true,
        summary: skills.length
          ? skills.map((skill, index) =>
              [
                `${index + 1}. ${skill.name} [${skill.source}]`,
                skill.description ? `Description: ${skill.description}` : '',
                `Invocable: user=${skill.userInvocable ? 'yes' : 'no'} model=${skill.modelInvocable ? 'yes' : 'no'}`,
                `Trust: ${skill.trustLevel}; verification=${skill.verificationStatus}; permission=${skill.permissionPolicy}`,
                skill.declaredScripts?.length ? `Declared scripts: ${skill.declaredScripts.length}; scriptPolicy=${skill.scriptPolicy}` : '',
                skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(', ')}` : '',
                `Skill id: ${skill.id}`
              ].filter(Boolean).join('\n')
            ).join('\n\n')
          : 'No Agent Skills found.'
      };
    }

    if (action.type === 'read_agent_skill') {
      const skill = findAgentSkillPackage({
        projectPath: project.engine?.projectPath,
        skillId: action.skillId,
        skillName: action.skillName
      });
      if (!skill) {
        return {
          ok: false,
          isError: true,
          summary: 'Agent Skill not found. Run list_agent_skills first and pass a returned skillId or exact skillName.'
        };
      }
      return {
        ok: true,
        summary: [
          `Skill: ${skill.name}`,
          skill.description ? `Description: ${skill.description}` : '',
          `Source: ${skill.source}`,
          `Path: ${skill.sourcePath}`,
          `Trust: ${skill.trustLevel}; verification=${skill.verificationStatus}; sha256=${skill.contentSha256}`,
          `Permission policy: ${skill.permissionPolicy}`,
          `Script policy: ${skill.scriptPolicy}`,
          skill.declaredScripts?.length
            ? ['Declared scripts:', ...skill.declaredScripts.map((script) => `- ${script.name} [${script.risk}]: ${script.command}`)].join('\n')
            : '',
          skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(', ')}` : '',
          skill.dependencies?.length ? `Dependencies: ${skill.dependencies.join(', ')}` : '',
          '',
          truncate(skill.instruction, MAX_SKILL_INSTRUCTION_CHARS)
        ].filter(Boolean).join('\n')
      };
    }

    if (action.type === 'list_agent_skill_files') {
      const files = listAgentSkillSupportingFiles({
        projectPath: project.engine?.projectPath,
        skillId: action.skillId,
        skillName: action.skillName
      });
      return {
        ok: true,
        summary: files.length
          ? files.map((file) => `- ${file.path} (${file.size} bytes)`).join('\n')
          : 'No supporting files found for this Agent Skill.'
      };
    }

    if (action.type === 'read_agent_skill_file') {
      const result = readAgentSkillSupportingFile({
        projectPath: project.engine?.projectPath,
        skillId: action.skillId,
        skillName: action.skillName,
        filePath: action.filePath
      });
      if (!result) {
        return {
          ok: false,
          isError: true,
          summary: 'Agent Skill supporting file not found. Run list_agent_skill_files first and pass a returned path.'
        };
      }
      return {
        ok: true,
        summary: [
          `Skill: ${result.skill.name}`,
          `File: ${result.file.path} (${result.file.size} bytes)${result.truncated ? ' [truncated]' : ''}`,
          '',
          result.content
        ].join('\n')
      };
    }
  } catch (error) {
    return {
      ok: false,
      isError: true,
      summary: error instanceof Error ? error.message : '工具执行失败。'
    };
  }

  if (!project.engine?.projectPath) {
    return {
      ok: false,
      isError: true,
      summary: '当前项目还没有真实项目路径，无法执行工作区工具。'
    };
  }

  try {
    if (action.type === 'scan_file_tree') {
      const files = await listProjectFilesForProject(project);
      return {
        ok: true,
        summary: files
          .slice(0, MAX_TREE_ITEMS)
          .map((file) => `- ${file.type === 'directory' ? `${file.path}/` : file.path}`)
          .join('\n') || '当前项目目录为空。'
      };
    }

    if (action.type === 'read_file') {
      if (action.pages?.trim() || isDocumentLikePath(action.path)) {
        return await performReadDocument(project, {
          type: 'read_document',
          path: action.path,
          pages: action.pages,
          maxChars: typeof action.limit === 'number' ? Math.min(action.limit * 120, MAX_DOCUMENT_CHARS) : undefined
        });
      }
      const file = await readProjectFileForProject(project, action.path);
      return {
        ok: true,
        summary: formatReadFileSummary(file, {
          offset: action.offset,
          limit: action.limit
        })
      };
    }

    if (action.type === 'read_document') {
      return await performReadDocument(project, action);
    }

    if (action.type === 'media_attach_file') {
      return await performMediaAttach(project, action);
    }

    if (action.type === 'media_save_base64') {
      return await performMediaSaveBase64(project, action);
    }

    if (action.type === 'image_generate') {
      return await performImageGenerate(project, action);
    }

    if (action.type === 'find_files') {
      const files = await listProjectFilesForProject(project);
      const matches = _findProjectFiles(files, action);
      return {
        ok: true,
        summary: _formatFileMatches(matches, action.pattern)
      };
    }

    if (action.type === 'search_project_content') {
      const files = await listProjectFilesForProject(project);
      return await _performAdvancedProjectSearch(project, files, action);
    }

    if (action.type === 'preview_file_diff') {
      const result = await previewProjectTextDiffForProject(project, action.path, action.content);
      return {
        ok: true,
        summary: [
          `Diff preview for ${result.path}`,
          `Size after edit: ${result.size} bytes`,
          `Approx lines: +${result.addedLines} -${result.removedLines}`,
          '',
          result.diffPreview
        ].join('\n')
      };
    }

    if (action.type === 'preview_patch') {
      const result = await previewProjectTextPatchForProject(project, action.path, action.patch);
      return {
        ok: true,
        summary: [
          `Patch preflight OK for ${result.path}`,
          `Hunks: ${result.hunkCount} | Lines: +${result.addedLines} -${result.removedLines} | Size after patch: ${result.size} bytes`,
          '',
          result.diffPreview
        ].join('\n'),
        edit: createEditMetrics({
          strategy: 'unified_patch',
          patchFirst: true,
          preflight: 'passed',
          hunkCount: result.hunkCount,
          addedLines: result.addedLines,
          removedLines: result.removedLines
        })
      };
    }

    if (action.type === 'funplay_memory_search') {
      return await performMemorySearch(project, action);
    }

    if (action.type === 'funplay_memory_get') {
      return await performMemoryGet(project, action);
    }

    if (action.type === 'funplay_memory_recent') {
      return await performMemoryRecent(project);
    }

    if (action.type === 'funplay_memory_remember') {
      return await performMemoryRemember(project, action);
    }

    if (action.type === 'summarize_directory') {
      const files = await listProjectFilesForProject(project);
      return {
        ok: true,
        summary: buildDirectorySummary(action.path.replace(/\/$/, ''), files)
      };
    }

    if (action.type === 'inspect_game_project') {
      const files = await listProjectFilesForProject(project);
      return await inspectGameProject(project, files);
    }

    if (action.type === 'create_directory') {
      return await createWorkspaceDirectory(project, action.path);
    }

    if (action.type === 'list_mcp_tools') {
      const plugin = resolvePluginForAction(options.plugins ?? [], action);
      if (!plugin) {
        throw new Error('没有找到可用的 MCP 插件。');
      }

      const tools = await listUnityTools(plugin, createMcpAbortSignal(options.abortSignal));
      return {
        ok: true,
        summary: summarizeMcpTools(plugin, tools),
        mcp: createMcpMetadata({
          action,
          plugin,
          contentPartCount: tools.length,
          schemaGuard: 'passed'
        })
      };
    }

    if (action.type === 'list_mcp_resources') {
      const plugin = resolvePluginForAction(options.plugins ?? [], action);
      if (!plugin) {
        throw new Error('没有找到可用的 MCP 插件。');
      }

      const resources = await listUnityResources(plugin, createMcpAbortSignal(options.abortSignal));
      return {
        ok: true,
        summary: summarizeMcpResources(plugin, resources),
        mcp: createMcpMetadata({
          action,
          plugin,
          contentPartCount: resources.length,
          schemaGuard: 'passed'
        })
      };
    }

    if (action.type === 'read_mcp_resource') {
      validateMcpResourceUri(action.uri);
      const plugin = resolvePluginForAction(options.plugins ?? [], action);
      if (!plugin) {
        throw new Error('没有找到可用的 MCP 插件。');
      }

      const result = await readUnityResource(plugin, action.uri, createMcpAbortSignal(options.abortSignal));
      return {
        ok: true,
        summary: [`${plugin.name} / ${action.uri}`, summarizeMcpResult(result)].join('\n'),
        mcp: createMcpMetadata({
          action,
          plugin,
          contentPartCount: result.content.length,
          schemaGuard: 'passed'
        })
      };
    }

    if (action.type === 'call_mcp_tool') {
      validateMcpToolName(action.toolName);
      const argsSize = serializeMcpArgs(action.args ?? {}).length;
      const plugin = resolvePluginForAction(options.plugins ?? [], action);
      if (!plugin) {
        throw new Error('没有找到可用的 MCP 插件。');
      }
      const policy = resolveMcpToolPolicy(plugin, action.toolName);
      if (policy.permission === 'deny') {
        return {
          ok: false,
          isError: true,
          summary: `${plugin.name} / ${action.toolName} 已被 MCP policy 拒绝。`,
          mcp: createMcpMetadata({
            action,
            plugin,
            argsSize,
            schemaGuard: 'failed',
            failureKind: 'permission_denied'
          })
        };
      }

      const result = await executeUnityTool(
        plugin,
        action.toolName,
        action.args ?? {},
        createMcpAbortSignal(options.abortSignal),
        createMcpElicitationHandler(options)
      );
      return {
        ok: true,
        summary: [`${plugin.name} / ${action.toolName}`, summarizeMcpResult(result)].join('\n'),
        mcp: createMcpMetadata({
          action,
          plugin,
          argsSize,
          contentPartCount: result.content.length,
          schemaGuard: 'passed'
        })
      };
    }

    if (action.type === 'run_command') {
      return await runWorkspaceCommand(project, action, options);
    }

    if (action.type === 'terminal_start') {
      const started = startPersistentTerminal(project, {
        name: action.name,
        command: action.command,
        cwd: action.cwd
      });
      return {
        ok: true,
        summary: started.summary,
        terminal: {
          ...started.terminal,
          command: action.command ?? started.terminal.command
        },
        artifacts: [{
          type: 'terminal',
          title: action.name ?? action.command ?? started.sessionId
        }]
      };
    }

    if (action.type === 'terminal_read') {
      const summary = readPersistentTerminal({
        sessionId: action.sessionId,
        sinceSeq: action.sinceSeq,
        maxChars: action.maxChars
      });
      const liveTerminal = readPersistentTerminalMetadata(action.sessionId);
      const terminal = {
        ...parseTerminalReadSummary(summary, action.sessionId),
        ...liveTerminal
      };
      const outputWasTruncated = /^output=tail\(/m.test(summary);
      const terminalOutputArtifact = outputWasTruncated || (terminal.totalOutputChars ?? 0) > MAX_COMMAND_OUTPUT_CHARS
        ? await writeTerminalOutputArtifact({
            project,
            sessionId: action.sessionId,
            title: terminal.command ?? terminal.name ?? action.sessionId
          })
        : undefined;
      return {
        ok: true,
        summary,
        terminal,
        artifacts: terminalOutputArtifact ? [terminalOutputArtifact] : undefined
      };
    }

    if (action.type === 'terminal_write') {
      return {
        ok: true,
        summary: writePersistentTerminal({
          sessionId: action.sessionId,
          input: action.input,
          appendNewline: action.appendNewline
        }),
        terminal: {
          ...readPersistentTerminalMetadata(action.sessionId),
          status: 'running'
        }
      };
    }

    if (action.type === 'terminal_list') {
      return {
        ok: true,
        summary: listPersistentTerminals(project)
      };
    }

    if (action.type === 'terminal_stop') {
      return {
        ok: true,
        summary: stopPersistentTerminal({
          sessionId: action.sessionId,
          signal: action.signal
        }),
        terminal: readPersistentTerminalMetadata(action.sessionId)
      };
    }

    if (action.type === 'browser_open') {
      const summary = await openBrowserPage(project, {
        url: action.url,
        width: action.width,
        height: action.height
      });
      return {
        ok: true,
        summary,
        browser: parseBrowserSummary(summary)
      };
    }

    if (action.type === 'browser_snapshot') {
      return {
        ok: true,
        summary: await readBrowserSnapshot({
          sessionId: action.sessionId,
          maxTextChars: action.maxTextChars
        }),
        browser: {
          sessionId: action.sessionId
        }
      };
    }

    if (action.type === 'browser_navigate') {
      const summary = await navigateBrowserPage(project, {
        sessionId: action.sessionId,
        url: action.url
      });
      return {
        ok: true,
        summary,
        browser: {
          ...parseBrowserSummary(summary),
          sessionId: action.sessionId
        }
      };
    }

    if (action.type === 'browser_screenshot') {
      const summary = await captureBrowserScreenshot({
        sessionId: action.sessionId,
        fullPage: action.fullPage
      });
      const structured = parseBrowserScreenshotSummary(summary);
      return {
        ok: true,
        summary,
        browser: {
          sessionId: action.sessionId,
          ...structured.browser
        },
        artifacts: structured.artifacts
      };
    }

    if (action.type === 'browser_click') {
      return {
        ok: true,
        summary: await clickBrowserPage({
          sessionId: action.sessionId,
          selector: action.selector,
          text: action.text
        }),
        browser: {
          sessionId: action.sessionId
        }
      };
    }

    if (action.type === 'browser_type') {
      return {
        ok: true,
        summary: await typeBrowserPage({
          sessionId: action.sessionId,
          selector: action.selector,
          text: action.text,
          clear: action.clear
        }),
        browser: {
          sessionId: action.sessionId
        }
      };
    }

    if (action.type === 'browser_console') {
      const summary = readBrowserConsole(action.sessionId);
      return {
        ok: true,
        summary,
        browser: {
          sessionId: action.sessionId,
          consoleMessageCount: summary === 'No browser console messages.' ? 0 : summary.split('\n').filter(Boolean).length
        }
      };
    }

    if (action.type === 'browser_list') {
      return {
        ok: true,
        summary: listBrowserPages(project)
      };
    }

    if (action.type === 'browser_close') {
      return {
        ok: true,
        summary: closeBrowserPage(action.sessionId),
        browser: {
          sessionId: action.sessionId
        }
      };
    }

    if (action.type === 'checkpoint_diff') {
      if (!options.checkpointSnapshotId) {
        throw new Error('当前运行没有可用的文件 checkpoint。');
      }
      const result = await previewFileCheckpointChanges(project, options.checkpointSnapshotId);
      return {
        ok: true,
        summary: result.changedFiles.length > 0
          ? [
              `Checkpoint: ${result.snapshotId}`,
              `Changed files: ${result.changedFiles.length}`,
              result.skippedFiles.length ? `Skipped files: ${result.skippedFiles.join(', ')}` : '',
              '',
              ...result.changedFiles.map((file, index) =>
                [
                  `## ${index + 1}. ${file.path} (${file.status})`,
                  file.diffPreview
                ].join('\n')
              )
            ].filter((line) => line !== '').join('\n')
          : `Checkpoint: ${result.snapshotId}\nNo file changes recorded.`
      };
    }

    if (action.type === 'checkpoint_rollback') {
      if (!options.checkpointSnapshotId) {
        throw new Error('当前运行没有可用的文件 checkpoint。');
      }
      const result = await restoreFileCheckpoint(project, options.checkpointSnapshotId);
      return {
        ok: true,
        summary: [
          `Restored checkpoint: ${options.checkpointSnapshotId}`,
          `Restored files: ${result.restoredFiles.length ? result.restoredFiles.join(', ') : 'none'}`,
          result.skippedFiles.length ? `Skipped files: ${result.skippedFiles.join(', ')}` : ''
        ].filter((line) => line !== '').join('\n'),
        changedFiles: result.restoredFiles.map((path) => ({
          path,
          operation: 'restored'
        })),
        edit: createEditMetrics({
          strategy: 'checkpoint_rollback',
          patchFirst: false,
          preflight: 'not_applicable',
          changedFileCount: result.restoredFiles.length
        })
      };
    }

    if (action.type === 'edit_file') {
      await recordFileCheckpoint({
        snapshotId: options.checkpointSnapshotId,
        project,
        filePath: action.path
      });
      const result = await replaceProjectTextInFileForProject(
        project,
        action.path,
        action.oldText,
        action.newText,
        {
          replaceAll: action.replaceAll
        }
      );
      return {
        ok: true,
        summary: `已编辑 ${result.path}，替换 ${result.replacementCount} 处 (${result.size} bytes)`,
        changedFiles: [{
          path: result.path,
          operation: 'modified',
          size: result.size,
          replacementCount: result.replacementCount
        }],
        edit: createEditMetrics({
          strategy: 'search_replace',
          patchFirst: false,
          preflight: 'passed',
          changedFileCount: 1,
          replacementCount: result.replacementCount
        })
      };
    }

    if (action.type === 'multi_edit') {
      await recordFileCheckpoint({
        snapshotId: options.checkpointSnapshotId,
        project,
        filePath: action.path
      });
      const result = await replaceMultipleProjectTextInFileForProject(project, action.path, action.edits);
      return {
        ok: true,
        summary: [
          `已批量编辑 ${result.path}，${result.edits.length} 个编辑操作全部预检通过。`,
          `总替换 ${result.replacementCount} 处 (${result.size} bytes)。`,
          ...result.edits.map((edit) => `- edit ${edit.index + 1}: 替换 ${edit.replacementCount} 处`)
        ].join('\n'),
        changedFiles: [{
          path: result.path,
          operation: 'modified',
          size: result.size,
          replacementCount: result.replacementCount
        }],
        edit: createEditMetrics({
          strategy: 'multi_edit',
          patchFirst: false,
          preflight: 'passed',
          changedFileCount: 1,
          replacementCount: result.replacementCount,
          editCount: result.edits.length
        })
      };
    }

    if (action.type === 'patch_file') {
      await recordFileCheckpoint({
        snapshotId: options.checkpointSnapshotId,
        project,
        filePath: action.path
      });
      const result = await applyProjectTextPatchForProject(project, action.path, action.patch);
      return {
        ok: true,
        summary: [
          `已应用 patch 到 ${result.path}。`,
          `Hunks: ${result.hunkCount} | Lines: +${result.addedLines} -${result.removedLines} | Size: ${result.size} bytes`,
          '',
          result.diffPreview
        ].join('\n'),
        changedFiles: [{
          path: result.path,
          operation: 'patched',
          size: result.size,
          hunkCount: result.hunkCount,
          addedLines: result.addedLines,
          removedLines: result.removedLines
        }],
        edit: createEditMetrics({
          strategy: 'unified_patch',
          patchFirst: true,
          preflight: 'passed',
          changedFileCount: 1,
          hunkCount: result.hunkCount,
          addedLines: result.addedLines,
          removedLines: result.removedLines
        })
      };
    }

    const [result] = await _applyWorkspaceWriteOperations(project, [action], {
      checkpointSnapshotId: options.checkpointSnapshotId
    });
    const writeErrorMessage = result?.error ?? 'unknown error';
    return {
      ok: Boolean(result?.success),
      isError: !result?.success,
      summary: result?.success
        ? `已写入 ${result.path} (${result.size} bytes)`
        : `写入失败 ${action.path}: ${writeErrorMessage}`,
      changedFiles: result
        ? [{
            path: result.path,
            operation: result.success ? 'created' : 'failed',
            size: result.size,
            error: result.error
          }]
        : undefined,
      edit: result?.success
        ? createEditMetrics({
            strategy: 'write_file',
            patchFirst: false,
            preflight: 'passed',
            changedFileCount: 1
          })
        : createEditMetrics({
            strategy: 'write_file',
            patchFirst: false,
            preflight: 'failed',
            changedFileCount: 0,
            failureKind: classifyEditFailure(action, writeErrorMessage),
            recoveryHint: '确认路径在项目目录内，必要时先创建父目录。'
          })
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : '工作区工具执行失败。';
    return {
      ok: false,
      isError: true,
      summary,
      edit: createFailedEditMetrics(action, summary),
      mcp: createFailedMcpMetadata(action, summary)
    };
  }
}

export async function executeWorkspaceToolAction(project: Project, action: WorkspaceToolAction): Promise<WorkspaceToolActionResult> {
  return executeAgentToolAction(project, action);
}
