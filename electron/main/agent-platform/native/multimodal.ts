import { readFile } from 'node:fs/promises';
import type { AiProvider, ChatMediaBlock, PromptAttachment } from '../../../../shared/types';
import { resolveProviderModelMetadata } from '../../../../shared/provider-catalog';
import type { OpenAiCompatibleImagePart } from '../../openai-compatible-types';

/** Max images forwarded per tool result, and max decoded bytes per image. */
export const MAX_TOOL_RESULT_IMAGES = 2;
export const MAX_IMAGE_PART_BYTES = 4 * 1024 * 1024;
/** Max image attachments forwarded into model context from a single user message. */
export const MAX_PROMPT_ATTACHMENT_IMAGES = 4;

const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Whether the provider's resolved model accepts image input. */
export function resolveModelVisionEnabled(provider: AiProvider | undefined): boolean {
  if (!provider) {
    return false;
  }
  return resolveProviderModelMetadata(provider)?.capabilities?.vision === true;
}

function stripDataUrl(value: string): string {
  const commaIndex = value.indexOf(',');
  return value.startsWith('data:') && commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
}

function normalizeImageMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === 'image/jpg') {
    return 'image/jpeg';
  }
  return SUPPORTED_IMAGE_MIME.has(normalized) ? normalized : undefined;
}

/**
 * Loads a supported image into a base64 image part from an inline data URL/base64
 * string or a file on disk, enforcing the per-image size cap. Returns undefined
 * when the mime is unsupported, the bytes are missing/oversized, or the read fails.
 */
async function loadImagePartFromSource(input: {
  mimeType: string;
  inlineData?: string;
  filePath?: string;
}): Promise<OpenAiCompatibleImagePart | undefined> {
  try {
    let dataBase64: string | undefined;
    if (input.inlineData) {
      dataBase64 = stripDataUrl(input.inlineData).replace(/\s+/g, '');
    } else if (input.filePath) {
      const bytes = await readFile(input.filePath);
      if (bytes.length > MAX_IMAGE_PART_BYTES) {
        return undefined;
      }
      dataBase64 = bytes.toString('base64');
    }
    if (!dataBase64) {
      return undefined;
    }
    if (Buffer.byteLength(dataBase64, 'base64') > MAX_IMAGE_PART_BYTES) {
      return undefined;
    }
    return { mimeType: input.mimeType, dataBase64 };
  } catch {
    return undefined;
  }
}

/**
 * Loads an image media block into a base64 image part, or returns undefined when
 * the block is not a supported image, exceeds the size cap, or cannot be read.
 * Inline `data` is preferred; otherwise the block's `localPath` is read from disk.
 */
export async function loadImagePartFromMediaBlock(
  block: ChatMediaBlock
): Promise<OpenAiCompatibleImagePart | undefined> {
  if (block.type !== 'image') {
    return undefined;
  }
  const mimeType = normalizeImageMime(block.mimeType);
  if (!mimeType) {
    return undefined;
  }
  return loadImagePartFromSource({ mimeType, inlineData: block.data, filePath: block.localPath });
}

/**
 * Loads an image-kind prompt attachment into a base64 image part. Prefers the
 * inline `previewDataUrl` captured at submit time; otherwise reads `path` from
 * disk. Returns undefined for non-image attachments or unsupported/oversized images.
 */
export async function loadImagePartFromPromptAttachment(
  attachment: PromptAttachment
): Promise<OpenAiCompatibleImagePart | undefined> {
  if (attachment.kind !== 'image') {
    return undefined;
  }
  const mimeType = normalizeImageMime(attachment.mimeType);
  if (!mimeType) {
    return undefined;
  }
  return loadImagePartFromSource({ mimeType, inlineData: attachment.previewDataUrl, filePath: attachment.path });
}

/**
 * Collects up to MAX_PROMPT_ATTACHMENT_IMAGES image parts from a user message's
 * attachments, in order. Non-image / unsupported / oversized attachments are
 * silently skipped (they still appear in the text attachment listing).
 */
export async function collectPromptAttachmentImageParts(
  attachments: PromptAttachment[] | undefined
): Promise<OpenAiCompatibleImagePart[]> {
  if (!attachments?.length) {
    return [];
  }
  const parts: OpenAiCompatibleImagePart[] = [];
  for (const attachment of attachments) {
    if (parts.length >= MAX_PROMPT_ATTACHMENT_IMAGES) {
      break;
    }
    const part = await loadImagePartFromPromptAttachment(attachment);
    if (part) {
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Collects up to MAX_TOOL_RESULT_IMAGES image parts from a tool result's media.
 * Returns the loaded parts plus how many image blocks were dropped (oversized,
 * unsupported, or beyond the cap) so the caller can note it for the model.
 */
export async function collectToolResultImageParts(
  media: ChatMediaBlock[] | undefined
): Promise<{ parts: OpenAiCompatibleImagePart[]; droppedCount: number }> {
  if (!media?.length) {
    return { parts: [], droppedCount: 0 };
  }
  const imageBlocks = media.filter((block) => block.type === 'image');
  const parts: OpenAiCompatibleImagePart[] = [];
  let droppedCount = 0;
  for (const block of imageBlocks) {
    if (parts.length >= MAX_TOOL_RESULT_IMAGES) {
      droppedCount += 1;
      continue;
    }
    const part = await loadImagePartFromMediaBlock(block);
    if (part) {
      parts.push(part);
    } else {
      droppedCount += 1;
    }
  }
  return { parts, droppedCount };
}
