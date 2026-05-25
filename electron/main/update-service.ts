import { app } from 'electron';
import { createRequire } from 'node:module';
import type {
  AppUpdater,
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo
} from 'electron-updater';
import type {
  AppUpdateInfo,
  AppUpdateProgress,
  AppUpdateSnapshot,
  AppUpdateStatus
} from '../../shared/types';

const nodeRequire = createRequire(import.meta.url);
const { autoUpdater } = nodeRequire('electron-updater') as { autoUpdater: AppUpdater };

type UpdateStatusDispatch = (snapshot: AppUpdateSnapshot) => void;
type UpdateNotificationDispatch = (input: { title: string; body: string; priority?: 'low' | 'normal' | 'urgent' }) => void | Promise<void>;

const supportedPlatforms = new Set<NodeJS.Platform>(['darwin', 'win32', 'linux']);
export const APP_UPDATE_STARTUP_CHECK_DELAY_MS = 8000;
export const APP_UPDATE_PERIODIC_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 6;

let dispatchStatus: UpdateStatusDispatch | undefined;
let dispatchNotification: UpdateNotificationDispatch | undefined;
let initialized = false;
let startupCheckScheduled = false;
let periodicUpdateCheckTimer: NodeJS.Timeout | undefined;
let lastNotifiedKey = '';
let lastUpdateInfo: AppUpdateInfo | undefined;
let currentSnapshot: AppUpdateSnapshot = createSnapshot(resolveInitialStatus());

export function initializeAppUpdateService(options: {
  dispatchStatus: UpdateStatusDispatch;
  notify?: UpdateNotificationDispatch;
}): void {
  dispatchStatus = options.dispatchStatus;
  dispatchNotification = options.notify;

  if (initialized) {
    emitStatus();
    return;
  }
  initialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.logger = {
    info: (...args: unknown[]) => console.info('[updates]', ...args),
    warn: (...args: unknown[]) => console.warn('[updates]', ...args),
    error: (...args: unknown[]) => console.error('[updates]', ...args),
    debug: (...args: unknown[]) => console.debug('[updates]', ...args)
  };

  autoUpdater.on('checking-for-update', () => {
    updateSnapshot({
      status: 'checking',
      error: undefined,
      lastCheckedAt: new Date().toISOString()
    });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    lastUpdateInfo = normalizeUpdateInfo(info);
    updateSnapshot({
      status: 'available',
      updateInfo: lastUpdateInfo,
      progress: undefined,
      error: undefined,
      lastCheckedAt: new Date().toISOString()
    });
    notifyOnce(`available:${lastUpdateInfo.version}`, {
      title: 'Funplay 有可用更新',
      body: `发现新版本 ${lastUpdateInfo.version}，可在“设置 > 关于”中下载。`,
      priority: 'normal'
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    lastUpdateInfo = normalizeUpdateInfo(info);
    updateSnapshot({
      status: 'not_available',
      updateInfo: lastUpdateInfo,
      progress: undefined,
      error: undefined,
      lastCheckedAt: new Date().toISOString()
    });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    updateSnapshot({
      status: 'downloading',
      progress: normalizeProgress(progress),
      error: undefined
    });
  });

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    lastUpdateInfo = normalizeUpdateInfo(event);
    updateSnapshot({
      status: 'downloaded',
      updateInfo: lastUpdateInfo,
      progress: undefined,
      error: undefined
    });
    notifyOnce(`downloaded:${lastUpdateInfo.version}`, {
      title: 'Funplay 更新已下载',
      body: `版本 ${lastUpdateInfo.version} 已准备好，重启应用即可安装。`,
      priority: 'normal'
    });
  });

  autoUpdater.on('update-cancelled', (info: UpdateInfo) => {
    lastUpdateInfo = normalizeUpdateInfo(info);
    updateSnapshot({
      status: 'available',
      updateInfo: lastUpdateInfo,
      progress: undefined,
      error: '更新下载已取消。'
    });
  });

  autoUpdater.on('error', (error: Error) => {
    updateSnapshot({
      status: 'error',
      progress: undefined,
      error: redactUpdateError(error)
    });
  });

  currentSnapshot = createSnapshot(resolveInitialStatus(), {
    updateInfo: lastUpdateInfo
  });
  emitStatus();
}

export function getAppUpdateStatus(): AppUpdateSnapshot {
  return createSnapshot(currentSnapshot.status, {
    updateInfo: currentSnapshot.updateInfo,
    progress: currentSnapshot.progress,
    error: currentSnapshot.error,
    lastCheckedAt: currentSnapshot.lastCheckedAt
  });
}

export async function checkForAppUpdates(): Promise<AppUpdateSnapshot> {
  if (!canCheckForUpdates()) {
    updateSnapshot({
      status: resolveInitialStatus(),
      error: buildNotConfiguredMessage()
    });
    return getAppUpdateStatus();
  }

  try {
    updateSnapshot({
      status: 'checking',
      error: undefined,
      progress: undefined,
      lastCheckedAt: new Date().toISOString()
    });
    await autoUpdater.checkForUpdates();
    return getAppUpdateStatus();
  } catch (error) {
    updateSnapshot({
      status: 'error',
      progress: undefined,
      error: redactUpdateError(error)
    });
    return getAppUpdateStatus();
  }
}

export async function downloadAppUpdate(): Promise<AppUpdateSnapshot> {
  if (!lastUpdateInfo && currentSnapshot.status !== 'available') {
    await checkForAppUpdates();
  }

  if (!lastUpdateInfo) {
    updateSnapshot({
      status: 'error',
      error: '当前没有可下载的更新。'
    });
    return getAppUpdateStatus();
  }

  try {
    updateSnapshot({
      status: 'downloading',
      error: undefined,
      progress: currentSnapshot.progress
    });
    await autoUpdater.downloadUpdate();
    return getAppUpdateStatus();
  } catch (error) {
    updateSnapshot({
      status: 'error',
      progress: undefined,
      error: redactUpdateError(error)
    });
    return getAppUpdateStatus();
  }
}

export async function installAppUpdate(): Promise<AppUpdateSnapshot> {
  if (currentSnapshot.status !== 'downloaded') {
    updateSnapshot({
      status: 'error',
      error: '更新尚未下载完成，无法安装。'
    });
    return getAppUpdateStatus();
  }

  updateSnapshot({
    status: 'installing',
    error: undefined
  });
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return getAppUpdateStatus();
}

export function scheduleStartupUpdateCheck(): void {
  if (startupCheckScheduled) {
    return;
  }
  startupCheckScheduled = true;

  if (!canCheckForUpdates()) {
    updateSnapshot({
      status: resolveInitialStatus(),
      error: undefined
    });
    return;
  }

  setTimeout(() => {
    void checkForAppUpdates();
  }, APP_UPDATE_STARTUP_CHECK_DELAY_MS);

  if (!periodicUpdateCheckTimer) {
    periodicUpdateCheckTimer = setInterval(() => {
      if (shouldSkipAutomaticCheck()) {
        return;
      }
      void checkForAppUpdates();
    }, APP_UPDATE_PERIODIC_CHECK_INTERVAL_MS);
    periodicUpdateCheckTimer.unref?.();
  }
}

function updateSnapshot(input: Partial<AppUpdateSnapshot> & { status: AppUpdateStatus }): void {
  currentSnapshot = createSnapshot(input.status, {
    updateInfo: input.updateInfo ?? currentSnapshot.updateInfo,
    progress: input.progress,
    error: input.error,
    lastCheckedAt: input.lastCheckedAt ?? currentSnapshot.lastCheckedAt
  });
  emitStatus();
}

function emitStatus(): void {
  dispatchStatus?.(getAppUpdateStatus());
}

function createSnapshot(
  status: AppUpdateStatus,
  input: {
    updateInfo?: AppUpdateInfo;
    progress?: AppUpdateProgress;
    error?: string;
    lastCheckedAt?: string;
  } = {}
): AppUpdateSnapshot {
  const canCheck = canCheckForUpdates();
  return {
    status,
    currentVersion: app.getVersion(),
    updateInfo: input.updateInfo,
    progress: input.progress,
    error: input.error,
    lastCheckedAt: input.lastCheckedAt,
    canCheck,
    canDownload: status === 'available' && Boolean(input.updateInfo),
    canInstall: status === 'downloaded',
    isPackaged: app.isPackaged,
    feedSource: resolveFeedSource(),
    autoDownload: autoUpdater.autoDownload
  };
}

function resolveInitialStatus(): AppUpdateStatus {
  if (!supportedPlatforms.has(process.platform)) {
    return 'unsupported';
  }
  if (!canCheckForUpdates()) {
    return 'not_configured';
  }
  return 'idle';
}

function canCheckForUpdates(): boolean {
  if (!supportedPlatforms.has(process.platform)) {
    return false;
  }
  return app.isPackaged;
}

function shouldSkipAutomaticCheck(): boolean {
  return currentSnapshot.status === 'checking' ||
    currentSnapshot.status === 'downloading' ||
    currentSnapshot.status === 'downloaded' ||
    currentSnapshot.status === 'installing';
}

function resolveFeedSource(): AppUpdateSnapshot['feedSource'] {
  if (app.isPackaged) {
    return 'embedded';
  }
  return 'none';
}

function buildNotConfiguredMessage(): string {
  if (!supportedPlatforms.has(process.platform)) {
    return `当前平台 ${process.platform} 暂不支持自动更新。`;
  }
  return '当前运行环境没有配置更新源。自动更新仅在正式打包应用中使用 GitHub Releases。';
}

function normalizeUpdateInfo(info: UpdateInfo): AppUpdateInfo {
  return {
    version: info.version,
    releaseName: info.releaseName ?? undefined,
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    stagingPercentage: info.stagingPercentage,
    minimumSystemVersion: info.minimumSystemVersion
  };
}

function normalizeReleaseNotes(input: UpdateInfo['releaseNotes']): string | undefined {
  if (!input) {
    return undefined;
  }
  if (typeof input === 'string') {
    return input.slice(0, 6000);
  }
  return input
    .map((item) => [item.version, item.note].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 6000) || undefined;
}

function normalizeProgress(progress: ProgressInfo): AppUpdateProgress {
  return {
    total: progress.total,
    delta: progress.delta,
    transferred: progress.transferred,
    percent: Math.max(0, Math.min(100, progress.percent)),
    bytesPerSecond: progress.bytesPerSecond
  };
}

function redactUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|auth|api_key|key|signature)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .slice(0, 2000);
}

function notifyOnce(key: string, input: { title: string; body: string; priority?: 'low' | 'normal' | 'urgent' }): void {
  if (lastNotifiedKey === key) {
    return;
  }
  lastNotifiedKey = key;
  void dispatchNotification?.(input);
}
