import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import {
  environmentActionInputSchema,
  environmentInputSchema,
  validateIpcInput
} from '../ipc-validation';
import { diagnoseEnvironment, listAvailableUnityEditors, listEnvironmentTasksForState, runEnvironmentAction } from '../environment-service';

export function registerOnboardingHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('onboarding:diagnoseEnvironment', async (_, input: unknown) => {
    const state = ctx.getState();
    return diagnoseEnvironment(state, validateIpcInput(environmentInputSchema, input, 'onboarding:diagnoseEnvironment'));
  });

  ipcMain.handle('onboarding:runEnvironmentAction', async (_, input: unknown) => {
    const state = ctx.getState();
    const result = await runEnvironmentAction(state, validateIpcInput(environmentActionInputSchema, input, 'onboarding:runEnvironmentAction'));
    await ctx.setState({ ...state });
    return result;
  });

  ipcMain.handle('onboarding:listEnvironmentTasks', async () => {
    const state = ctx.getState();
    const previousBaseUrl = state.settings.baseUrl;
    const previousPort = state.settings.lastAssignedMcpPort;
    const tasks = await listEnvironmentTasksForState(state);
    if (state.settings.baseUrl !== previousBaseUrl || state.settings.lastAssignedMcpPort !== previousPort) {
      await ctx.setState({ ...state });
    }
    return tasks;
  });

  ipcMain.handle('onboarding:listInstalledUnityEditors', async (_, dimension?: '2d' | '3d' | 'unknown') => {
    return listAvailableUnityEditors(dimension);
  });
}
