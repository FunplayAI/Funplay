import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import { projectIdSchema, validateIpcInput } from '../ipc-validation';
import { listAgentRuntimeCapabilities } from '../agent-runtime-capability-service';
import { getActiveOrPersistedRun, interruptActiveRun, listActiveRuns } from '../agent-platform/run-registry';
import { buildAgentReplayLog } from '../agent-platform/replay-log';
import { resumeAgentRun } from '../agent-platform/stream-manager';

export function registerAgentHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('agent:listRuntimeCapabilities', async () => listAgentRuntimeCapabilities());

  ipcMain.handle('agent:getRuntimeStatus', async (_, projectId?: unknown) => {
    const validatedProjectId = projectId ? validateIpcInput(projectIdSchema, projectId, 'agent:getRuntimeStatus(projectId)') : undefined;
    return listActiveRuns(validatedProjectId);
  });

  ipcMain.handle('agent:interruptRun', async (_, runId: unknown) => {
    return interruptActiveRun(validateIpcInput(projectIdSchema, runId, 'agent:interruptRun(runId)'));
  });

  ipcMain.handle('agent:resumeRun', async (_, runId: unknown) => {
    return resumeAgentRun({
      getState: ctx.getState,
      persistState: ctx.setState,
      runId: validateIpcInput(projectIdSchema, runId, 'agent:resumeRun(runId)'),
      dispatchEvent: ctx.dispatchPromptStreamEvent
    });
  });

  ipcMain.handle('agent:exportRunLog', async (_, runId: unknown) => {
    const validatedRunId = validateIpcInput(projectIdSchema, runId, 'agent:exportRunLog(runId)');
    const run = getActiveOrPersistedRun(validatedRunId);
    if (!run) {
      throw new Error(`Agent run not found: ${validatedRunId}`);
    }
    return buildAgentReplayLog(run);
  });
}
