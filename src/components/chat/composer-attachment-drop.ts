import { useState, type ClipboardEvent, type DragEvent } from 'react';

type AttachmentSource = 'paste' | 'drop';

export function useComposerAttachmentDrop(onImportAttachments: (files: File[], source: AttachmentSource) => void): {
  attachmentDropActive: boolean;
  pasteProps: {
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  };
  dropProps: {
    'data-attachment-drop-active': 'true' | 'false';
    onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
  };
} {
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);

  return {
    attachmentDropActive,
    pasteProps: {
      onPaste: (event) => {
        const files = getTransferFiles(event.clipboardData);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
        onImportAttachments(files, 'paste');
      }
    },
    dropProps: {
      'data-attachment-drop-active': attachmentDropActive ? 'true' : 'false',
      onDragEnter: (event) => {
        if (!transferHasFiles(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        setAttachmentDropActive(true);
      },
      onDragOver: (event) => {
        if (!transferHasFiles(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setAttachmentDropActive(true);
      },
      onDragLeave: (event) => {
        const relatedTarget = event.relatedTarget;
        if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
          return;
        }
        setAttachmentDropActive(false);
      },
      onDrop: (event) => {
        const files = getTransferFiles(event.dataTransfer);
        if (files.length === 0) {
          setAttachmentDropActive(false);
          return;
        }
        event.preventDefault();
        setAttachmentDropActive(false);
        onImportAttachments(files, 'drop');
      }
    }
  };
}

function getTransferFiles(dataTransfer?: DataTransfer | null): File[] {
  if (!dataTransfer) {
    return [];
  }

  const fileList = Array.from(dataTransfer.files ?? []);
  const itemFiles = fileList.length > 0
    ? []
    : Array.from(dataTransfer.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  const seen = new Set<string>();
  return [...fileList, ...itemFiles]
    .filter((file) => file.size > 0)
    .filter((file) => {
      const key = `${file.name}:${file.type}:${file.size}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function transferHasFiles(dataTransfer?: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  if (dataTransfer.files?.length) {
    return true;
  }
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file');
}
