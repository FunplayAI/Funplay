import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import { runtimeDoctorInputSchema, validateIpcInput } from '../ipc-validation';
import { exportRuntimeDiagnostics } from '../runtime-doctor-service';

export function registerDiagnosticsHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('diagnostics:export', async (_, input: unknown) => {
    const options = validateIpcInput(runtimeDoctorInputSchema, input ?? {}, 'diagnostics:export');
    return exportRuntimeDiagnostics(ctx.getState(), options);
  });
}
