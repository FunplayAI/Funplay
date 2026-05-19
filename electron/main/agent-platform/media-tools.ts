import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ChatMediaBlock, Project } from '../../../shared/types';
import { resolveProjectRootPathForProject } from '../project-file-service';
import {
  MAX_MEDIA_BYTES,
  MAX_DOCUMENT_BYTES,
  MEDIA_EXTENSION_BY_MIME,
  type WorkspaceToolAction,
  type WorkspaceToolActionResult,
  type AgentToolExecutionOptions,
  mediaMimeForPath,
  mediaTypeForMime,
  sanitizeMediaFileName,
  stripDataUrlPrefix,
  ensureAttachmentDir,
  readWorkspaceFileBytes
} from './workspace-tools-types';
import { extractLocalDocumentText } from './document-extraction';
import {
  performWebFetchAction,
  performWebSearchAction
} from './web-research-service';

export async function performWebSearch(
  action: Extract<WorkspaceToolAction, { type: 'web_search' }>,
  options: AgentToolExecutionOptions
): Promise<WorkspaceToolActionResult> {
  return await performWebSearchAction(action, options);
}

export async function performWebFetch(action: Extract<WorkspaceToolAction, { type: 'web_fetch' }>, options: AgentToolExecutionOptions): Promise<WorkspaceToolActionResult> {
  return await performWebFetchAction(action, options);
}

export async function performMediaAttach(project: Project, action: Extract<WorkspaceToolAction, { type: 'media_attach_file' }>): Promise<WorkspaceToolActionResult> {
  const { absolutePath, relativePath, size } = await readWorkspaceFileBytes(project, action.filePath, MAX_MEDIA_BYTES);
  const mimeType = mediaMimeForPath(absolutePath);
  const media: ChatMediaBlock[] = [{
    type: mediaTypeForMime(mimeType),
    mimeType,
    localPath: absolutePath,
    title: action.title?.trim() || basename(relativePath)
  }];
  return {
    ok: true,
    summary: `Attached media: ${relativePath} (${size} bytes)`,
    media
  };
}

export async function performMediaSaveBase64(project: Project, action: Extract<WorkspaceToolAction, { type: 'media_save_base64' }>): Promise<WorkspaceToolActionResult> {
  const rootPath = resolveProjectRootPathForProject(project);
  const base64 = stripDataUrlPrefix(action.dataBase64).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new Error('media_save_base64 收到的 dataBase64 不是有效 base64。');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
    throw new Error('Media payload is empty or too large.');
  }
  const mimeType = action.mimeType?.trim() || 'image/png';
  const extension = MEDIA_EXTENSION_BY_MIME.get(mimeType) ?? '.bin';
  const attachmentDir = ensureAttachmentDir(rootPath, 'media');
  await mkdir(attachmentDir, { recursive: true });
  const targetName = sanitizeMediaFileName(action.fileName, `media-${Date.now()}${extension}`);
  const targetPath = join(attachmentDir, targetName.includes('.') ? targetName : `${targetName}${extension}`);
  await writeFile(targetPath, bytes);
  const media: ChatMediaBlock[] = [{
    type: mediaTypeForMime(mimeType),
    mimeType,
    localPath: targetPath,
    title: action.title?.trim() || basename(targetPath)
  }];
  return {
    ok: true,
    summary: `Saved media: ${targetPath} (${bytes.length} bytes)`,
    media
  };
}

export async function performImageGenerate(project: Project, action: Extract<WorkspaceToolAction, { type: 'image_generate' }>): Promise<WorkspaceToolActionResult> {
  const apiKey = process.env.FUNPLAY_IMAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      isError: true,
      summary: 'Image generation is not configured. Set FUNPLAY_IMAGE_API_KEY or OPENAI_API_KEY, then retry.'
    };
  }

  const rootPath = resolveProjectRootPathForProject(project);
  const baseUrl = (process.env.FUNPLAY_IMAGE_API_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const imageModel = action.model?.trim() || process.env.FUNPLAY_IMAGE_MODEL?.trim() || 'gpt-image-1';
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: imageModel,
      prompt: action.prompt,
      size: action.size ?? '1024x1024',
      n: 1
    })
  });
  const responseText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      isError: true,
      summary: `Image generation failed: HTTP ${response.status} ${responseText.slice(0, 1200)}`
    };
  }

  const parsed = JSON.parse(responseText) as unknown;
  const first = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { data?: unknown[] }).data)
    ? (parsed as { data: unknown[] }).data[0]
    : undefined;
  const firstRecord = first && typeof first === 'object' && !Array.isArray(first) ? first as Record<string, unknown> : undefined;
  let bytes: Buffer | undefined;
  let mimeType = 'image/png';
  if (typeof firstRecord?.b64_json === 'string') {
    bytes = Buffer.from(firstRecord.b64_json, 'base64');
  } else if (typeof firstRecord?.url === 'string') {
    const imageResponse = await fetch(firstRecord.url);
    if (!imageResponse.ok) {
      return {
        ok: false,
        isError: true,
        summary: `Generated image URL fetch failed: HTTP ${imageResponse.status}`
      };
    }
    const contentType = imageResponse.headers.get('content-type');
    if (contentType?.startsWith('image/')) {
      mimeType = contentType.split(';')[0];
    }
    bytes = Buffer.from(await imageResponse.arrayBuffer());
  }

  if (!bytes || bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      isError: true,
      summary: 'Image generation response did not include a usable image payload.'
    };
  }

  const extension = MEDIA_EXTENSION_BY_MIME.get(mimeType) ?? '.png';
  const attachmentDir = ensureAttachmentDir(rootPath, 'image-gen');
  await mkdir(attachmentDir, { recursive: true });
  const targetName = sanitizeMediaFileName(action.fileName, `image-${Date.now()}${extension}`);
  const targetPath = join(attachmentDir, targetName.includes('.') ? targetName : `${targetName}${extension}`);
  await writeFile(targetPath, bytes);
  const media: ChatMediaBlock[] = [{
    type: 'image',
    mimeType,
    localPath: targetPath,
    title: action.title?.trim() || basename(targetPath)
  }];
  return {
    ok: true,
    summary: `Generated image: ${targetPath} (${bytes.length} bytes)`,
    media
  };
}

export async function performReadDocument(project: Project, action: Extract<WorkspaceToolAction, { type: 'read_document' }>): Promise<WorkspaceToolActionResult> {
  const { relativePath, absolutePath, bytes, size } = await readWorkspaceFileBytes(project, action.path, MAX_DOCUMENT_BYTES);
  const extracted = await extractLocalDocumentText(absolutePath, relativePath, bytes, {
    pages: action.pages,
    maxChars: action.maxChars
  });
  return {
    ok: true,
    summary: [
      `[${relativePath}]`,
      `Extraction: ${extracted.extraction}`,
      `Size: ${size} bytes`,
      extracted.pages ? `Pages: ${extracted.pages}` : '',
      typeof extracted.pageCount === 'number' ? `Detected pages/slides/sheets: ${extracted.pageCount}` : '',
      '',
      extracted.text || '(no readable text extracted)'
    ].filter((line) => line !== '').join('\n')
  };
}
