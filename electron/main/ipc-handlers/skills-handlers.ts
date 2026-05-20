import type { IpcMain } from 'electron';
import { app } from 'electron';
import type { HandlerContext } from './types';
import { listAgentSkillCatalogSchema, listProjectAgentSkillRegistrySchema, validateIpcInput } from '../ipc-validation';
import { listFunplaySkillCatalog } from '../skill-catalog-service';
import { buildAgentSkillRegistry } from '../agent-platform/skill-registry';
import { nowIso } from '../../../shared/utils';

export function registerSkillsHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('skills:listCatalog', async (_, options: unknown) => {
    return listFunplaySkillCatalog(
      app.getPath('userData'),
      validateIpcInput(listAgentSkillCatalogSchema, options, 'skills:listCatalog(options)') ?? {}
    );
  });

  ipcMain.handle('skills:listProjectRegistry', async (_, input: unknown) => {
    const projectId = validateIpcInput(listProjectAgentSkillRegistrySchema, input, 'skills:listProjectRegistry(input)');
    const project = ctx.getState().projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error('Project not found.');
    }
    const registry = buildAgentSkillRegistry({
      projectPath: project.engine?.projectPath
    });
    return {
      generatedAt: nowIso(),
      skills: registry.index,
      conflicts: registry.conflicts,
      sourcePrecedence: registry.sourcePrecedence
    };
  });
}
