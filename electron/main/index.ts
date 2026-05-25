import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { initializeStore, getState, setState } from './store';
import { initializePptxPreviewRenderer } from './pptx-preview-renderer';
import { disposeProjectFileWatchers, syncProjectFileWatchers } from './project-file-watcher';
import { disposePersistentTerminals } from './agent-platform/persistent-terminal-store';
import {
  initializeNotificationService,
  sendAppNotification
} from './notification-service';
import {
  getAppUpdateStatus,
  initializeAppUpdateService,
  scheduleStartupUpdateCheck
} from './update-service';
import { initializeProviderSecretStore } from './provider-secret-store';
import { initializeAssetGenerationSecretStore } from './asset-generation-secret-store';
import { installSessionSecurity, secureBrowserWindow } from './security';
import { installProjectPreviewProtocol, registerProjectPreviewProtocolScheme } from './project-preview-protocol';
import { disposeProjectHtmlPreviewServers } from './project-preview-dev-server';
import {
  createSessionCompletionBadgeTracker,
  createWindowsCompletionBadgeDataUrl,
  formatCompletionBadgeLabel
} from './app-completion-badge';
import type { HandlerContext } from './ipc-handlers/types';
import type { PromptStreamEvent } from '../../shared/types';
import { requirePluginBaseUrl as resolvePluginBaseUrl } from './ipc-handlers/helpers';
import { registerAppHandlers } from './ipc-handlers/app-handlers';
import { registerDialogHandlers } from './ipc-handlers/dialog-handlers';
import { registerAgentHandlers } from './ipc-handlers/agent-handlers';
import { registerProjectHandlers } from './ipc-handlers/project-handlers';
import { registerClaudeHandlers } from './ipc-handlers/claude-handlers';
import { registerSettingsHandlers } from './ipc-handlers/settings-handlers';
import { registerMcpHandlers } from './ipc-handlers/mcp-handlers';
import { registerUnityHandlers } from './ipc-handlers/unity-handlers';
import { registerProviderHandlers } from './ipc-handlers/provider-handlers';
import { registerMemoryHandlers } from './ipc-handlers/memory-handlers';
import { registerOnboardingHandlers } from './ipc-handlers/onboarding-handlers';
import { registerNotificationHandlers } from './ipc-handlers/notification-handlers';
import { registerUpdateHandlers } from './ipc-handlers/update-handlers';
import { registerDiagnosticsHandlers } from './ipc-handlers/diagnostics-handlers';
import { registerSkillsHandlers } from './ipc-handlers/skills-handlers';
import { registerAssetGenerationHandlers } from './ipc-handlers/asset-generation-handlers';

app.enableSandbox();

const APP_DISPLAY_NAME = 'Funplay';
app.setName(APP_DISPLAY_NAME);

registerProjectPreviewProtocolScheme();

let mainWindow: BrowserWindow | null = null;

const completionBadgeTracker = createSessionCompletionBadgeTracker({
  onCountChanged: (count) => applyCompletionBadgeCount(count)
});

function isPromptStreamCompletedEvent(payload: unknown): payload is Extract<PromptStreamEvent, { type: 'completed' }> {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      (payload as { type?: unknown }).type === 'completed' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
  );
}

function isMainWindowFocused(): boolean {
  const window = mainWindow;
  return Boolean(window && !window.isDestroyed() && window.isFocused());
}

function applyCompletionBadgeCount(count: number): void {
  const label = formatCompletionBadgeLabel(count);

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(label);
  }

  if (process.platform !== 'win32') {
    return;
  }

  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  if (!label) {
    window.setOverlayIcon(null, '');
    return;
  }

  const image = nativeImage.createFromDataURL(createWindowsCompletionBadgeDataUrl(count));
  window.setOverlayIcon(image.isEmpty() ? null : image, `${label} completed session${label === '1' ? '' : 's'}`);
}

function clearCompletionBadge(): void {
  completionBadgeTracker.clear();
}

function recordPromptStreamCompletionForBadge(payload: unknown): void {
  if (!isPromptStreamCompletedEvent(payload) || isMainWindowFocused()) {
    return;
  }

  completionBadgeTracker.recordCompletedSession(payload.sessionId);
}

function resolvePreloadPath(): string {
  const candidates = ['../preload/index.js', '../preload/index.mjs'].map((relativePath) => join(__dirname, relativePath));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveRuntimeIconPath(): string | undefined {
  const candidates = [
    join(process.cwd(), 'resources/icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(process.cwd(), 'Logo.png'),
    join(__dirname, '../../Logo.png')
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function applyAppIcon(): void {
  if (process.platform !== 'darwin' || !app.dock || app.isPackaged) {
    return;
  }
  const iconPath = resolveRuntimeIconPath();
  if (!iconPath) {
    return;
  }

  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function createMainWindow(): BrowserWindow {
  const iconPath = resolveRuntimeIconPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 820,
    minHeight: 600,
    resizable: true,
    movable: true,
    fullscreenable: true,
    maximizable: true,
    backgroundColor: '#09111f',
    icon: iconPath,
    title: APP_DISPLAY_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: {
      x: 16,
      y: 16
    },
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  secureBrowserWindow(window);
  window.on('focus', () => {
    clearCompletionBadge();
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  try {
    window.webContents.send(channel, payload);
  } catch {
    return;
  }
}

function registerIpcHandlers(): void {
  const ctx: HandlerContext = {
    getState,
    setState,
    mainWindow,
    dispatchPromptStreamEvent: (payload: unknown) => {
      recordPromptStreamCompletionForBadge(payload);
      sendToMainWindow('projects:promptStreamEvent', payload);
    },
    dispatchProjectFileTreeChangedEvent: (payload: unknown) => {
      sendToMainWindow('projects:fileTreeChanged', payload);
    },
    dispatchAssetGenerationProjectUpdatedEvent: (payload: unknown) => {
      sendToMainWindow('assetGeneration:projectUpdated', payload);
    },
    requirePluginBaseUrl: (pluginId?: string) => resolvePluginBaseUrl(getState, pluginId)
  };

  registerAppHandlers(ipcMain, ctx);
  registerDialogHandlers(ipcMain, ctx);
  registerAgentHandlers(ipcMain, ctx);
  registerProjectHandlers(ipcMain, ctx);
  registerClaudeHandlers(ipcMain, ctx);
  registerSettingsHandlers(ipcMain, ctx);
  registerMcpHandlers(ipcMain, ctx);
  registerUnityHandlers(ipcMain, ctx);
  registerProviderHandlers(ipcMain, ctx);
  registerMemoryHandlers(ipcMain, ctx);
  registerOnboardingHandlers(ipcMain, ctx);
  registerNotificationHandlers(ipcMain, ctx);
  registerUpdateHandlers(ipcMain, ctx);
  registerDiagnosticsHandlers(ipcMain, ctx);
  registerSkillsHandlers(ipcMain, ctx);
  registerAssetGenerationHandlers(ipcMain, ctx);
}

app.whenReady().then(async () => {
  applyAppIcon();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME
  });
  initializeProviderSecretStore(app.getPath('userData'));
  initializeAssetGenerationSecretStore(app.getPath('userData'));
  initializePptxPreviewRenderer(app.getPath('userData'));
  await initializeStore(app.getPath('userData'), app.getPath('downloads'));
  await initializeNotificationService(app.getPath('userData'), (payload) => {
    sendToMainWindow('app:notification', payload);
  });
  initializeAppUpdateService({
    dispatchStatus: (payload) => {
      sendToMainWindow('updates:status', payload);
    },
    notify: (input) => {
      void sendAppNotification({
        ...input,
        source: 'app-update'
      });
    }
  });
  installSessionSecurity();
  installProjectPreviewProtocol(getState);
  registerIpcHandlers();
  syncProjectFileWatchers(getState(), (payload) => {
    sendToMainWindow('projects:fileTreeChanged', payload);
  });
  mainWindow = createMainWindow();
  applyCompletionBadgeCount(completionBadgeTracker.getCount());
  scheduleStartupUpdateCheck();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      applyCompletionBadgeCount(completionBadgeTracker.getCount());
      syncProjectFileWatchers(getState(), (payload) => {
        sendToMainWindow('projects:fileTreeChanged', payload);
      });
      mainWindow.webContents.once('did-finish-load', () => {
        sendToMainWindow('updates:status', getAppUpdateStatus());
      });
    }
  });
});

app.on('window-all-closed', () => {
  disposeProjectFileWatchers();
  disposeProjectHtmlPreviewServers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  disposeProjectFileWatchers();
  disposeProjectHtmlPreviewServers();
  disposePersistentTerminals();
});
