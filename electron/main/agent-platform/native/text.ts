export function normalizeModelReplyText(value: string): string {
  const unwrapped = unwrapJsonString(value.trim());
  const escapedNewlines = unwrapped.match(/\\r\\n|\\n|\\r/g)?.length ?? 0;
  if (escapedNewlines === 0) {
    return unwrapped.trim();
  }

  const shouldDecodeEscapedLineBreaks =
    /\\n\\n/.test(unwrapped) ||
    escapedNewlines >= 2 ||
    (!unwrapped.includes('\n') && /[。！？.!?]\\n/.test(unwrapped));

  if (!shouldDecodeEscapedLineBreaks) {
    return unwrapped.trim();
  }

  return unwrapped
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .trim();
}

function unwrapJsonString(value: string): string {
  if (!(
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}
