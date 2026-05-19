import type { IpcMain } from 'electron';
import { app, dialog, type OpenDialogOptions } from 'electron';
import type { HandlerContext } from './types';
import { folderPickerInputSchema, validateIpcInput, projectIdSchema } from '../ipc-validation';
import { pickPromptAttachments } from '../prompt-attachment-service';

export function registerDialogHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('dialog:pickProjectFolder', async (_, input: unknown) => {
    const validatedInput = validateIpcInput(folderPickerInputSchema, input, 'dialog:pickProjectFolder');
    const state = ctx.getState();
    const fallbackCreatePath = state.settings.lastCreatedProjectDirectory;
    const resolvedDefaultPath =
      (validatedInput.mode === 'create' ? validatedInput.defaultPath || fallbackCreatePath : validatedInput.defaultPath)?.replace(/^~/, app.getPath('home'));
    const options: OpenDialogOptions = {
      title: validatedInput.mode === 'create' ? '选择新项目存放目录' : '选择已有 Unity 项目目录',
      buttonLabel: validatedInput.mode === 'create' ? '选择目录' : '导入此项目',
      defaultPath: resolvedDefaultPath,
      properties: ['openDirectory', 'createDirectory']
    };
    const result = ctx.mainWindow ? await dialog.showOpenDialog(ctx.mainWindow, options) : await dialog.showOpenDialog(options);

    return {
      canceled: result.canceled,
      path: result.filePaths[0]
    };
  });

  ipcMain.handle('dialog:pickPromptAttachments', async (_, projectId: unknown) => {
    return pickPromptAttachments(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'dialog:pickPromptAttachments(projectId)'),
      ctx.mainWindow
    );
  });
}
