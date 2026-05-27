const namedEntities = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['#39', "'"],
  ['nbsp', ' ']
]);

export function normalizeReleaseNotesText(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return '';
  }
  const htmlLike = /<\/?[a-z][\s\S]*>/i.test(raw);
  const text = htmlLike ? htmlToText(raw) : decodeHtmlEntities(raw);
  return normalizePlainText(text);
}

function htmlToText(input: string): string {
  return decodeHtmlEntities(input
    .replace(/\r/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_, level: string) => `\n\n${'#'.repeat(Math.min(6, Number(level)))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?(ul|ol)(?:\s[^>]*)?>/gi, '\n')
    .replace(/<p(?:\s[^>]*)?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<code(?:\s[^>]*)?>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<\/?(div|section|article|blockquote|pre)(?:\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

function normalizePlainText(input: string): string {
  const lines = input
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim());
  const normalized: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line) {
      const previous = normalized[normalized.length - 1] ?? '';
      const next = lines[index + 1] ?? '';
      if (previous.startsWith('- ') && next.startsWith('- ')) {
        continue;
      }
      if (normalized.length && normalized[normalized.length - 1] !== '') {
        normalized.push('');
      }
      continue;
    }
    normalized.push(line);
  }
  return normalized.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized.startsWith('#x')) {
      return decodeCodePoint(Number.parseInt(normalized.slice(2), 16), entity);
    }
    if (normalized.startsWith('#')) {
      return decodeCodePoint(Number.parseInt(normalized.slice(1), 10), entity);
    }
    return namedEntities.get(normalized) ?? entity;
  });
}

function decodeCodePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}
