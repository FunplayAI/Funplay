import type { IpcMain } from 'electron';
import type { ProjectFileTreeChangedEvent } from '../../../shared/types';
import type { HandlerContext } from './types';
import {
  assetGenerationProviderIdSchema,
  assetGenerationProviderInputSchema,
  assetGenerationJobIdSchema,
  assetGenerationRequestSchema,
  projectIdSchema,
  validateIpcInput
} from '../ipc-validation';
import {
  cancelAssetGenerationJob,
  createAssetGenerationProvider,
  deleteAssetGenerationProvider,
  generateAssetForProject,
  importGeneratedAsset,
  listAssetGenerationProviders,
  updateAssetGenerationProvider
} from '../asset-generation-service';
import { sanitizeAssetGenerationProviderForRenderer } from '../asset-generation-secret-store';

function dispatchProjectChange(ctx: HandlerContext, projectId: string): void {
  const project = ctx.getState().projects.find((item) => item.id === projectId);
  if (!project?.engine?.projectPath) {
    return;
  }
  const payload: ProjectFileTreeChangedEvent = {
    projectId,
    projectPath: project.engine.projectPath,
    changedAt: new Date().toISOString()
  };
  ctx.dispatchProjectFileTreeChangedEvent(payload);
}

export function registerAssetGenerationHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('assetGeneration:listProviders', async () => {
    return listAssetGenerationProviders(ctx.getState());
  });

  ipcMain.handle('assetGeneration:createProvider', async (_, input: unknown) => {
    const state = ctx.getState();
    const provider = await createAssetGenerationProvider(
      state,
      validateIpcInput(assetGenerationProviderInputSchema, input, 'assetGeneration:createProvider(input)')
    );
    await ctx.setState({ ...state });
    return sanitizeAssetGenerationProviderForRenderer(provider);
  });

  ipcMain.handle('assetGeneration:updateProvider', async (_, providerId: unknown, input: unknown) => {
    const state = ctx.getState();
    const provider = await updateAssetGenerationProvider(
      state,
      validateIpcInput(assetGenerationProviderIdSchema, providerId, 'assetGeneration:updateProvider(providerId)'),
      validateIpcInput(assetGenerationProviderInputSchema, input, 'assetGeneration:updateProvider(input)')
    );
    await ctx.setState({ ...state });
    return sanitizeAssetGenerationProviderForRenderer(provider);
  });

  ipcMain.handle('assetGeneration:deleteProvider', async (_, providerId: unknown) => {
    const state = ctx.getState();
    await deleteAssetGenerationProvider(
      state,
      validateIpcInput(assetGenerationProviderIdSchema, providerId, 'assetGeneration:deleteProvider(providerId)')
    );
    await ctx.setState({ ...state });
    return { success: true as const };
  });

  ipcMain.handle('assetGeneration:generate', async (_, projectId: unknown, input: unknown) => {
    const state = ctx.getState();
    const validatedProjectId = validateIpcInput(projectIdSchema, projectId, 'assetGeneration:generate(projectId)');
    const project = await generateAssetForProject(
      state,
      validatedProjectId,
      validateIpcInput(assetGenerationRequestSchema, input, 'assetGeneration:generate(input)'),
      {
        onProjectUpdate: async (updated) => {
          await ctx.setState({ ...state });
          ctx.dispatchAssetGenerationProjectUpdatedEvent(updated);
        }
      }
    );
    await ctx.setState({ ...state });
    dispatchProjectChange(ctx, validatedProjectId);
    return project;
  });

  ipcMain.handle('assetGeneration:import', async (_, projectId: unknown, jobId: unknown) => {
    const state = ctx.getState();
    const validatedProjectId = validateIpcInput(projectIdSchema, projectId, 'assetGeneration:import(projectId)');
    const project = importGeneratedAsset(
      state,
      validatedProjectId,
      validateIpcInput(assetGenerationJobIdSchema, jobId, 'assetGeneration:import(jobId)')
    );
    await ctx.setState({ ...state });
    dispatchProjectChange(ctx, validatedProjectId);
    return project;
  });

  ipcMain.handle('assetGeneration:cancel', async (_, projectId: unknown, jobId: unknown) => {
    const state = ctx.getState();
    const project = cancelAssetGenerationJob(
      state,
      validateIpcInput(projectIdSchema, projectId, 'assetGeneration:cancel(projectId)'),
      validateIpcInput(assetGenerationJobIdSchema, jobId, 'assetGeneration:cancel(jobId)')
    );
    await ctx.setState({ ...state });
    return project;
  });
}
