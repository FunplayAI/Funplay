import type { BrowserWindow, IpcMain } from 'electron';
import type { AppState } from '../../../shared/types';

export interface HandlerContext {
  getState: () => AppState;
  setState: (state: AppState) => Promise<void>;
  mainWindow: BrowserWindow | null;
  dispatchPromptStreamEvent: (payload: unknown) => void;
  dispatchProjectFileTreeChangedEvent: (payload: unknown) => void;
  dispatchAssetGenerationProjectUpdatedEvent: (payload: unknown) => void;
  requirePluginBaseUrl: (pluginId?: string) => string;
}
