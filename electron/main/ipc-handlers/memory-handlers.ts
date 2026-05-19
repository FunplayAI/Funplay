import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import {
  memoryClearInputSchema,
  memoryFileContentSchema,
  memoryFilePathSchema,
  projectIdSchema,
  validateIpcInput
} from '../ipc-validation';
import {
  clearProjectMemory,
  listProjectMemoryFiles,
  readProjectMemoryFile,
  saveProjectMemoryFile
} from '../memory-service';

export function registerMemoryHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('memory:listFiles', async (_, projectId: unknown) =>
    listProjectMemoryFiles(ctx.getState(), validateIpcInput(projectIdSchema, projectId, 'memory:listFiles(projectId)'))
  );
  ipcMain.handle('memory:readFile', async (_, projectId: unknown, filePath: unknown) =>
    readProjectMemoryFile(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'memory:readFile(projectId)'),
      validateIpcInput(memoryFilePathSchema, filePath, 'memory:readFile(filePath)')
    )
  );
  ipcMain.handle('memory:saveFile', async (_, projectId: unknown, filePath: unknown, content: unknown) =>
    saveProjectMemoryFile(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'memory:saveFile(projectId)'),
      validateIpcInput(memoryFilePathSchema, filePath, 'memory:saveFile(filePath)'),
      validateIpcInput(memoryFileContentSchema, content, 'memory:saveFile(content)')
    )
  );
  ipcMain.handle('memory:clear', async (_, projectId: unknown, input: unknown) =>
    clearProjectMemory(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'memory:clear(projectId)'),
      validateIpcInput(memoryClearInputSchema, input, 'memory:clear(input)')
    )
  );
}
