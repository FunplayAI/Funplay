import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { logEngineDebug, logEngineWarn } from './engine-log';

// Unlike Cocos (a source toolchain that must be cloned + built), Godot ships as a
// single self-contained binary per platform — no installer, no dependencies. So a
// "guided install" here means: resolve the latest stable release, download the
// official zip, extract it into a Funplay-managed directory, and remember the
// binary. This module owns that managed location, detection, and the staged install.
const GODOT_RELEASES_API = 'https://api.github.com/repos/godotengine/godot/releases/latest';
// Fallback pin used only when the GitHub API is unreachable; the standard 4.x asset
// naming is stable, so a constructed URL still resolves.
const GODOT_FALLBACK_VERSION = '4.3';
const MAX_DOWNLOAD_ATTEMPTS = 3;

export interface GodotManagedInstallation {
  dir: string;
  executablePath: string;
  version?: string;
}

// Where Funplay keeps its managed Godot editor. Overridable via GODOT_MANAGED_DIR
// so a test (or a user who placed Godot elsewhere) can redirect it.
export function getGodotManagedDir(userDataPath: string): string {
  const override = process.env.GODOT_MANAGED_DIR?.trim();
  return override || join(userDataPath, 'godot-editor');
}

function parseVersionFromName(name: string): string | undefined {
  const match = name.match(/v?(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1];
}

// Locate the launchable binary inside an extracted Godot payload, per platform:
// macOS → Godot.app/Contents/MacOS/Godot; Windows → Godot*.exe; Linux → the
// Godot* executable file. Returns undefined when nothing usable is present.
function scanForGodotBinary(dir: string): { executablePath: string; version?: string } | undefined {
  if (!existsSync(dir)) {
    return undefined;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (process.platform === 'darwin') {
    const app = entries.find((entry) => entry.endsWith('.app') && !/mono|dotnet/i.test(entry));
    if (app) {
      const executablePath = join(dir, app, 'Contents', 'MacOS', 'Godot');
      if (existsSync(executablePath)) {
        return { executablePath, version: parseVersionFromName(app) };
      }
    }
    return undefined;
  }
  if (process.platform === 'win32') {
    const exe = entries.find((entry) => /godot/i.test(entry) && entry.toLowerCase().endsWith('.exe'));
    return exe ? { executablePath: join(dir, exe), version: parseVersionFromName(exe) } : undefined;
  }
  // Linux (and any other unix): the asset extracts to a single executable file.
  const bin = entries.find((entry) => {
    if (!/godot/i.test(entry)) {
      return false;
    }
    try {
      return statSync(join(dir, entry)).isFile();
    } catch {
      return false;
    }
  });
  return bin ? { executablePath: join(dir, bin), version: parseVersionFromName(bin) } : undefined;
}

export function findManagedGodotInstallation(userDataPath: string): GodotManagedInstallation | undefined {
  const dir = getGodotManagedDir(userDataPath);
  const found = scanForGodotBinary(dir);
  return found ? { dir, executablePath: found.executablePath, version: found.version } : undefined;
}

export type GodotInstallStageId = 'checking' | 'downloading' | 'installing' | 'validating';

export interface GodotReleaseAsset {
  tag: string;
  assetName: string;
  downloadUrl: string;
}

export interface GodotInstallResult {
  ok: boolean;
  message: string;
  executablePath?: string;
  version?: string;
}

// Injectable seams so tests can drive the orchestration without hitting the
// network or shelling out to unzip. Defaults perform the real work.
export interface GodotInstallHooks {
  resolveAsset?: (platform: NodeJS.Platform, arch: string) => Promise<GodotReleaseAsset>;
  download?: (url: string, destZip: string, onProgress: (fraction: number) => void) => Promise<void>;
  extract?: (zipPath: string, destDir: string) => Promise<void>;
}

function assetPatternFor(platform: NodeJS.Platform, arch: string): RegExp {
  if (platform === 'darwin') {
    return /macos\.universal\.zip$/i;
  }
  if (platform === 'win32') {
    return arch === 'arm64' ? /win(dows)?[._]arm64.*\.zip$/i : /win64\.exe\.zip$/i;
  }
  return arch === 'arm64' ? /linux\.arm64\.zip$/i : /linux\.x86_64\.zip$/i;
}

async function resolveLatestGodotAsset(platform: NodeJS.Platform, arch: string): Promise<GodotReleaseAsset> {
  const pattern = assetPatternFor(platform, arch);
  // mono/dotnet builds carry the C# runtime and a different layout — keep the
  // smaller GDScript build for the default managed install.
  const excludeMono = /mono|dotnet|csharp/i;
  try {
    const response = await fetch(GODOT_RELEASES_API, {
      headers: { 'User-Agent': 'Funplay', Accept: 'application/vnd.github+json' }
    });
    if (response.ok) {
      const release = (await response.json()) as {
        tag_name?: string;
        assets?: Array<{ name?: string; browser_download_url?: string }>;
      };
      const tag = release.tag_name?.trim() || `${GODOT_FALLBACK_VERSION}-stable`;
      const asset = (release.assets ?? []).find(
        (candidate) =>
          typeof candidate.name === 'string' &&
          pattern.test(candidate.name) &&
          !excludeMono.test(candidate.name) &&
          typeof candidate.browser_download_url === 'string'
      );
      if (asset?.name && asset.browser_download_url) {
        return { tag, assetName: asset.name, downloadUrl: asset.browser_download_url };
      }
    } else {
      logEngineWarn('godot', `release API responded ${response.status}; using fallback version`);
    }
  } catch (error) {
    logEngineWarn('godot', 'release API unreachable; using fallback version', error);
  }
  // Constructed fallback from the stable 4.x naming convention.
  const tag = `${GODOT_FALLBACK_VERSION}-stable`;
  const assetName =
    platform === 'darwin'
      ? `Godot_v${tag}_macos.universal.zip`
      : platform === 'win32'
        ? `Godot_v${tag}_win64.exe.zip`
        : `Godot_v${tag}_linux.x86_64.zip`;
  return {
    tag,
    assetName,
    downloadUrl: `https://github.com/godotengine/godot/releases/download/${tag}/${assetName}`
  };
}

async function defaultDownload(url: string, destZip: string, onProgress: (fraction: number) => void): Promise<void> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Funplay' }, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      onProgress(Math.min(1, received / total));
    }
  });
  await pipeline(source, createWriteStream(destZip));
}

function defaultExtract(zipPath: string, destDir: string): Promise<void> {
  // bsdtar (macOS/Windows) and unzip (Linux) both handle .zip; pick what each
  // platform reliably ships. tar -xf on Windows 10+ uses bundled bsdtar.
  const command = process.platform === 'win32' ? 'tar' : 'unzip';
  const args = process.platform === 'win32' ? ['-xf', zipPath, '-C', destDir] : ['-o', zipPath, '-d', destDir];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-1500);
    });
    child.on('error', (error) => reject(error));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（${command} 退出码 ${code}）：${stderrTail}`))));
  });
}

// macOS quarantines anything downloaded from the internet; strip it so the
// managed editor launches without a Gatekeeper block. Best-effort.
function stripQuarantine(targetPath: string): void {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', targetPath], { timeout: 8000 });
  } catch (error) {
    logEngineDebug('godot', 'quarantine strip skipped', error);
  }
}

function probeVersion(executablePath: string): string | undefined {
  try {
    const out = execFileSync(executablePath, ['--version', '--headless'], { encoding: 'utf8', timeout: 8000 }).trim();
    return out.split('\n')[0]?.trim() || undefined;
  } catch (error) {
    // A failed probe (Gatekeeper, headless display) does not invalidate the
    // install — the binary exists and is executable, which is the success bar.
    logEngineDebug('godot', 'version probe failed (non-fatal)', error);
    return undefined;
  }
}

// The staged install: resolve latest stable → download zip → extract → locate +
// mark the binary executable → probe. Each stage reports progress; callers run
// this as a background task (the download is ~80-120MB).
export async function installGodotEditor(options: {
  userDataPath: string;
  onStage: (stage: GodotInstallStageId, progress: number, message: string) => void;
  hooks?: GodotInstallHooks;
}): Promise<GodotInstallResult> {
  const { userDataPath, onStage } = options;
  const resolveAsset = options.hooks?.resolveAsset ?? resolveLatestGodotAsset;
  const download = options.hooks?.download ?? defaultDownload;
  const extract = options.hooks?.extract ?? defaultExtract;
  const dir = getGodotManagedDir(userDataPath);

  onStage('checking', 5, '正在检查已安装的 Godot…');
  const existing = findManagedGodotInstallation(userDataPath);
  if (existing) {
    onStage('validating', 100, 'Godot 已安装。');
    return { ok: true, message: `Godot 已安装：${existing.executablePath}`, executablePath: existing.executablePath, version: existing.version };
  }

  onStage('checking', 12, '正在解析最新稳定版 Godot 下载地址…');
  let asset: GodotReleaseAsset;
  try {
    asset = await resolveAsset(process.platform, process.arch);
  } catch (error) {
    return { ok: false, message: `无法解析 Godot 下载地址：${error instanceof Error ? error.message : String(error)}` };
  }

  // Reset the managed dir to a clean slate so a previous partial attempt cannot
  // leave a half-extracted payload that confuses detection.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logEngineDebug('godot', 'managed dir cleanup skipped', error);
  }
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, asset.assetName);

  let downloaded = false;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS && !downloaded; attempt += 1) {
    try {
      onStage('downloading', 15, attempt === 1 ? `正在下载 ${asset.tag}…` : `正在重试下载 ${asset.tag}（${attempt}/${MAX_DOWNLOAD_ATTEMPTS}）…`);
      await download(asset.downloadUrl, zipPath, (fraction) => {
        onStage('downloading', 15 + Math.round(fraction * 60), `正在下载 Godot ${asset.tag}…（${Math.round(fraction * 100)}%）`);
      });
      downloaded = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logEngineWarn('godot', `download attempt ${attempt} failed`, error);
      try {
        rmSync(zipPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  if (!downloaded) {
    return { ok: false, message: `下载 Godot 失败（已重试 ${MAX_DOWNLOAD_ATTEMPTS} 次）：${lastError}` };
  }

  onStage('installing', 80, '正在解压 Godot…');
  try {
    await extract(zipPath, dir);
  } catch (error) {
    return { ok: false, message: `解压 Godot 失败：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    rmSync(zipPath, { force: true });
  } catch {
    /* keep going — a leftover zip is harmless */
  }

  onStage('validating', 88, '正在校验 Godot 可执行文件…');
  const located = scanForGodotBinary(dir);
  if (!located) {
    return { ok: false, message: '解压完成，但未在产物中找到 Godot 可执行文件。' };
  }
  try {
    chmodSync(located.executablePath, 0o755);
  } catch (error) {
    logEngineDebug('godot', 'chmod skipped', error);
  }
  // The .app bundle (macOS) needs quarantine stripped at the bundle root.
  stripQuarantine(process.platform === 'darwin' ? join(dir, readdirSync(dir).find((e) => e.endsWith('.app')) ?? '') : located.executablePath);

  onStage('validating', 95, '正在确认 Godot 版本…');
  const version = located.version ?? probeVersion(located.executablePath);
  onStage('validating', 100, `Godot 已安装：${asset.tag}`);
  return {
    ok: true,
    message: `Godot ${asset.tag} 已安装到 ${dir}`,
    executablePath: located.executablePath,
    version
  };
}
