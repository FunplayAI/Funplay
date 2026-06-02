import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readZipEntryText } from './zip-reader';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CACHE_VERSION = 1;
const LIBREOFFICE_TIMEOUT_MS = 30_000;
const PDF_RENDER_TIMEOUT_MS = 25_000;
const QUICKLOOK_TIMEOUT_MS = 6_000;
const ZIP_UPDATE_TIMEOUT_MS = 5_000;
const ZIP_DELETE_TIMEOUT_MS = 3_000;

export type PptxPreviewRendererName = 'libreoffice-pdf' | 'quicklook-slide-swap';

export interface PptxPreviewFileStat {
  mtimeMs: number;
  size: number;
}

export interface PptxPreviewRenderInput {
  absolutePath: string;
  fileStat: PptxPreviewFileStat;
  slideEntries: string[];
  hasContentTypes: boolean;
}

export interface PptxPreviewRenderResult {
  thumbnails: Array<string | undefined>;
  extraction: string;
  cacheKey: string;
  warning?: string;
}

export interface PptxPreviewRenderAttempt {
  renderer: PptxPreviewRendererName;
  extraction: string;
  thumbnailPaths: Array<string | undefined>;
  warning?: string;
  cleanup: () => Promise<void>;
}

export interface PptxPreviewRenderer {
  readonly name: PptxPreviewRendererName;
  render(input: PptxPreviewRenderInput): Promise<PptxPreviewRenderAttempt | undefined>;
}

interface ProcessResult {
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface CacheManifest {
  version: number;
  source: {
    path: string;
    mtimeMs: number;
    size: number;
  };
  renderer: PptxPreviewRendererName;
  extraction: string;
  slideCount: number;
  thumbnails: Array<{
    index: number;
    fileName?: string;
  }>;
  createdAt: string;
}

let previewCacheRoot = join(tmpdir(), 'funplay-pptx-preview-cache');
const executableCache = new Map<string, string | undefined>();

export function initializePptxPreviewRenderer(userDataPath: string): void {
  previewCacheRoot = join(userDataPath, 'pptx-preview-cache');
}

export function buildPptxPreviewCacheKey(input: {
  absolutePath: string;
  fileStat: PptxPreviewFileStat;
}): string {
  const keyParts = [
    resolve(input.absolutePath),
    String(Math.trunc(input.fileStat.mtimeMs)),
    String(input.fileStat.size)
  ];
  return createHash('sha256').update(keyParts.join('\0')).digest('hex');
}

export async function renderPptxPreviewThumbnails(input: PptxPreviewRenderInput): Promise<PptxPreviewRenderResult> {
  const cacheKey = buildPptxPreviewCacheKey(input);
  const cacheDir = join(previewCacheRoot, cacheKey);
  const cached = await readCachedPreview(cacheDir, cacheKey, input);
  if (cached) {
    return cached;
  }

  if (!input.hasContentTypes || input.slideEntries.length === 0) {
    return {
      thumbnails: [],
      extraction: 'pptx-slide-text',
      cacheKey
    };
  }

  const renderers: PptxPreviewRenderer[] = [
    new LibreOfficePdfPptxPreviewRenderer(),
    new QuickLookPptxPreviewRenderer()
  ];
  const warnings: string[] = [];

  for (const renderer of renderers) {
    let attempt: PptxPreviewRenderAttempt | undefined;
    try {
      attempt = await renderer.render(input);
    } catch {
      warnings.push(`${renderer.name} PPTX 缩略图渲染失败。`);
      continue;
    }

    if (!attempt) {
      continue;
    }

    try {
      if (!attempt.thumbnailPaths.some(Boolean)) {
        if (attempt.warning) {
          warnings.push(attempt.warning);
        }
        continue;
      }

      try {
        await writeCachedPreview(cacheDir, cacheKey, input, attempt);
        const cachedAfterWrite = await readCachedPreview(cacheDir, cacheKey, input);
        if (cachedAfterWrite) {
          return {
            ...cachedAfterWrite,
            extraction: attempt.extraction,
            warning: [attempt.warning, ...warnings].filter(Boolean).join(' ') || undefined
          };
        }
      } catch {
        const thumbnails = await readThumbnailPaths(attempt.thumbnailPaths, input.slideEntries.length);
        if (thumbnails.some(Boolean)) {
          return {
            thumbnails,
            extraction: attempt.extraction,
            cacheKey,
            warning: [attempt.warning, 'PPTX 缩略图缓存写入失败，本次使用临时渲染结果。', ...warnings].filter(Boolean).join(' ')
          };
        }
      }

      const thumbnails = await readThumbnailPaths(attempt.thumbnailPaths, input.slideEntries.length);
      if (thumbnails.some(Boolean)) {
        return {
          thumbnails,
          extraction: attempt.extraction,
          cacheKey,
          warning: [attempt.warning, ...warnings].filter(Boolean).join(' ') || undefined
        };
      }
    } finally {
      await attempt.cleanup();
    }
  }

  return {
    thumbnails: [],
    extraction: 'pptx-slide-text',
    cacheKey,
    warning: warnings.join(' ') || undefined
  };
}

async function readThumbnailPaths(paths: Array<string | undefined>, maxSlides: number): Promise<Array<string | undefined>> {
  const thumbnails: Array<string | undefined> = [];
  for (let index = 0; index < maxSlides; index += 1) {
    const sourcePath = paths[index];
    if (!sourcePath) {
      thumbnails.push(undefined);
      continue;
    }

    try {
      const data = await readFile(sourcePath);
      thumbnails.push(`data:image/png;base64,${data.toString('base64')}`);
    } catch {
      thumbnails.push(undefined);
    }
  }
  return thumbnails;
}

async function readCachedPreview(
  cacheDir: string,
  cacheKey: string,
  input: PptxPreviewRenderInput
): Promise<PptxPreviewRenderResult | undefined> {
  const manifest = await readCacheManifest(cacheDir);
  if (!manifest || manifest.version !== CACHE_VERSION) {
    return undefined;
  }

  const sourcePath = resolve(input.absolutePath);
  if (
    manifest.source.path !== sourcePath ||
    manifest.source.mtimeMs !== Math.trunc(input.fileStat.mtimeMs) ||
    manifest.source.size !== input.fileStat.size ||
    manifest.thumbnails.length < input.slideEntries.length
  ) {
    return undefined;
  }

  const thumbnails: Array<string | undefined> = [];
  for (let index = 0; index < input.slideEntries.length; index += 1) {
    const cachedThumbnail = manifest.thumbnails[index];
    if (!cachedThumbnail?.fileName) {
      thumbnails.push(undefined);
      continue;
    }

    try {
      const data = await readFile(join(cacheDir, cachedThumbnail.fileName));
      thumbnails.push(`data:image/png;base64,${data.toString('base64')}`);
    } catch {
      return undefined;
    }
  }

  if (!thumbnails.some(Boolean)) {
    return undefined;
  }

  return {
    thumbnails,
    extraction: `${manifest.extraction}-cached`,
    cacheKey
  };
}

async function readCacheManifest(cacheDir: string): Promise<CacheManifest | undefined> {
  try {
    const raw = await readFile(join(cacheDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as CacheManifest;
    if (!parsed || !Array.isArray(parsed.thumbnails)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCachedPreview(
  cacheDir: string,
  cacheKey: string,
  input: PptxPreviewRenderInput,
  attempt: PptxPreviewRenderAttempt
): Promise<void> {
  const stagingDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const thumbnails: CacheManifest['thumbnails'] = [];
  for (let index = 0; index < input.slideEntries.length; index += 1) {
    const sourcePath = attempt.thumbnailPaths[index];
    if (!sourcePath) {
      thumbnails.push({ index: index + 1 });
      continue;
    }

    const fileName = `slide-${index + 1}.png`;
    await copyFile(sourcePath, join(stagingDir, fileName));
    thumbnails.push({ index: index + 1, fileName });
  }

  const manifest: CacheManifest = {
    version: CACHE_VERSION,
    source: {
      path: resolve(input.absolutePath),
      mtimeMs: Math.trunc(input.fileStat.mtimeMs),
      size: input.fileStat.size
    },
    renderer: attempt.renderer,
    extraction: attempt.extraction,
    slideCount: input.slideEntries.length,
    thumbnails,
    createdAt: new Date().toISOString()
  };
  await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(dirname(cacheDir), { recursive: true });
  await rm(join(dirname(cacheDir), `${cacheKey}.old`), { recursive: true, force: true });
  await copyDirectory(stagingDir, cacheDir);
  await rm(stagingDir, { recursive: true, force: true });
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

class LibreOfficePdfPptxPreviewRenderer implements PptxPreviewRenderer {
  readonly name = 'libreoffice-pdf' as const;

  async render(input: PptxPreviewRenderInput): Promise<PptxPreviewRenderAttempt | undefined> {
    const sofficePath = await resolveExecutable('libreoffice', getLibreOfficeCandidates(), ['--version']);
    const pdfRenderer = await resolvePdfRenderer();
    if (!sofficePath || !pdfRenderer) {
      return undefined;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'funplay-pptx-libreoffice-'));
    const pdfDir = join(workDir, 'pdf');
    const profileDir = join(workDir, 'profile');
    const pngDir = join(workDir, 'png');
    await mkdir(pdfDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await mkdir(pngDir, { recursive: true });

    const conversion = await runProcess(sofficePath, [
      '--headless',
      '--invisible',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      pdfDir,
      input.absolutePath
    ], LIBREOFFICE_TIMEOUT_MS);
    if (!conversion.ok) {
      await rm(workDir, { recursive: true, force: true });
      return {
        renderer: this.name,
        extraction: 'pptx-libreoffice-pdf-thumbnails',
        thumbnailPaths: [],
        warning: `LibreOffice PPTX 渲染失败${conversion.timedOut ? '：转换超时。' : '。'}`,
        cleanup: async () => {}
      };
    }

    const pdfPath = await findConvertedPdf(pdfDir, input.absolutePath);
    if (!pdfPath) {
      await rm(workDir, { recursive: true, force: true });
      return {
        renderer: this.name,
        extraction: 'pptx-libreoffice-pdf-thumbnails',
        thumbnailPaths: [],
        warning: 'LibreOffice 没有产出可用于缩略图的 PDF。',
        cleanup: async () => {}
      };
    }

    const thumbnailPaths = pdfRenderer.kind === 'pdftoppm'
      ? await renderPdfWithPdftoppm(pdfRenderer.path, pdfPath, pngDir, input.slideEntries.length)
      : await renderPdfWithImageMagick(pdfRenderer.path, pdfRenderer.kind, pdfPath, pngDir, input.slideEntries.length);

    return {
      renderer: this.name,
      extraction: 'pptx-libreoffice-pdf-thumbnails',
      thumbnailPaths,
      cleanup: async () => {
        await rm(workDir, { recursive: true, force: true });
      }
    };
  }
}

class QuickLookPptxPreviewRenderer implements PptxPreviewRenderer {
  readonly name = 'quicklook-slide-swap' as const;

  async render(input: PptxPreviewRenderInput): Promise<PptxPreviewRenderAttempt | undefined> {
    if (process.platform !== 'darwin') {
      return undefined;
    }

    const qlmanagePath = await resolveExecutable('qlmanage', ['/usr/bin/qlmanage', 'qlmanage'], ['-h']);
    if (!qlmanagePath) {
      return undefined;
    }

    const zipPath = await resolveExecutable('zip', ['/usr/bin/zip', 'zip'], ['-h']);
    const workDir = await mkdtemp(join(tmpdir(), 'funplay-pptx-quicklook-'));
    const outputDir = join(workDir, 'out');
    await mkdir(outputDir, { recursive: true });

    const firstThumbnail = await createQuickLookThumbnailFile(qlmanagePath, input.absolutePath, outputDir, 1);
    if (!firstThumbnail) {
      await rm(workDir, { recursive: true, force: true });
      return undefined;
    }

    const thumbnailPaths: Array<string | undefined> = [firstThumbnail];
    if (!zipPath) {
      return {
        renderer: this.name,
        extraction: 'pptx-quicklook-thumbnails',
        thumbnailPaths,
        warning: '未找到 zip，可先预览第 1 张幻灯片缩略图。',
        cleanup: async () => {
          await rm(workDir, { recursive: true, force: true });
        }
      };
    }

    for (let index = 1; index < input.slideEntries.length; index += 1) {
      const slideEntry = input.slideEntries[index];
      const slideXml = await readZipEntryText(input.absolutePath, slideEntry);
      if (!slideXml) {
        thumbnailPaths.push(undefined);
        continue;
      }

      const tempDeckPath = join(workDir, `slide-${index + 1}.pptx`);
      const stagingDir = join(workDir, `stage-${index + 1}`);
      await copyFile(input.absolutePath, tempDeckPath);
      await writeStagedZipEntry(stagingDir, 'ppt/slides/slide1.xml', slideXml);

      const sourceRels = await readZipEntryText(input.absolutePath, resolveSlideRelationshipEntry(slideEntry));
      if (sourceRels) {
        await writeStagedZipEntry(stagingDir, 'ppt/slides/_rels/slide1.xml.rels', sourceRels);
      } else {
        await runProcess(zipPath, ['-q', '-d', tempDeckPath, 'ppt/slides/_rels/slide1.xml.rels'], ZIP_DELETE_TIMEOUT_MS);
      }

      const zipEntries = ['ppt/slides/slide1.xml'];
      if (sourceRels) {
        zipEntries.push('ppt/slides/_rels/slide1.xml.rels');
      }

      const updated = await runProcess(zipPath, ['-q', tempDeckPath, ...zipEntries], ZIP_UPDATE_TIMEOUT_MS, stagingDir);
      thumbnailPaths.push(updated.ok ? await createQuickLookThumbnailFile(qlmanagePath, tempDeckPath, outputDir, index + 1) : undefined);
    }

    return {
      renderer: this.name,
      extraction: 'pptx-quicklook-thumbnails',
      thumbnailPaths,
      cleanup: async () => {
        await rm(workDir, { recursive: true, force: true });
      }
    };
  }
}

async function renderPdfWithPdftoppm(
  pdftoppmPath: string,
  pdfPath: string,
  outputDir: string,
  maxSlides: number
): Promise<Array<string | undefined>> {
  const prefix = join(outputDir, 'slide');
  const result = await runProcess(pdftoppmPath, [
    '-png',
    '-r',
    '144',
    '-f',
    '1',
    '-l',
    String(maxSlides),
    pdfPath,
    prefix
  ], PDF_RENDER_TIMEOUT_MS);
  return result.ok ? await collectNumberedPngs(outputDir, maxSlides) : [];
}

async function renderPdfWithImageMagick(
  commandPath: string,
  kind: 'magick' | 'convert',
  pdfPath: string,
  outputDir: string,
  maxSlides: number
): Promise<Array<string | undefined>> {
  const outputPattern = join(outputDir, 'slide-%d.png');
  const pageRange = `${pdfPath}[0-${Math.max(0, maxSlides - 1)}]`;
  const args = [
    '-density',
    '144',
    pageRange,
    '-resize',
    '900x',
    '-background',
    'white',
    '-alpha',
    'remove',
    '-alpha',
    'off',
    outputPattern
  ];
  const result = await runProcess(commandPath, kind === 'magick' ? args : args, PDF_RENDER_TIMEOUT_MS);
  return result.ok ? await collectNumberedPngs(outputDir, maxSlides) : [];
}

async function collectNumberedPngs(outputDir: string, maxSlides: number): Promise<Array<string | undefined>> {
  const files = await readdir(outputDir);
  const numbered = files
    .map((file) => {
      const matched = file.match(/(?:^|[-_])(\d+)\.png$/i);
      return matched ? { file, number: Number(matched[1]) } : undefined;
    })
    .filter((item): item is { file: string; number: number } => Boolean(item))
    .sort((left, right) => left.number - right.number);

  const startsAtZero = numbered.some((item) => item.number === 0);
  const byPage = new Map<number, string>();
  for (const item of numbered) {
    const pageNumber = startsAtZero ? item.number + 1 : item.number;
    if (!byPage.has(pageNumber)) {
      byPage.set(pageNumber, join(outputDir, item.file));
    }
  }

  return Array.from({ length: maxSlides }, (_, index) => byPage.get(index + 1));
}

async function findConvertedPdf(pdfDir: string, sourcePath: string): Promise<string | undefined> {
  const expectedBase = basename(sourcePath).replace(/\.[^.]+$/i, '.pdf');
  const expectedPath = join(pdfDir, expectedBase);
  try {
    const fileStat = await stat(expectedPath);
    if (fileStat.isFile()) {
      return expectedPath;
    }
  } catch {
    // Fall through to scanning the output directory.
  }

  const files = await readdir(pdfDir);
  const pdfFile = files.find((file) => file.toLowerCase().endsWith('.pdf'));
  return pdfFile ? join(pdfDir, pdfFile) : undefined;
}

async function createQuickLookThumbnailFile(
  qlmanagePath: string,
  absolutePath: string,
  outputDir: string,
  slideIndex: number
): Promise<string | undefined> {
  const quickLookOutputDir = await mkdtemp(join(tmpdir(), 'funplay-pptx-ql-'));
  try {
    const ok = await runProcess(qlmanagePath, ['-t', '-s', '900', '-o', quickLookOutputDir, absolutePath], QUICKLOOK_TIMEOUT_MS);
    if (!ok.ok) {
      return undefined;
    }

    const files = await readdir(quickLookOutputDir);
    const thumbnail = files.find((file) => file.toLowerCase().endsWith('.png'));
    if (!thumbnail) {
      return undefined;
    }

    const targetPath = join(outputDir, `slide-${slideIndex}.png`);
    await copyFile(join(quickLookOutputDir, thumbnail), targetPath);
    return targetPath;
  } finally {
    await rm(quickLookOutputDir, { recursive: true, force: true });
  }
}

async function runProcess(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<ProcessResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      if (Buffer.concat(stdoutChunks).byteLength < 200_000) {
        stdoutChunks.push(data);
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (Buffer.concat(stderrChunks).byteLength < 200_000) {
        stderrChunks.push(data);
      }
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: false,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: code === 0,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
}

async function resolveExecutable(
  cacheKey: string,
  candidates: Array<string | undefined>,
  probeArgs: string[]
): Promise<string | undefined> {
  const cached = executableCache.get(cacheKey);
  if (cached !== undefined || executableCache.has(cacheKey)) {
    return cached;
  }

  for (const candidate of candidates.filter((item): item is string => Boolean(item))) {
    if (candidate.includes('/')) {
      try {
        await access(candidate);
        executableCache.set(cacheKey, candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    const probe = await runProcess(candidate, probeArgs, 1500);
    if (probe.ok || probe.stdout || probe.stderr) {
      executableCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  executableCache.set(cacheKey, undefined);
  return undefined;
}

async function resolvePdfRenderer(): Promise<
  | { kind: 'pdftoppm'; path: string }
  | { kind: 'magick'; path: string }
  | { kind: 'convert'; path: string }
  | undefined
> {
  const pdftoppm = await resolveExecutable('pdftoppm', getPdftoppmCandidates(), ['-h']);
  if (pdftoppm) {
    return { kind: 'pdftoppm', path: pdftoppm };
  }

  const magick = await resolveExecutable('magick', getMagickCandidates(), ['-version']);
  if (magick) {
    return { kind: 'magick', path: magick };
  }

  const convert = await resolveExecutable('convert', getConvertCandidates(), ['-version']);
  return convert ? { kind: 'convert', path: convert } : undefined;
}

function getLibreOfficeCandidates(): Array<string | undefined> {
  const runtimeRoots = getRuntimeRoots();
  return [
    process.env.FUNPLAY_LIBREOFFICE_PATH,
    ...runtimeRoots.flatMap((runtimeRoot) => [
      join(runtimeRoot, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
      join(runtimeRoot, 'LibreOffice', 'program', 'soffice')
    ]),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'soffice',
    'libreoffice'
  ];
}

function getPdftoppmCandidates(): Array<string | undefined> {
  const runtimeRoots = getRuntimeRoots();
  return [
    process.env.FUNPLAY_PDFTOPPM_PATH,
    ...runtimeRoots.map((runtimeRoot) => join(runtimeRoot, 'poppler', 'bin', 'pdftoppm')),
    'pdftoppm'
  ];
}

function getMagickCandidates(): Array<string | undefined> {
  const runtimeRoots = getRuntimeRoots();
  return [
    process.env.FUNPLAY_MAGICK_PATH,
    ...runtimeRoots.map((runtimeRoot) => join(runtimeRoot, 'ImageMagick', 'bin', 'magick')),
    'magick'
  ];
}

function getConvertCandidates(): Array<string | undefined> {
  const runtimeRoots = getRuntimeRoots();
  return [
    process.env.FUNPLAY_CONVERT_PATH,
    ...runtimeRoots.map((runtimeRoot) => join(runtimeRoot, 'ImageMagick', 'bin', 'convert')),
    'convert'
  ];
}

function getRuntimeRoots(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    resourcesPath ? join(resourcesPath, 'runtime') : undefined,
    join(process.cwd(), 'resources', 'runtime')
  ].filter((item): item is string => Boolean(item));
}

// readZipEntryText comes from the cross-platform zip-reader (imported above);
// the old spawn('unzip') failed on Windows.

function resolveSlideRelationshipEntry(slideEntry: string): string {
  return slideEntry.replace(/^ppt\/slides\//i, 'ppt/slides/_rels/').replace(/\.xml$/i, '.xml.rels');
}

async function writeStagedZipEntry(root: string, entry: string, content: string): Promise<void> {
  const targetPath = join(root, entry);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
}
