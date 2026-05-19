import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import { projectIdSchema, runtimeDoctorInputSchema, validateIpcInput } from '../ipc-validation';
import {
  detectClaudeRuntime,
  importClaudeCliSession,
  listClaudeCliSessions,
  runClaudeLogin
} from '../claude-runtime-service';
import { runRuntimeDoctor } from '../runtime-doctor-service';

export function registerClaudeHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('claude:detectRuntime', async () => detectClaudeRuntime());

  ipcMain.handle('claude:login', async () => runClaudeLogin());

  ipcMain.handle('claude:listSessions', async (_, projectId: unknown) => {
    const validatedProjectId = validateIpcInput(projectIdSchema.optional(), projectId, 'claude:listSessions(projectId)');
    return listClaudeCliSessions(ctx.getState(), validatedProjectId);
  });

  ipcMain.handle('claude:importSession', async (_, projectId: unknown, sdkSessionId: unknown) => {
    const state = ctx.getState();
    const result = await importClaudeCliSession(
      state,
      validateIpcInput(projectIdSchema, projectId, 'claude:importSession(projectId)'),
      validateIpcInput(projectIdSchema, sdkSessionId, 'claude:importSession(sdkSessionId)')
    );
    await ctx.setState({ ...state });
    return result;
  });

  ipcMain.handle('claude:doctor', async (_, input: unknown) => {
    const options = validateIpcInput(runtimeDoctorInputSchema, input ?? {}, 'claude:doctor');
    return runRuntimeDoctor(ctx.getState(), options);
  });
}
