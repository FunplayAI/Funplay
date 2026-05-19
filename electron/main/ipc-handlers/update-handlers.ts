import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import { checkForAppUpdates, downloadAppUpdate, getAppUpdateStatus, installAppUpdate } from '../update-service';

export function registerUpdateHandlers(ipcMain: IpcMain, _ctx: HandlerContext): void {
  ipcMain.handle('updates:getStatus', async () => getAppUpdateStatus());
  ipcMain.handle('updates:check', async () => checkForAppUpdates());
  ipcMain.handle('updates:download', async () => downloadAppUpdate());
  ipcMain.handle('updates:install', async () => installAppUpdate());
}
