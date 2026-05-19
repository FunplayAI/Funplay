import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AppState, PromptAttachment } from '../../shared/types';

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

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

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

async function createImagePreview(filePath: string, mimeType: string, size: number): Promise<string | undefined> {
  if (!isImageMime(mimeType) || size > MAX_PREVIEW_BYTES) {
    return undefined;
  }

  const data = await readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
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

  const targetDir = join(projectDir, '.funplay-attachments');
  await mkdir(targetDir, { recursive: true });

  const attachments: PromptAttachment[] = [];
  for (const [index, sourcePath] of result.filePaths.slice(0, 12).entries()) {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      continue;
    }

    const safeName = sanitizeFileName(basename(sourcePath));
    const destination = join(targetDir, `${Date.now()}-${index}-${safeName}`);
    await copyFile(sourcePath, destination);

    const mimeType = inferMimeType(destination);
    const relativePath = relative(projectDir, destination);
    attachments.push({
      id: randomUUID(),
      name: safeName,
      path: destination,
      relativePath,
      mimeType,
      kind: isImageMime(mimeType) ? 'image' : 'file',
      size: fileStat.size,
      previewDataUrl: await createImagePreview(destination, mimeType, fileStat.size)
    });
  }

  return attachments;
}
