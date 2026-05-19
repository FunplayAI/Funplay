export function getFileExtension(path: string): string {
  const matched = path.toLowerCase().match(/\.([a-z0-9]+)$/i);
  return matched?.[1] ?? '';
}

export function isMarkdownFile(path: string): boolean {
  const extension = getFileExtension(path);
  return extension === 'md' || extension === 'markdown';
}

export function isHtmlFile(path: string): boolean {
  const extension = getFileExtension(path);
  return extension === 'html' || extension === 'htm';
}

export function isImageFile(path: string): boolean {
  const extension = getFileExtension(path);
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(extension);
}

export function isAudioFile(path: string): boolean {
  const extension = getFileExtension(path);
  return ['wav', 'mp3', 'ogg', 'aiff'].includes(extension);
}

export function isVideoFile(path: string): boolean {
  const extension = getFileExtension(path);
  return ['mp4', 'mov', 'webm'].includes(extension);
}

export function isPdfFile(path: string): boolean {
  return getFileExtension(path) === 'pdf';
}

export function isPresentationFile(path: string): boolean {
  return getFileExtension(path) === 'pptx';
}

export function isWordDocumentFile(path: string): boolean {
  return getFileExtension(path) === 'docx';
}

export function isOfficeDocumentFile(path: string): boolean {
  return isPresentationFile(path) || isWordDocumentFile(path);
}

export function isPreviewableFile(path: string): boolean {
  return isMarkdownFile(path) || isHtmlFile(path) || isImageFile(path) || isAudioFile(path) || isVideoFile(path) || isPdfFile(path) || isOfficeDocumentFile(path);
}
