import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import { projectIdSchema, validateIpcInput } from '../ipc-validation';
import { drainAppNotifications, listNotificationTasks, cancelNotificationTask } from '../notification-service';

export function registerNotificationHandlers(ipcMain: IpcMain, _ctx: HandlerContext): void {
  ipcMain.handle('notifications:drain', async () => drainAppNotifications());

  ipcMain.handle('notifications:listTasks', async () => listNotificationTasks());

  ipcMain.handle('notifications:cancelTask', async (_, taskId: unknown) =>
    cancelNotificationTask(validateIpcInput(projectIdSchema, taskId, 'notifications:cancelTask(taskId)'))
  );
}
