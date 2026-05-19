import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PDF_RENDER_TIMEOUT_MS = 12_000;
const QUICKLOOK_TIMEOUT_MS = 6_000;

interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface PdfPreviewRenderInput {
  absolutePath: string;
}

export interface PdfPreviewRenderResult {
  thumbnailDataUrl?: string;
  extraction: string;
  warning?: string;
}

const executableCache = new Map<string, string | undefined>();

export async function renderPdfPreviewThumbnail(input: PdfPreviewRenderInput): Promise<PdfPreviewRenderResult> {
  const workDir = await mkdtemp(join(tmpdir(), 'funplay-pdf-preview-'));
  try {
    const pdftoppmPath = await resolveExecutable('pdftoppm', getPdftoppmCandidates(), ['-h']);
    if (pdftoppmPath) {
      const thumbnailPath = await renderWithPdftoppm(pdftoppmPath, input.absolutePath, workDir);
      if (thumbnailPath) {
        return {
          thumbnailDataUrl: await readPngDataUrl(thumbnailPath),
          extraction: 'pdf-pdftoppm-thumbnail'
        };
      }
    }

    const quickLookPath = await resolveExecutable('qlmanage', getQuickLookCandidates(), ['-h']);
    if (quickLookPath && process.platform === 'darwin') {
      const thumbnailPath = await renderWithQuickLook(quickLookPath, input.absolutePath, workDir);
      if (thumbnailPath) {
        return {
          thumbnailDataUrl: await readPngDataUrl(thumbnailPath),
          extraction: 'pdf-quicklook-thumbnail'
        };
      }
    }

    return {
      extraction: 'pdf-browser',
      warning: '未找到可用的 PDF 缩略图渲染器，已回退到浏览器 PDF 预览。'
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function renderWithPdftoppm(pdftoppmPath: string, pdfPath: string, outputDir: string): Promise<string | undefined> {
  const outputPrefix = join(outputDir, 'page');
  const result = await runProcess(pdftoppmPath, [
    '-png',
    '-singlefile',
    '-r',
    '144',
    '-f',
    '1',
    '-l',
    '1',
    pdfPath,
    outputPrefix
  ], PDF_RENDER_TIMEOUT_MS);
  if (!result.ok) {
    return undefined;
  }
  return findNewestPng(outputDir);
}

async function renderWithQuickLook(qlmanagePath: string, pdfPath: string, outputDir: string): Promise<string | undefined> {
  const qlDir = join(outputDir, 'quicklook');
  await mkdir(qlDir, { recursive: true });
  const result = await runProcess(qlmanagePath, ['-t', '-s', '1200', '-o', qlDir, pdfPath], QUICKLOOK_TIMEOUT_MS);
  if (!result.ok) {
    return undefined;
  }
  const thumbnailPath = await findNewestPng(qlDir);
  if (!thumbnailPath) {
    return undefined;
  }
  const stablePath = join(outputDir, 'page.png');
  await copyFile(thumbnailPath, stablePath);
  return stablePath;
}

async function findNewestPng(outputDir: string): Promise<string | undefined> {
  const entries = await readdir(outputDir);
  const pngs: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.png')) {
      continue;
    }
    const filePath = join(outputDir, entry);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        pngs.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
      }
    } catch {
      // Ignore transient files from renderer tools.
    }
  }
  pngs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return pngs[0]?.path;
}

async function readPngDataUrl(path: string): Promise<string> {
  const data = await readFile(path);
  return `data:image/png;base64,${data.toString('base64')}`;
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      if (Buffer.concat(stdoutChunks).byteLength < 100_000) {
        stdoutChunks.push(data);
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (Buffer.concat(stderrChunks).byteLength < 100_000) {
        stderrChunks.push(data);
      }
    });
    child.on('error', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut
      });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: code === 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut
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

function getPdftoppmCandidates(): Array<string | undefined> {
  const runtimeRoots = getRuntimeRoots();
  return [
    process.env.FUNPLAY_PDFTOPPM_PATH,
    ...runtimeRoots.map((runtimeRoot) => join(runtimeRoot, 'poppler', 'bin', 'pdftoppm')),
    '/opt/homebrew/bin/pdftoppm',
    '/usr/local/bin/pdftoppm',
    'pdftoppm'
  ];
}

function getQuickLookCandidates(): Array<string | undefined> {
  return [
    '/usr/bin/qlmanage',
    'qlmanage'
  ];
}

function getRuntimeRoots(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    resourcesPath ? join(resourcesPath, 'runtime') : undefined,
    join(process.cwd(), 'resources', 'runtime')
  ].filter((item): item is string => Boolean(item));
}
