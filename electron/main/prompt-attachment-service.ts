import { app, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AppState, PromptAttachment, PromptAttachmentImportItem } from '../../shared/types';

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_IMPORT = 12;

function expandHome(value: string): string {
  return value.replace(/^~(?=$|\/)/, homedir());
}

function resolveProjectDirectory(state: AppState, projectId: string): string {
  const project = state.projects.find((item) => item.id === projectId);
  const projectPath = project?.engine?.projectPath?.trim();
  if (!project || !projectPath) {
    throw new Error('Project source path is not configured.');
  }
  return resolve(expandHome(projectPath));
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || `attachment-${Date.now()}`;
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'project';
}

function resolvePromptAttachmentCacheDir(projectId: string): string {
  return join(app.getPath('userData'), 'prompt-attachments', sanitizePathSegment(projectId));
}

function getProjectRelativePath(projectDir: string, absolutePath: string): string | undefined {
  const normalized = relative(projectDir, absolutePath).replaceAll('\\', '/');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

function inferMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime'
  };
  return map[ext] ?? 'application/octet-stream';
}

function inferExtensionFromMimeType(mimeType?: string): string {
  const normalized = mimeType?.trim().toLowerCase();
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'text/csv': '.csv',
    'audio/wav': '.wav',
    'audio/mpeg': '.mp3',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov'
  };
  return normalized ? map[normalized] ?? '' : '';
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function parseDataUrl(value: string): { mimeType: string; data: Buffer } {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    throw new Error('Unsupported pasted attachment payload.');
  }

  return {
    mimeType: match[1].trim().toLowerCase(),
    data: Buffer.from(match[2], 'base64')
  };
}

async function createImagePreview(filePath: string, mimeType: string, size: number): Promise<string | undefined> {
  if (!isImageMime(mimeType) || size > MAX_PREVIEW_BYTES) {
    return undefined;
  }

  const data = await readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

async function createPromptAttachment(projectDir: string, source: {
  projectId: string;
  name: string;
  sourcePath?: string;
  data?: Buffer;
  mimeType?: string;
  size?: number;
}, index: number): Promise<PromptAttachment | null> {
  const safeName = sanitizeFileName(source.name);
  let attachmentPath = source.sourcePath ? resolve(source.sourcePath) : '';
  let size = source.size ?? 0;

  if (source.sourcePath) {
    const fileStat = await stat(attachmentPath);
    if (!fileStat.isFile()) {
      return null;
    }
    if (fileStat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment "${safeName}" is larger than 100 MB.`);
    }
    size = fileStat.size;
  } else if (source.data) {
    const targetDir = resolvePromptAttachmentCacheDir(source.projectId);
    await mkdir(targetDir, { recursive: true });
    attachmentPath = join(targetDir, `${Date.now()}-${index}-${safeName}`);
    size = source.data.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment "${safeName}" is larger than 100 MB.`);
    }
    await writeFile(attachmentPath, source.data);
  } else {
    return null;
  }

  const mimeType = source.mimeType?.trim() || inferMimeType(attachmentPath);
  const relativePath = getProjectRelativePath(projectDir, attachmentPath);
  return {
    id: randomUUID(),
    name: safeName,
    path: attachmentPath,
    relativePath,
    mimeType,
    kind: isImageMime(mimeType) ? 'image' : 'file',
    size,
    previewDataUrl: await createImagePreview(attachmentPath, mimeType, size)
  };
}

export async function importPromptAttachments(state: AppState, projectId: string, items: PromptAttachmentImportItem[]): Promise<PromptAttachment[]> {
  const projectDir = resolveProjectDirectory(state, projectId);
  const attachments: PromptAttachment[] = [];

  for (const [index, item] of items.slice(0, MAX_ATTACHMENTS_PER_IMPORT).entries()) {
    if (item.path) {
      const sourcePath = resolve(expandHome(item.path));
      const attachment = await createPromptAttachment(projectDir, {
        projectId,
        name: item.name || basename(sourcePath),
        sourcePath,
        mimeType: item.mimeType
      }, index);
      if (attachment) {
        attachments.push(attachment);
      }
      continue;
    }

    if (item.dataUrl) {
      const parsed = parseDataUrl(item.dataUrl);
      const extension = inferExtensionFromMimeType(item.mimeType || parsed.mimeType);
      const fallbackName = `${isImageMime(parsed.mimeType) ? 'pasted-image' : 'pasted-file'}${extension || '.bin'}`;
      const providedName = item.name?.trim();
      const name = providedName && extname(providedName) ? providedName : `${providedName || fallbackName}${providedName && extension ? extension : ''}`;
      const attachment = await createPromptAttachment(projectDir, {
        projectId,
        name,
        data: parsed.data,
        mimeType: item.mimeType || parsed.mimeType,
        size: item.size
      }, index);
      if (attachment) {
        attachments.push(attachment);
      }
    }
  }

  return attachments;
}

export async function pickPromptAttachments(state: AppState, projectId: string, window?: BrowserWindow | null): Promise<PromptAttachment[]> {
  const projectDir = resolveProjectDirectory(state, projectId);
  const options: OpenDialogOptions = {
    title: 'Attach files',
    defaultPath: projectDir,
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Images and documents',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'json', 'csv']
      },
      {
        name: 'All files',
        extensions: ['*']
      }
    ]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }

  return importPromptAttachments(
    state,
    projectId,
    result.filePaths.map((filePath) => ({
      name: basename(filePath),
      path: filePath
    }))
  );
}
