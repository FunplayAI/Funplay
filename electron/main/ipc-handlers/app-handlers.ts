import type { IpcMain } from 'electron';
import { shell } from 'electron';
import { existsSync } from 'node:fs';
import type { HandlerContext } from './types';
import { externalUrlSchema, localPathSchema, validateIpcInput } from '../ipc-validation';
import { sanitizeProvidersForRenderer } from '../provider-secret-store';
import { sanitizeAssetGenerationProvidersForRenderer } from '../asset-generation-secret-store';

export function registerAppHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('app:bootstrap', async () => {
    const state = ctx.getState();
    return {
      ...state,
      providers: sanitizeProvidersForRenderer(state.providers),
      assetGenerationProviders: sanitizeAssetGenerationProvidersForRenderer(state.assetGenerationProviders ?? [])
    };
  });

  ipcMain.handle('app:openExternal', async (_, url: unknown) => {
    await shell.openExternal(validateIpcInput(externalUrlSchema, url, 'app:openExternal(url)'));
    return { success: true as const };
  });

  ipcMain.handle('app:openLocalPath', async (_, filePath: unknown) => {
    const validatedPath = validateIpcInput(localPathSchema, filePath, 'app:openLocalPath(path)');
    if (!existsSync(validatedPath)) {
      throw new Error(`Local file does not exist: ${validatedPath}`);
    }
    const errorMessage = await shell.openPath(validatedPath);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return { success: true as const };
  });

  ipcMain.handle('app:revealLocalPath', async (_, filePath: unknown) => {
    const validatedPath = validateIpcInput(localPathSchema, filePath, 'app:revealLocalPath(path)');
    if (!existsSync(validatedPath)) {
      throw new Error(`Local file does not exist: ${validatedPath}`);
    }
    shell.showItemInFolder(validatedPath);
    return { success: true as const };
  });
}
