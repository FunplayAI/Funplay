const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export function isHtmlPreviewExternalUrl(resourceUrl: string): boolean {
  const value = resourceUrl.trim();
  return (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    URL_SCHEME_PATTERN.test(value)
  );
}

export function stripHtmlPreviewUrlSuffix(resourceUrl: string): string {
  const hashIndex = resourceUrl.indexOf('#');
  const queryIndex = resourceUrl.indexOf('?');
  const suffixIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const endIndex = suffixIndexes.length ? Math.min(...suffixIndexes) : resourceUrl.length;
  return resourceUrl.slice(0, endIndex);
}

export function resolveHtmlPreviewProjectPath(documentPath: string, resourceUrl: string): string | undefined {
  const value = resourceUrl.trim();
  if (isHtmlPreviewExternalUrl(value)) {
    return undefined;
  }

  const pathPart = stripHtmlPreviewUrlSuffix(value).replaceAll('\\', '/');
  if (!pathPart) {
    return undefined;
  }

  let decodedPath = pathPart;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    decodedPath = pathPart;
  }

  const baseSegments = documentPath.split('/').slice(0, -1);
  const inputSegments = decodedPath.startsWith('/')
    ? decodedPath.slice(1).split('/')
    : [...baseSegments, ...decodedPath.split('/')];
  const normalizedSegments: string[] = [];

  for (const segment of inputSegments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (normalizedSegments.length === 0) {
        return undefined;
      }
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }

  return normalizedSegments.length ? normalizedSegments.join('/') : undefined;
}
