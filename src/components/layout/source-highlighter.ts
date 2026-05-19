export interface CodeToken {
  text: string;
  kind?: 'keyword' | 'string' | 'comment' | 'number' | 'operator' | 'tag' | 'marker';
}

export const CODE_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'return',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'undefined',
  'var',
  'while'
]);

function getFileExtension(path: string): string {
  const matched = path.toLowerCase().match(/\.([a-z0-9]+)$/i);
  return matched?.[1] ?? '';
}

export function highlightSourceLine(line: string, path: string): CodeToken[] {
  const extension = getFileExtension(path);
  if (extension === 'html' || extension === 'htm' || extension === 'xml' || extension === 'svg') {
    return highlightMarkupLine(line);
  }
  if (extension === 'md' || extension === 'markdown') {
    return highlightMarkdownLine(line);
  }
  return highlightCodeLine(line);
}

function highlightMarkupLine(line: string): CodeToken[] {
  return splitLineByPattern(line, /<!--.*?-->|<\/?[A-Za-z][^>]*>/g, (value) => ({
    text: value,
    kind: value.startsWith('<!--') ? 'comment' : 'tag'
  }));
}

function highlightMarkdownLine(line: string): CodeToken[] {
  const headingMatch = line.match(/^(#{1,6})(\s+.*)?$/);
  if (headingMatch) {
    return [
      { text: headingMatch[1], kind: 'marker' },
      { text: headingMatch[2] ?? '', kind: 'keyword' }
    ];
  }
  const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.|\u2022)\s+)(.*)$/);
  if (listMatch) {
    return [
      { text: listMatch[1], kind: 'marker' },
      { text: listMatch[2] }
    ];
  }
  return splitLineByPattern(line, /`[^`]*`|\*\*[^*]+\*\*/g, (value) => ({
    text: value,
    kind: value.startsWith('`') ? 'string' : 'keyword'
  }));
}

function splitLineByPattern(line: string, pattern: RegExp, mapMatch: (value: string) => CodeToken): CodeToken[] {
  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, index) });
    }
    tokens.push(mapMatch(match[0]));
    lastIndex = index + match[0].length;
  }
  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex) });
  }
  return tokens;
}

export function highlightCodeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    if (rest.startsWith('//')) {
      tokens.push({ text: rest, kind: 'comment' });
      break;
    }

    const char = line[index];
    if (char === '"' || char === "'" || char === '`') {
      const endIndex = findQuotedTokenEnd(line, index, char);
      tokens.push({ text: line.slice(index, endIndex), kind: 'string' });
      index = endIndex;
      continue;
    }

    const numberMatch = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (numberMatch) {
      tokens.push({ text: numberMatch[0], kind: 'number' });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = rest.match(/^[A-Za-z_$][\w$]*/);
    if (identifierMatch) {
      const text = identifierMatch[0];
      tokens.push({
        text,
        kind: CODE_KEYWORDS.has(text) ? 'keyword' : undefined
      });
      index += text.length;
      continue;
    }

    const operatorMatch = rest.match(/^[{}()[\].,;:+\-*/%=<>!&|?]+/);
    if (operatorMatch) {
      tokens.push({ text: operatorMatch[0], kind: 'operator' });
      index += operatorMatch[0].length;
      continue;
    }

    tokens.push({ text: char });
    index += 1;
  }

  return tokens;
}

function findQuotedTokenEnd(line: string, startIndex: number, quote: string): number {
  let index = startIndex + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return line.length;
}
