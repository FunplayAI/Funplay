import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import { runtimeDoctorInputSchema, validateIpcInput } from '../ipc-validation';
import { runRuntimeDoctor } from '../runtime-doctor-service';

export function registerRuntimeDoctorHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('runtimeDoctor:run', async (_, input: unknown) => {
    const options = validateIpcInput(runtimeDoctorInputSchema, input ?? {}, 'runtimeDoctor:run');
    return runRuntimeDoctor(ctx.getState(), options);
  });
}
