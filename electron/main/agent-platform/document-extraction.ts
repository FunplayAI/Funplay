import { extname } from 'node:path';
import { listZipEntries, readZipEntryText } from '../zip-reader';

const DEFAULT_DOCUMENT_CHARS = 12_000;
const MAX_DOCUMENT_CHARS = 20_000;

export function normalizeDocumentMaxChars(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) {
    return DEFAULT_DOCUMENT_CHARS;
  }
  return Math.max(1000, Math.min(Math.floor(maxChars), MAX_DOCUMENT_CHARS));
}

export function normalizeExtractedText(value: string, maxChars: number): string {
  return value
    .replace(/\u0000/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars);
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function stripXmlToText(value: string, maxChars: number): string {
  const expanded = value
    .replace(/<\/(?:w:p|a:p|p|row|si|sst|slide)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeExtractedText(decodeXmlEntities(expanded), maxChars);
}

export function extractReadableBinaryText(bytes: Buffer, maxChars: number): string {
  const text = bytes.toString('latin1')
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]+/g, ' ')
    .replace(/\s{2,}/g, '\n');
  return normalizeExtractedText(text, maxChars);
}

export function decodePdfLiteral(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, char: string) => {
      if (char === 'n') return '\n';
      if (char === 'r') return '\r';
      if (char === 't') return '\t';
      if (char === 'b' || char === 'f') return ' ';
      return char;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function extractPdfLiteralText(source: string, maxChars: number): string {
  const literals = [...source.matchAll(/\((?:\\.|[^\\)]){2,}\)/g)]
    .map((match) => decodePdfLiteral(match[0]).replace(/\s+/g, ' ').trim())
    .filter((value) => /[A-Za-z0-9\u4e00-\u9fff]/.test(value) && value.length > 1);
  return normalizeExtractedText(literals.join('\n'), maxChars);
}

export interface PageSelection {
  label: string;
  ranges: Array<{
    start: number;
    end: number;
  }>;
}

export function parsePageSelection(pages?: string): PageSelection | undefined {
  const trimmed = pages?.trim();
  if (!trimmed) {
    return undefined;
  }
  const ranges = trimmed.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`);
    }
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (start < 1 || end < start) {
      throw new Error(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`);
    }
    return { start, end };
  });
  return {
    label: trimmed,
    ranges
  };
}

export function pageSelectionIncludes(selection: PageSelection | undefined, pageNumber: number): boolean {
  if (!selection) {
    return true;
  }
  return selection.ranges.some((range) => pageNumber >= range.start && pageNumber <= range.end);
}

export function selectIndexedPages(pages: string[], selection: PageSelection | undefined, maxChars: number): string {
  const selected = pages
    .map((text, index) => ({
      pageNumber: index + 1,
      text
    }))
    .filter((page) => pageSelectionIncludes(selection, page.pageNumber));
  return normalizeExtractedText(
    selected.map((page) => `## Page ${page.pageNumber}\n${page.text}`).join('\n\n') || '(no text in requested pages)',
    maxChars
  );
}

export function extractPdfText(bytes: Buffer, selection: PageSelection | undefined, maxChars: number): {
  text: string;
  pageCount?: number;
  extraction: string;
} {
  const source = bytes.toString('latin1');
  const pageSegments = source
    .split(/(?=\/Type\s*\/Page\b)/g)
    .filter((segment) => /\/Type\s*\/Page\b/.test(segment));
  if (pageSegments.length > 0) {
    const pageTexts = pageSegments.map((segment) => extractPdfLiteralText(segment, maxChars)).filter(Boolean);
    if (pageTexts.join('\n').length >= 60) {
      return {
        text: selectIndexedPages(pageTexts, selection, maxChars),
        pageCount: pageTexts.length,
        extraction: 'pdf-page-text'
      };
    }
  }
  const text = extractPdfLiteralText(source, maxChars);
  return {
    text: text || extractReadableBinaryText(bytes, maxChars),
    extraction: 'pdf-text'
  };
}

// Zip entry reading moved to the cross-platform zip-reader (yauzl) — the old
// spawn('unzip') failed on Windows. Re-exported here for existing importers.
export { listZipEntries, readZipEntryText };

export async function extractOfficeDocumentText(
  absolutePath: string,
  extension: string,
  selection: PageSelection | undefined,
  maxChars: number
): Promise<{
  text: string;
  pageCount?: number;
  extraction: string;
}> {
  if (extension === '.docx') {
    const xml = await readZipEntryText(absolutePath, 'word/document.xml');
    return {
      text: xml ? stripXmlToText(xml, maxChars) : '',
      extraction: 'docx-xml'
    };
  }

  if (extension === '.pptx') {
    const entries = (await listZipEntries(absolutePath))
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
      .sort((left, right) => Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0) - Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0));
    const slideTexts = await Promise.all(entries.map(async (entry) => stripXmlToText(await readZipEntryText(absolutePath, entry) ?? '', maxChars)));
    return {
      text: selectIndexedPages(slideTexts, selection, maxChars),
      pageCount: slideTexts.length,
      extraction: 'pptx-slides'
    };
  }

  if (extension === '.xlsx') {
    const entries = (await listZipEntries(absolutePath))
      .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))
      .sort((left, right) => Number(left.match(/sheet(\d+)\.xml$/i)?.[1] ?? 0) - Number(right.match(/sheet(\d+)\.xml$/i)?.[1] ?? 0));
    const sharedStrings = stripXmlToText(await readZipEntryText(absolutePath, 'xl/sharedStrings.xml') ?? '', maxChars);
    const sheetTexts = await Promise.all(entries.map(async (entry, index) => {
      const sheetText = stripXmlToText(await readZipEntryText(absolutePath, entry) ?? '', maxChars);
      return [`Sheet ${index + 1}`, sheetText].filter(Boolean).join('\n');
    }));
    return {
      text: normalizeExtractedText([sharedStrings ? `Shared strings:\n${sharedStrings}` : '', selectIndexedPages(sheetTexts, selection, maxChars)].filter(Boolean).join('\n\n'), maxChars),
      pageCount: sheetTexts.length,
      extraction: 'xlsx-sheets'
    };
  }

  return {
    text: '',
    extraction: 'zip-unsupported'
  };
}

export async function extractLocalDocumentText(
  absolutePath: string,
  relativePath: string,
  bytes: Buffer,
  options: {
    pages?: string;
    maxChars?: number;
  }
): Promise<{
  text: string;
  extraction: string;
  pageCount?: number;
  pages?: string;
}> {
  const maxChars = normalizeDocumentMaxChars(options.maxChars);
  const selection = parsePageSelection(options.pages);
  const extension = extname(relativePath).toLowerCase();
  const body = bytes.toString('utf8');
  if (extension === '.pdf') {
    const extracted = extractPdfText(bytes, selection, maxChars);
    return {
      ...extracted,
      pages: selection?.label
    };
  }
  if (extension === '.rtf') {
    const text = body
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'[0-9a-f]{2}/gi, ' ')
      .replace(/\\[a-z]+\d* ?/gi, '')
      .replace(/[{}]/g, ' ');
    return {
      text: normalizeExtractedText(text, maxChars),
      extraction: 'rtf-text',
      pages: selection?.label
    };
  }
  if (['.xml', '.svg', '.html', '.htm'].includes(extension)) {
    return {
      text: stripXmlToText(body, maxChars),
      extraction: 'markup-text',
      pages: selection?.label
    };
  }
  if (['.docx', '.pptx', '.xlsx'].includes(extension)) {
    const extracted = await extractOfficeDocumentText(absolutePath, extension, selection, maxChars);
    return {
      ...extracted,
      text: extracted.text || extractReadableBinaryText(bytes, maxChars),
      pages: selection?.label
    };
  }

  const textPages = body.split('\f');
  return {
    text: textPages.length > 1
      ? selectIndexedPages(textPages, selection, maxChars)
      : normalizeExtractedText(body, maxChars),
    pageCount: textPages.length > 1 ? textPages.length : undefined,
    extraction: textPages.length > 1 ? 'text-pages' : 'plain-text',
    pages: selection?.label
  };
}
