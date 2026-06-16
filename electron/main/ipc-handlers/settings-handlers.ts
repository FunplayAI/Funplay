import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import {
  testWebSearchKeySchema,
  updateAgentSettingsSchema,
  updateSettingsSchema,
  updateWebSearchSettingsSchema,
  validateIpcInput
} from '../ipc-validation';
import { patchAiSettings, patchAgentSettings, patchSettings } from '../store';
import {
  getWebResearchMetrics,
  resetWebResearchMetrics,
  runWebSearchQualityEval,
  testWebSearchProvider
} from '../agent-platform/web-research-service';

export function registerSettingsHandlers(ipcMain: IpcMain, _ctx: HandlerContext): void {
  ipcMain.handle('settings:update', async (_, settings: unknown) => patchSettings(validateIpcInput(updateSettingsSchema, settings, 'settings:update')));
  ipcMain.handle('agentSettings:update', async (_, settings: unknown) =>
    patchAgentSettings(validateIpcInput(updateAgentSettingsSchema, settings, 'agentSettings:update'))
  );
  ipcMain.handle('webSearchSettings:update', async (_, settings: unknown) =>
    patchAiSettings({
      webSearch: validateIpcInput(updateWebSearchSettingsSchema, settings, 'webSearchSettings:update')
    })
  );
  ipcMain.handle('webSearchSettings:test', async (_, input: unknown) => {
    const validated = validateIpcInput(testWebSearchKeySchema, input, 'webSearchSettings:test');
    return testWebSearchProvider(validated.provider, validated.apiKey);
  });
  ipcMain.handle('webResearch:getMetrics', async () => getWebResearchMetrics());
  ipcMain.handle('webResearch:resetMetrics', async () => {
    resetWebResearchMetrics();
    return getWebResearchMetrics();
  });
  ipcMain.handle('webResearch:runQualityEval', async () => runWebSearchQualityEval());
}
