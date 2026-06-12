import { readFile } from 'node:fs/promises';
import type { AiProvider, ChatMediaBlock } from '../../../../shared/types';
import { resolveProviderModelMetadata } from '../../../../shared/provider-catalog';
import type { OpenAiCompatibleImagePart } from '../../openai-compatible-types';

/** Max images forwarded per tool result, and max decoded bytes per image. */
export const MAX_TOOL_RESULT_IMAGES = 2;
export const MAX_IMAGE_PART_BYTES = 4 * 1024 * 1024;

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
  try {
    let dataBase64: string | undefined;
    if (block.data) {
      dataBase64 = stripDataUrl(block.data).replace(/\s+/g, '');
    } else if (block.localPath) {
      const bytes = await readFile(block.localPath);
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
    return { mimeType, dataBase64 };
  } catch {
    return undefined;
  }
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
