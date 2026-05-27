import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { PromptAttachment, PromptAttachmentImportItem } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';

type AttachmentSource = 'paste' | 'drop';

export function usePromptAttachmentImport(options: {
  projectId?: string;
  sessionId?: string;
  sessionAttachments: Record<string, PromptAttachment[]>;
  setSessionAttachments: Dispatch<SetStateAction<Record<string, PromptAttachment[]>>>;
  setSessionComposerErrors: Dispatch<SetStateAction<Record<string, string>>>;
  language: UiLanguage;
}): {
  handlePickPromptAttachments: () => Promise<void>;
  handleImportPromptAttachmentFiles: (files: File[], source: AttachmentSource) => Promise<void>;
  removePromptAttachment: (sessionId: string, attachmentId: string) => void;
} {
  const mergePromptAttachments = useCallback((sessionId: string, attachments: PromptAttachment[]): void => {
    if (attachments.length === 0) {
      return;
    }

    options.setSessionAttachments((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), ...attachments].slice(0, 12)
    }));
    options.setSessionComposerErrors((current) => ({ ...current, [sessionId]: '' }));
  }, [options.setSessionAttachments, options.setSessionComposerErrors]);

  const handlePickPromptAttachments = useCallback(async (): Promise<void> => {
    if (!options.projectId || !options.sessionId) {
      return;
    }

    try {
      const attachments = await window.funplay.pickPromptAttachments(options.projectId);
      mergePromptAttachments(options.sessionId, attachments);
    } catch (error) {
      options.setSessionComposerErrors((current) => ({
        ...current,
        [options.sessionId!]: error instanceof Error ? error.message : localize(options.language, '附件选择失败。', 'Failed to attach files.')
      }));
    }
  }, [mergePromptAttachments, options.language, options.projectId, options.sessionId, options.setSessionComposerErrors]);

  const handleImportPromptAttachmentFiles = useCallback(async (files: File[], source: AttachmentSource): Promise<void> => {
    if (!options.projectId || !options.sessionId || files.length === 0) {
      return;
    }

    const availableSlots = Math.max(0, 12 - (options.sessionAttachments[options.sessionId]?.length ?? 0));
    if (availableSlots === 0) {
      options.setSessionComposerErrors((current) => ({
        ...current,
        [options.sessionId!]: localize(options.language, '本轮最多添加 12 个附件。', 'You can attach up to 12 files per request.')
      }));
      return;
    }

    try {
      const importItems = (await Promise.all(
        files.slice(0, availableSlots).map((file, index) => createAttachmentImportItem(file, index, source))
      )).filter((item): item is PromptAttachmentImportItem => Boolean(item));
      if (importItems.length === 0) {
        return;
      }
      const attachments = await window.funplay.importPromptAttachments(options.projectId, importItems);
      mergePromptAttachments(options.sessionId, attachments);
    } catch (error) {
      options.setSessionComposerErrors((current) => ({
        ...current,
        [options.sessionId!]: error instanceof Error ? error.message : localize(options.language, '附件导入失败。', 'Failed to import attachments.')
      }));
    }
  }, [
    mergePromptAttachments,
    options.language,
    options.projectId,
    options.sessionAttachments,
    options.sessionId,
    options.setSessionComposerErrors
  ]);

  const removePromptAttachment = useCallback((sessionId: string, attachmentId: string): void => {
    options.setSessionAttachments((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).filter((attachment) => attachment.id !== attachmentId)
    }));
  }, [options.setSessionAttachments]);

  return {
    handlePickPromptAttachments,
    handleImportPromptAttachmentFiles,
    removePromptAttachment
  };
}

function inferClipboardAttachmentExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/svg+xml') return '.svg';
  if (normalized === 'text/plain') return '.txt';
  if (normalized === 'text/markdown') return '.md';
  if (normalized === 'application/json') return '.json';
  return '';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Failed to read attachment.'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function createAttachmentImportItem(file: File, index: number, source: AttachmentSource): Promise<PromptAttachmentImportItem | null> {
  if (file.size <= 0) {
    return null;
  }

  const filePath = getNativeFilePath(file);
  const mimeType = file.type || undefined;
  const extension = inferClipboardAttachmentExtension(mimeType ?? '');
  const fallbackName = `${source === 'paste' ? 'pasted-attachment' : 'dropped-attachment'}-${index + 1}${extension || ''}`;
  const name = file.name?.trim() || fallbackName;

  return filePath
    ? { name, path: filePath, mimeType, size: file.size }
    : { name, dataUrl: await readFileAsDataUrl(file), mimeType, size: file.size };
}

function getNativeFilePath(file: File): string {
  try {
    return window.funplay.getPathForFile(file);
  } catch {
    return '';
  }
}
