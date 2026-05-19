import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, basename, dirname } from 'node:path';
import type { AppState, Project, ProjectDocumentPreview, ProjectDocumentPreviewPage, ProjectFileContent, ProjectFileEntry } from '../../shared/types';
import { renderPdfPreviewThumbnail } from './pdf-preview-renderer';
import { renderPptxPreviewThumbnails } from './pptx-preview-renderer';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.vscode',
  'Library',
  'Logs',
  'Obj',
  'Temp',
  'MemoryCaptures',
  'Build',
  'Builds'
]);

const MAX_FILE_ENTRIES = 1200;
const MAX_TEXT_BYTES = 200_000;
const MAX_WRITE_TEXT_BYTES = 500_000;
const MAX_BINARY_PREVIEW_BYTES = 12 * 1024 * 1024;
const MAX_DOCUMENT_PREVIEW_PAGES = 30;
const MAX_DOCUMENT_PREVIEW_CHARS = 80_000;
const MAX_DOCUMENT_PREVIEW_PAGE_CHARS = 3_000;
const MAX_ZIP_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.tga',
  '.psd',
  '.wav',
  '.mp3',
  '.ogg',
  '.aiff',
  '.fbx',
  '.blend',
  '.glb',
  '.gltf',
  '.mp4',
  '.mov',
  '.webm',
  '.avi',
  '.unitypackage',
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.ttf',
  '.otf',
  '.dll'
]);

const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.aiff', 'audio/aiff'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.fbx', 'application/octet-stream'],
  ['.prefab', 'text/plain'],
  ['.mat', 'text/plain'],
  ['.asset', 'text/plain'],
  ['.controller', 'text/plain']
]);

function resolveProjectRoot(project: Project): string {
  if (!project.engine?.projectPath) {
    throw new Error('当前项目还没有记录真实项目路径。');
  }
  return resolve(project.engine.projectPath.replace(/^~/, process.env.HOME ?? '~'));
}

export function resolveProjectRootPathForProject(project: Project): string {
  return resolveProjectRoot(project);
}

export function resolveProjectFileAbsolutePath(state: AppState, projectId: string, filePath: string): string {
  const project = getProjectOrThrow(state, projectId);
  const { resolvedFilePath } = resolveProjectFilePath(project, filePath);
  return resolvedFilePath;
}

function getProjectOrThrow(state: AppState, projectId: string): Project {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error('Project not found.');
  }
  return project;
}

function resolveProjectFilePath(project: Project, filePath: string): {
  rootPath: string;
  resolvedFilePath: string;
  relativePath: string;
} {
  const rootPath = resolveProjectRoot(project);
  const normalizedInput = filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalizedInput || normalizedInput === '.' || normalizedInput.endsWith('/')) {
    throw new Error('非法文件路径。');
  }

  const resolvedFilePath = resolve(rootPath, normalizedInput);
  if (resolvedFilePath !== rootPath && !resolvedFilePath.startsWith(`${rootPath}/`)) {
    throw new Error('非法文件路径。');
  }

  if (resolvedFilePath === rootPath) {
    throw new Error('目标不是一个文件。');
  }

  return {
    rootPath,
    resolvedFilePath,
    relativePath: toPosixRelativePath(rootPath, resolvedFilePath)
  };
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split('\\').join('/');
}

function looksBinaryByExtension(path: string): boolean {
  const lowerPath = path.toLowerCase();
  for (const extension of BINARY_EXTENSIONS) {
    if (lowerPath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

function getFileExtensionWithDot(path: string): string {
  const matched = path.toLowerCase().match(/(\.[a-z0-9]+)$/i);
  return matched?.[1] ?? '';
}

export function getProjectFileMimeType(path: string): string {
  return MIME_TYPES_BY_EXTENSION.get(getFileExtensionWithDot(path)) ?? 'application/octet-stream';
}

function canInlinePreviewBinary(path: string, size: number): boolean {
  const mimeType = getProjectFileMimeType(path);
  return size <= MAX_BINARY_PREVIEW_BYTES && (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType === 'application/pdf' ||
    mimeType === 'model/gltf-binary' ||
    mimeType === 'model/gltf+json'
  );
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripSlideXmlToText(value: string): string {
  const textRuns = [...value.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXmlEntities(match[1].replace(/\s+/g, ' ').trim()))
    .filter(Boolean);
  return textRuns.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeDocumentText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripDocxXmlToText(value: string): string {
  const expanded = value
    .replace(/<w:tab\s*\/>/gi, '\t')
    .replace(/<w:br\s*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeDocumentText(decodeXmlEntities(expanded));
}

function extractDocxParagraphs(value: string): string[] {
  const paragraphs = [...value.matchAll(/<w:p[\s\S]*?<\/w:p>/gi)]
    .map((match) => stripDocxXmlToText(match[0]))
    .filter(Boolean);
  if (paragraphs.length > 0) {
    return paragraphs;
  }
  const fallbackText = stripDocxXmlToText(value);
  return fallbackText ? fallbackText.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function chunkDocxParagraphs(paragraphs: string[]): ProjectDocumentPreviewPage[] {
  const pages: ProjectDocumentPreviewPage[] = [];
  let currentLines: string[] = [];
  let currentLength = 0;

  function flushPage(): void {
    if (currentLines.length === 0 || pages.length >= MAX_DOCUMENT_PREVIEW_PAGES) {
      return;
    }
    const text = currentLines.join('\n\n');
    const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean);
    pages.push({
      index: pages.length + 1,
      title: firstLine && firstLine.length <= 100 ? firstLine : undefined,
      text
    });
    currentLines = [];
    currentLength = 0;
  }

  for (const paragraph of paragraphs) {
    const nextLength = currentLength + paragraph.length + (currentLines.length ? 2 : 0);
    if (currentLines.length > 0 && nextLength > MAX_DOCUMENT_PREVIEW_PAGE_CHARS) {
      flushPage();
    }
    if (pages.length >= MAX_DOCUMENT_PREVIEW_PAGES) {
      break;
    }
    currentLines.push(paragraph);
    currentLength += paragraph.length + (currentLines.length > 1 ? 2 : 0);
  }
  flushPage();

  return pages;
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

async function createPptxDocumentPreview(
  absolutePath: string,
  fileStat: { mtimeMs: number; size: number }
): Promise<ProjectDocumentPreview | undefined> {
  const entries = await listZipEntries(absolutePath);
  const slideEntries = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort((left, right) => Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0) - Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0));

  if (slideEntries.length === 0) {
    return undefined;
  }

  const visibleEntries = slideEntries.slice(0, MAX_DOCUMENT_PREVIEW_PAGES);
  const thumbnailResult = await renderPptxPreviewThumbnails({
    absolutePath,
    fileStat,
    slideEntries: visibleEntries,
    hasContentTypes: entries.includes('[Content_Types].xml')
  });
  const pages: ProjectDocumentPreviewPage[] = [];
  for (const [index, entry] of visibleEntries.entries()) {
    const xml = await readZipEntryText(absolutePath, entry);
    const text = xml ? stripSlideXmlToText(xml) : '';
    const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean);
    pages.push({
      index: index + 1,
      title: firstLine && firstLine.length <= 100 ? firstLine : undefined,
      text,
      thumbnailDataUrl: thumbnailResult.thumbnails[index]
    });
  }

  const warnings = [
    slideEntries.length > visibleEntries.length
      ? `Only the first ${visibleEntries.length} of ${slideEntries.length} slides are shown.`
      : undefined,
    thumbnailResult.warning
  ].filter(Boolean);

  return {
    kind: 'pptx',
    pageCount: slideEntries.length,
    extraction: thumbnailResult.extraction,
    pages,
    warning: warnings.join(' ') || undefined
  };
}

async function createDocxDocumentPreview(absolutePath: string): Promise<ProjectDocumentPreview | undefined> {
  const entries = await listZipEntries(absolutePath);
  const documentEntry = entries.find((entry) => entry.toLowerCase() === 'word/document.xml');
  if (!documentEntry) {
    return undefined;
  }

  const xml = await readZipEntryText(absolutePath, documentEntry);
  if (!xml) {
    return undefined;
  }

  const paragraphs = extractDocxParagraphs(xml);
  if (paragraphs.length === 0) {
    return undefined;
  }

  let totalChars = 0;
  const visibleParagraphs: string[] = [];
  for (const paragraph of paragraphs) {
    if (totalChars + paragraph.length > MAX_DOCUMENT_PREVIEW_CHARS) {
      break;
    }
    visibleParagraphs.push(paragraph);
    totalChars += paragraph.length;
  }

  const pages = chunkDocxParagraphs(visibleParagraphs);
  if (pages.length === 0) {
    return undefined;
  }

  const warnings = [
    paragraphs.length > visibleParagraphs.length
      ? `Only the first ${visibleParagraphs.length} of ${paragraphs.length} paragraphs are shown.`
      : undefined,
    pages.length >= MAX_DOCUMENT_PREVIEW_PAGES && visibleParagraphs.length < paragraphs.length
      ? `Only the first ${MAX_DOCUMENT_PREVIEW_PAGES} sections are shown.`
      : undefined
  ].filter(Boolean);

  return {
    kind: 'docx',
    pageCount: pages.length,
    extraction: 'docx-xml',
    pages,
    warning: warnings.join(' ') || undefined
  };
}

async function createPdfDocumentPreview(absolutePath: string): Promise<ProjectDocumentPreview | undefined> {
  const thumbnailResult = await renderPdfPreviewThumbnail({ absolutePath });
  if (!thumbnailResult.thumbnailDataUrl) {
    return undefined;
  }

  return {
    kind: 'pdf',
    pageCount: 1,
    extraction: thumbnailResult.extraction,
    pages: [{
      index: 1,
      title: 'Page 1',
      text: '',
      thumbnailDataUrl: thumbnailResult.thumbnailDataUrl
    }],
    warning: thumbnailResult.warning
  };
}

function bufferLooksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function walkProjectFiles(rootPath: string, currentPath: string, entries: ProjectFileEntry[]): Promise<void> {
  if (entries.length >= MAX_FILE_ENTRIES) {
    return;
  }

  const directoryEntries = await readdir(currentPath, { withFileTypes: true });
  directoryEntries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const directoryEntry of directoryEntries) {
    if (entries.length >= MAX_FILE_ENTRIES) {
      return;
    }

    if (directoryEntry.name.startsWith('.DS_Store')) {
      continue;
    }

    const absolutePath = resolve(currentPath, directoryEntry.name);
    const relativePath = toPosixRelativePath(rootPath, absolutePath);

    if (directoryEntry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(directoryEntry.name)) {
        continue;
      }
      if (relativePath === 'Packages/PackageCache' || relativePath.startsWith('Packages/PackageCache/')) {
        continue;
      }
      const directoryStat = await stat(absolutePath);
      entries.push({
        id: relativePath,
        name: basename(relativePath),
        path: relativePath,
        type: 'directory',
        size: 0,
        modifiedAt: directoryStat.mtime.toISOString()
      });
      await walkProjectFiles(rootPath, absolutePath, entries);
      continue;
    }

    if (!directoryEntry.isFile()) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    entries.push({
      id: relativePath,
      name: basename(relativePath),
      path: relativePath,
      type: 'file',
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString()
    });
  }
}

export async function listProjectFiles(state: AppState, projectId: string): Promise<ProjectFileEntry[]> {
  const project = getProjectOrThrow(state, projectId);
  return listProjectFilesForProject(project);
}

export async function listProjectFilesForProject(project: Project): Promise<ProjectFileEntry[]> {
  const rootPath = resolveProjectRoot(project);
  const entries: ProjectFileEntry[] = [];
  await walkProjectFiles(rootPath, rootPath, entries);
  return entries;
}

export async function readProjectFile(state: AppState, projectId: string, filePath: string): Promise<ProjectFileContent> {
  const project = getProjectOrThrow(state, projectId);
  return readProjectFileForProject(project, filePath);
}

export async function writeProjectFile(state: AppState, projectId: string, filePath: string, content: string): Promise<ProjectFileContent> {
  const project = getProjectOrThrow(state, projectId);
  return writeProjectTextFileForProject(project, filePath, content);
}

export async function readProjectFileForProject(project: Project, filePath: string): Promise<ProjectFileContent> {
  const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, filePath);

  const fileStat = await stat(resolvedFilePath);
  if (!fileStat.isFile()) {
    throw new Error('目标不是一个文件。');
  }

  const raw = await readFile(resolvedFilePath);
  const isBinary = looksBinaryByExtension(relativePath) || bufferLooksBinary(raw);

  if (isBinary) {
    const mimeType = getProjectFileMimeType(relativePath);
    const previewDataUrl = canInlinePreviewBinary(relativePath, fileStat.size)
      ? `data:${mimeType};base64,${raw.toString('base64')}`
      : undefined;
    const extension = getFileExtensionWithDot(relativePath);
    const documentPreview = extension === '.pptx'
      ? await createPptxDocumentPreview(resolvedFilePath, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size
      })
      : extension === '.docx'
        ? await createDocxDocumentPreview(resolvedFilePath)
        : extension === '.pdf'
          ? await createPdfDocumentPreview(resolvedFilePath)
          : undefined;
    const documentPageLabel = documentPreview?.kind === 'docx'
      ? 'Section'
      : documentPreview?.kind === 'pdf'
        ? 'Page'
        : 'Slide';

    return {
      id: relativePath,
      name: basename(relativePath),
      path: relativePath,
      size: fileStat.size,
      isBinary: true,
      truncated: false,
      mimeType,
      previewDataUrl,
      documentPreview,
      content: documentPreview?.pages.length
        ? documentPreview.pages.map((page) => [`${documentPageLabel} ${page.index}`, page.text].filter(Boolean).join('\n')).join('\n\n---\n\n')
        : [`[Binary File]`, `path: ${relativePath}`, `size: ${fileStat.size} bytes`, `mime: ${mimeType}`].join('\n')
    };
  }

  const truncated = raw.byteLength > MAX_TEXT_BYTES;
  const text = raw.subarray(0, MAX_TEXT_BYTES).toString('utf8');

  return {
    id: relativePath,
    name: basename(relativePath),
    path: relativePath,
    size: fileStat.size,
    isBinary: false,
    truncated,
    content: truncated ? `${text}\n\n… [Truncated by Funplay]` : text
  };
}

export async function writeProjectTextFileForProject(project: Project, filePath: string, content: string): Promise<ProjectFileContent> {
  const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, filePath);
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`文件内容过大，当前限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }

  if (looksBinaryByExtension(relativePath) && !relativePath.toLowerCase().endsWith('.svg')) {
    throw new Error('当前 Agent 写入工具仅支持文本文件。');
  }

  await mkdir(dirname(resolvedFilePath), { recursive: true });
  await writeFile(resolvedFilePath, content, 'utf8');
  return readProjectFileForProject(project, relativePath);
}

export interface ProjectTextEditOperation {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface ProjectTextMultiEditResult {
  path: string;
  size: number;
  replacementCount: number;
  edits: Array<{
    index: number;
    replacementCount: number;
  }>;
}

export interface ProjectTextPatchPreview {
  path: string;
  size: number;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
  diffPreview: string;
  content: string;
}

interface ParsedPatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{
    kind: 'context' | 'add' | 'remove';
    text: string;
  }>;
}

const MAX_PATCH_HUNKS = 40;
const MAX_DIFF_PREVIEW_CHARS = 20_000;

function countOccurrences(value: string, search: string): number {
  if (!search) {
    return 0;
  }

  let count = 0;
  let position = 0;
  while ((position = value.indexOf(search, position)) !== -1) {
    count += 1;
    position += search.length;
  }
  return count;
}

function buildReplacementNotFoundHint(content: string, oldText: string): string {
  const firstNeedleLine = oldText.split('\n').map((line) => line.trim()).find(Boolean);
  if (!firstNeedleLine) {
    return '';
  }

  const partialMatches = content
    .split('\n')
    .map((line, index) => ({
      line: line.trim(),
      lineNumber: index + 1
    }))
    .filter((item) => item.line.includes(firstNeedleLine))
    .slice(0, 3);

  if (partialMatches.length === 0) {
    return '';
  }

  return [
    '',
    '找到相似行：',
    ...partialMatches.map((item) => `line ${item.lineNumber}: ${item.line.slice(0, 140)}`)
  ].join('\n');
}

function splitTextLines(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (!content) {
    return {
      lines: [],
      trailingNewline: false
    };
  }

  const trailingNewline = content.endsWith('\n');
  return {
    lines: (trailingNewline ? content.slice(0, -1) : content).split('\n'),
    trailingNewline
  };
}

function joinTextLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) {
    return trailingNewline ? '\n' : '';
  }
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function normalizePatchLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseUnifiedPatch(patch: string): ParsedPatchHunk[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const hunks: ParsedPatchHunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) {
      index += 1;
      continue;
    }

    const hunk: ParsedPatchHunk = {
      oldStart: Number(header[1]),
      oldCount: header[2] ? Number(header[2]) : 1,
      newStart: Number(header[3]),
      newCount: header[4] ? Number(header[4]) : 1,
      lines: []
    };
    index += 1;

    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const hunkLine = lines[index];
      if (hunkLine.startsWith('\\ No newline at end of file')) {
        index += 1;
        continue;
      }
      if (hunkLine === '' && index === lines.length - 1) {
        break;
      }

      const marker = hunkLine[0];
      const text = normalizePatchLine(hunkLine.slice(1));
      if (marker === ' ') {
        hunk.lines.push({ kind: 'context', text });
      } else if (marker === '+') {
        hunk.lines.push({ kind: 'add', text });
      } else if (marker === '-') {
        hunk.lines.push({ kind: 'remove', text });
      } else {
        throw new Error(`patch hunk 包含非法行：${hunkLine.slice(0, 120)}`);
      }
      index += 1;
    }

    const oldLineCount = hunk.lines.filter((item) => item.kind !== 'add').length;
    const newLineCount = hunk.lines.filter((item) => item.kind !== 'remove').length;
    if (oldLineCount !== hunk.oldCount || newLineCount !== hunk.newCount) {
      throw new Error(`patch hunk 行数不匹配：期望 -${hunk.oldCount}/+${hunk.newCount}，实际 -${oldLineCount}/+${newLineCount}。`);
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0) {
    throw new Error('patch 中没有找到 unified diff hunk。');
  }
  if (hunks.length > MAX_PATCH_HUNKS) {
    throw new Error(`patch 单次最多支持 ${MAX_PATCH_HUNKS} 个 hunk。`);
  }

  return hunks;
}

function applyUnifiedPatchToContent(content: string, patch: string): {
  content: string;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
} {
  const hunks = parseUnifiedPatch(patch);
  const source = splitTextLines(content);
  const output: string[] = [];
  let cursor = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const hunkStart = hunk.oldStart - 1;
    if (hunkStart < cursor) {
      throw new Error(`patch hunk ${hunkIndex + 1} 与前一个 hunk 重叠。`);
    }
    if (hunkStart > source.lines.length) {
      throw new Error(`patch hunk ${hunkIndex + 1} 起始行超过文件长度。`);
    }

    output.push(...source.lines.slice(cursor, hunkStart));
    let sourceIndex = hunkStart;

    for (const [lineIndex, line] of hunk.lines.entries()) {
      if (line.kind === 'add') {
        output.push(line.text);
        addedLines += 1;
        continue;
      }

      const actual = source.lines[sourceIndex];
      if (actual !== line.text) {
        throw new Error([
          `patch hunk ${hunkIndex + 1} 第 ${lineIndex + 1} 行校验失败。`,
          `文件 line ${sourceIndex + 1}: ${actual ?? '(EOF)'}`,
          `patch: ${line.text}`
        ].join('\n'));
      }

      if (line.kind === 'context') {
        output.push(actual);
      } else {
        removedLines += 1;
      }
      sourceIndex += 1;
    }

    cursor = sourceIndex;
  }

  output.push(...source.lines.slice(cursor));
  return {
    content: joinTextLines(output, source.trailingNewline),
    hunkCount: hunks.length,
    addedLines,
    removedLines
  };
}

export function buildCompactUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return `--- a/${path}\n+++ b/${path}\n(no changes)`;
  }

  const beforeLines = splitTextLines(before).lines;
  const afterLines = splitTextLines(after).lines;
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const context = 3;
  const oldStartIndex = Math.max(0, prefix - context);
  const oldEndIndex = Math.min(beforeLines.length, beforeLines.length - suffix + context);
  const newStartIndex = Math.max(0, prefix - context);
  const newEndIndex = Math.min(afterLines.length, afterLines.length - suffix + context);
  const oldChangedStart = prefix;
  const oldChangedEnd = beforeLines.length - suffix;
  const newChangedStart = prefix;
  const newChangedEnd = afterLines.length - suffix;

  const oldCount = oldEndIndex - oldStartIndex;
  const newCount = newEndIndex - newStartIndex;
  const hunkLines: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStartIndex + 1},${oldCount} +${newStartIndex + 1},${newCount} @@`
  ];

  beforeLines.slice(oldStartIndex, oldChangedStart).forEach((line) => hunkLines.push(` ${line}`));
  beforeLines.slice(oldChangedStart, oldChangedEnd).forEach((line) => hunkLines.push(`-${line}`));
  afterLines.slice(newChangedStart, newChangedEnd).forEach((line) => hunkLines.push(`+${line}`));
  afterLines.slice(newChangedEnd, newEndIndex).forEach((line) => hunkLines.push(` ${line}`));

  const diff = hunkLines.join('\n');
  return diff.length > MAX_DIFF_PREVIEW_CHARS
    ? `${diff.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n\n[Diff preview truncated by Funplay: exceeded ${MAX_DIFF_PREVIEW_CHARS} chars]`
    : diff;
}

async function readEditableTextFile(project: Project, filePath: string): Promise<{
  resolvedFilePath: string;
  relativePath: string;
  content: string;
}> {
  const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, filePath);
  const fileStat = await stat(resolvedFilePath);
  if (!fileStat.isFile()) {
    throw new Error('目标不是一个文件。');
  }
  if (fileStat.size > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`文件过大，当前编辑限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }
  if (looksBinaryByExtension(relativePath) && !relativePath.toLowerCase().endsWith('.svg')) {
    throw new Error('当前 Agent 编辑工具仅支持文本文件。');
  }

  const raw = await readFile(resolvedFilePath);
  if (bufferLooksBinary(raw)) {
    throw new Error('当前 Agent 编辑工具仅支持文本文件。');
  }

  return {
    resolvedFilePath,
    relativePath,
    content: raw.toString('utf8')
  };
}

export async function replaceProjectTextInFileForProject(
  project: Project,
  filePath: string,
  oldText: string,
  newText: string,
  options?: {
    replaceAll?: boolean;
  }
): Promise<{
  path: string;
  size: number;
  replacementCount: number;
}> {
  const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, filePath);
  const fileStat = await stat(resolvedFilePath);
  if (!fileStat.isFile()) {
    throw new Error('目标不是一个文件。');
  }

  if (!oldText) {
    throw new Error('edit_file 缺少 oldText。');
  }

  if (oldText === newText) {
    throw new Error('oldText 和 newText 相同，不需要编辑。');
  }

  if (fileStat.size > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`文件过大，当前编辑限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }

  if (looksBinaryByExtension(relativePath) && !relativePath.toLowerCase().endsWith('.svg')) {
    throw new Error('当前 Agent 编辑工具仅支持文本文件。');
  }

  const raw = await readFile(resolvedFilePath);
  if (bufferLooksBinary(raw)) {
    throw new Error('当前 Agent 编辑工具仅支持文本文件。');
  }

  const content = raw.toString('utf8');
  const replacementCount = countOccurrences(content, oldText);
  if (replacementCount === 0) {
    throw new Error(`没有在 ${relativePath} 中找到 oldText。${buildReplacementNotFoundHint(content, oldText)}`);
  }

  if (replacementCount > 1 && !options?.replaceAll) {
    throw new Error(`oldText 在 ${relativePath} 中匹配了 ${replacementCount} 处，请提供更多上下文或设置 replaceAll。`);
  }

  const nextContent = options?.replaceAll
    ? content.split(oldText).join(newText)
    : content.replace(oldText, newText);
  const nextByteLength = Buffer.byteLength(nextContent, 'utf8');
  if (nextByteLength > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`编辑后的文件内容过大，当前限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }

  await writeFile(resolvedFilePath, nextContent, 'utf8');
  return {
    path: relativePath,
    size: nextByteLength,
    replacementCount: options?.replaceAll ? replacementCount : 1
  };
}

export async function previewProjectTextDiffForProject(
  project: Project,
  filePath: string,
  nextContent: string
): Promise<ProjectTextPatchPreview> {
  const file = await readEditableTextFile(project, filePath);
  const nextByteLength = Buffer.byteLength(nextContent, 'utf8');
  if (nextByteLength > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`预览内容过大，当前限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }
  if (file.content === nextContent) {
    throw new Error('预览内容与当前文件相同。');
  }

  const beforeLines = splitTextLines(file.content).lines;
  const afterLines = splitTextLines(nextContent).lines;
  return {
    path: file.relativePath,
    size: nextByteLength,
    hunkCount: 1,
    addedLines: Math.max(0, afterLines.length - beforeLines.length),
    removedLines: Math.max(0, beforeLines.length - afterLines.length),
    diffPreview: buildCompactUnifiedDiff(file.relativePath, file.content, nextContent),
    content: nextContent
  };
}

export async function previewProjectTextPatchForProject(
  project: Project,
  filePath: string,
  patch: string
): Promise<ProjectTextPatchPreview> {
  if (!patch.trim()) {
    throw new Error('patch_file 缺少 patch。');
  }

  const file = await readEditableTextFile(project, filePath);
  const patched = applyUnifiedPatchToContent(file.content, patch);
  if (file.content === patched.content) {
    throw new Error('patch 应用后没有产生变更。');
  }

  const nextByteLength = Buffer.byteLength(patched.content, 'utf8');
  if (nextByteLength > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`patch 后文件内容过大，当前限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }

  return {
    path: file.relativePath,
    size: nextByteLength,
    hunkCount: patched.hunkCount,
    addedLines: patched.addedLines,
    removedLines: patched.removedLines,
    diffPreview: buildCompactUnifiedDiff(file.relativePath, file.content, patched.content),
    content: patched.content
  };
}

export async function applyProjectTextPatchForProject(
  project: Project,
  filePath: string,
  patch: string
): Promise<Omit<ProjectTextPatchPreview, 'content'>> {
  const preview = await previewProjectTextPatchForProject(project, filePath, patch);
  const { resolvedFilePath } = resolveProjectFilePath(project, preview.path);
  await writeFile(resolvedFilePath, preview.content, 'utf8');
  return {
    path: preview.path,
    size: preview.size,
    hunkCount: preview.hunkCount,
    addedLines: preview.addedLines,
    removedLines: preview.removedLines,
    diffPreview: preview.diffPreview
  };
}

export async function replaceMultipleProjectTextInFileForProject(
  project: Project,
  filePath: string,
  edits: ProjectTextEditOperation[]
): Promise<ProjectTextMultiEditResult> {
  const { resolvedFilePath, relativePath } = resolveProjectFilePath(project, filePath);
  const fileStat = await stat(resolvedFilePath);
  if (!fileStat.isFile()) {
    throw new Error('目标不是一个文件。');
  }

  if (edits.length === 0) {
    throw new Error('multi_edit 至少需要 1 个编辑操作。');
  }

  if (edits.length > 20) {
    throw new Error('multi_edit 单次最多支持 20 个编辑操作。');
  }

  if (fileStat.size > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`文件过大，当前编辑限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }

  if (looksBinaryByExtension(relativePath) && !relativePath.toLowerCase().endsWith('.svg')) {
    throw new Error('当前 Agent 编辑工具仅支持文本文件。');
  }

  const raw = await readFile(resolvedFilePath);
  if (bufferLooksBinary(raw)) {
    throw new Error('当前 Agent 编辑工具仅支持文本文件。');
  }

  let nextContent = raw.toString('utf8');
  const appliedEdits: ProjectTextMultiEditResult['edits'] = [];
  let totalReplacementCount = 0;

  edits.forEach((edit, index) => {
    if (!edit.oldText) {
      throw new Error(`multi_edit 第 ${index + 1} 个编辑缺少 oldText。`);
    }

    if (edit.oldText === edit.newText) {
      throw new Error(`multi_edit 第 ${index + 1} 个编辑 oldText 和 newText 相同，不需要编辑。`);
    }

    const replacementCount = countOccurrences(nextContent, edit.oldText);
    if (replacementCount === 0) {
      throw new Error(`没有在 ${relativePath} 中找到第 ${index + 1} 个编辑的 oldText。${buildReplacementNotFoundHint(nextContent, edit.oldText)}`);
    }

    if (replacementCount > 1 && !edit.replaceAll) {
      throw new Error(`第 ${index + 1} 个 oldText 在 ${relativePath} 中匹配了 ${replacementCount} 处，请提供更多上下文或设置 replaceAll。`);
    }

    nextContent = edit.replaceAll
      ? nextContent.split(edit.oldText).join(edit.newText)
      : nextContent.replace(edit.oldText, edit.newText);
    const appliedReplacementCount = edit.replaceAll ? replacementCount : 1;
    totalReplacementCount += appliedReplacementCount;
    appliedEdits.push({
      index,
      replacementCount: appliedReplacementCount
    });
  });

  const nextByteLength = Buffer.byteLength(nextContent, 'utf8');
  if (nextByteLength > MAX_WRITE_TEXT_BYTES) {
    throw new Error(`编辑后的文件内容过大，当前限制为 ${MAX_WRITE_TEXT_BYTES} bytes。`);
  }

  await writeFile(resolvedFilePath, nextContent, 'utf8');
  return {
    path: relativePath,
    size: nextByteLength,
    replacementCount: totalReplacementCount,
    edits: appliedEdits
  };
}
