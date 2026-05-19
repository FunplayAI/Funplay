export const HTML_PROJECT_PREVIEW_PROTOCOL = 'funplay-project-preview';
export type HtmlProjectPreviewMode = 'fit' | 'actual';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!hex || hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
    return undefined;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

export function encodeHtmlPreviewProjectHost(projectId: string): string {
  return `p-${bytesToHex(new TextEncoder().encode(projectId))}`;
}

export function decodeHtmlPreviewProjectHost(host: string): string | undefined {
  const normalized = host.toLowerCase();
  if (!normalized.startsWith('p-')) {
    return undefined;
  }

  const bytes = hexToBytes(normalized.slice(2));
  if (!bytes) {
    return undefined;
  }
  return new TextDecoder().decode(bytes);
}

export function encodeHtmlPreviewPath(filePath: string): string {
  return filePath
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildHtmlProjectPreviewUrl(projectId: string, filePath: string, options: {
  mode?: HtmlProjectPreviewMode;
} = {}): string {
  const baseUrl = `${HTML_PROJECT_PREVIEW_PROTOCOL}://${encodeHtmlPreviewProjectHost(projectId)}/${encodeHtmlPreviewPath(filePath)}`;
  return options.mode ? `${baseUrl}?funplayPreviewMode=${encodeURIComponent(options.mode)}` : baseUrl;
}
