export interface ParsedCodeBlock {
  type: 'code';
  language?: string;
  content: string;
}

export interface ParsedHeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4;
  text: string;
}

export interface ParsedParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface ParsedListBlock {
  type: 'list';
  items: string[];
}

export interface ParsedQuoteBlock {
  type: 'quote';
  text: string;
}

export interface ParsedDividerBlock {
  type: 'divider';
}

export interface ParsedTableBlock {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export type ParsedChatBlock = ParsedCodeBlock | ParsedHeadingBlock | ParsedParagraphBlock | ParsedListBlock | ParsedQuoteBlock | ParsedDividerBlock | ParsedTableBlock;

export function readStringField(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function parseChatBlocks(content: string): ParsedChatBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ParsedChatBlock[] = [];
  const paragraphLines: string[] = [];
  const listItems: string[] = [];
  const quoteLines: string[] = [];
  const codeLines: string[] = [];
  let codeLanguage = '';
  let inCodeBlock = false;

  function flushParagraph(): void {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join(' ').trim()
    });
    paragraphLines.length = 0;
  }

  function flushList(): void {
    if (listItems.length === 0) {
      return;
    }
    blocks.push({
      type: 'list',
      items: [...listItems]
    });
    listItems.length = 0;
  }

  function flushQuote(): void {
    if (quoteLines.length === 0) {
      return;
    }
    blocks.push({
      type: 'quote',
      text: quoteLines.join(' ').trim()
    });
    quoteLines.length = 0;
  }

  function flushCode(): void {
    blocks.push({
      type: 'code',
      language: codeLanguage || undefined,
      content: codeLines.join('\n').trim()
    });
    codeLines.length = 0;
    codeLanguage = '';
  }

  function flushTableRows(rows: string[][]): void {
    if (rows.length < 2 || !isMarkdownTableSeparatorRow(rows[1])) {
      return;
    }
    const width = rows[0].length;
    if (width === 0) {
      return;
    }
    blocks.push({
      type: 'table',
      headers: rows[0],
      rows: rows.slice(2).filter((row) => row.some((cell) => cell.trim())).map((row) => {
        const normalized = row.slice(0, width);
        while (normalized.length < width) {
          normalized.push('');
        }
        return normalized;
      })
    });
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.trimEnd();

    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      flushQuote();
      if (inCodeBlock) {
        flushCode();
      } else {
        codeLanguage = line.replace(/```/, '').trim();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const collapsedTable = parseCollapsedMarkdownTableRows(line);
    if (collapsedTable) {
      const prefix = line.slice(0, collapsedTable.startIndex).trim();
      if (prefix) {
        paragraphLines.push(prefix);
      }
      flushParagraph();
      flushList();
      flushQuote();
      flushTableRows(collapsedTable.rows);
      continue;
    }

    const tableRow = parseMarkdownTableRow(line);
    const nextTableRow = lineIndex + 1 < lines.length ? parseMarkdownTableRow(lines[lineIndex + 1].trimEnd()) : null;
    if (tableRow && nextTableRow && isMarkdownTableSeparatorRow(nextTableRow)) {
      const rows = [tableRow, nextTableRow];
      lineIndex += 1;
      while (lineIndex + 1 < lines.length) {
        const row = parseMarkdownTableRow(lines[lineIndex + 1].trimEnd());
        if (!row) {
          break;
        }
        rows.push(row);
        lineIndex += 1;
      }
      flushParagraph();
      flushList();
      flushQuote();
      flushTableRows(rows);
      continue;
    }

    const dividerMatch = line.trim().match(/^([-*_])(?:\s*\1){2,}\s*$/);
    if (dividerMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({ type: 'divider' });
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3 | 4,
        text: headingMatch[2].trim()
      });
      continue;
    }

    const standaloneBulletMatch = line.match(/^\s*[•]\s*$/);
    if (standaloneBulletMatch && lineIndex + 1 < lines.length) {
      const nextLine = lines[lineIndex + 1].trim();
      if (nextLine && !isStructuralMarkdownLine(nextLine)) {
        flushParagraph();
        flushQuote();
        listItems.push(nextLine);
        lineIndex += 1;
        continue;
      }
    }

    const listMatch = line.match(/^\s*[-*+•]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      flushQuote();
      listItems.push(listMatch[1].trim());
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1].trim());
      continue;
    }

    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushQuote();
  if (inCodeBlock) {
    flushCode();
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', text: content }];
}

export function isStructuralMarkdownLine(line: string): boolean {
  return /^(```|#{1,6}\s|[-*_]{3,}\s*$|[-*+•]\s+|>\s?|[|])/.test(line);
}

export function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
    return null;
  }
  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

export function isMarkdownTableSeparatorRow(row: string[]): boolean {
  return row.length >= 2 && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function parseCollapsedMarkdownTableRows(line: string): { rows: string[][]; startIndex: number } | null {
  if (!/\|\s*:?-{3,}:?\s*\|/.test(line)) {
    return null;
  }
  const startIndex = line.indexOf('|');
  if (startIndex === -1) {
    return null;
  }
  const tableSource = line.slice(startIndex);
  const rows: string[][] = [];
  let current: string[] = [];
  for (const rawCell of tableSource.split('|')) {
    const cell = rawCell.trim();
    if (!cell) {
      if (current.length > 0) {
        rows.push(current);
        current = [];
      }
      continue;
    }
    current.push(cell);
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows.length >= 2 && isMarkdownTableSeparatorRow(rows[1]) ? { rows, startIndex } : null;
}
