import type { IpcMain } from 'electron';
import type { HandlerContext } from './types';
import {
  aiProviderInputSchema,
  aiProviderModelListRequestSchema,
  providerIdSchema,
  runtimeDoctorInputSchema,
  runtimeRepairInputSchema,
  validateIpcInput
} from '../ipc-validation';
import { countProviderUsage, createProvider, deleteProvider, setDefaultProvider, updateProvider } from '../provider-service';
import { listProviderModels } from '../provider-model-service';
import { testProviderConnection } from '../text-generator';
import { resolveProviderTokenLimits } from '../../../shared/provider-catalog';
import { resolveProviderForRuntime } from '../agent-platform/provider-resolver';
import { sanitizeProviderForRenderer } from '../provider-secret-store';
import { runRuntimeDoctor, repairRuntimeDoctor } from '../runtime-doctor-service';
import { getAgentSettings } from '../store';

function formatTokenLimit(value: number | undefined): string {
  if (!value) {
    return 'unknown';
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return String(value);
}

export function registerProviderHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('providers:create', async (_, input: unknown) => {
    const state = ctx.getState();
    const provider = await createProvider(state, validateIpcInput(aiProviderInputSchema, input, 'providers:create'));
    await ctx.setState({ ...state });
    return sanitizeProviderForRenderer(provider);
  });

  ipcMain.handle('providers:update', async (_, providerId: unknown, input: unknown) => {
    const state = ctx.getState();
    const provider = await updateProvider(
      state,
      validateIpcInput(providerIdSchema, providerId, 'providers:update(providerId)'),
      validateIpcInput(aiProviderInputSchema, input, 'providers:update(input)')
    );
    await ctx.setState({ ...state });
    return sanitizeProviderForRenderer(provider);
  });

  ipcMain.handle('providers:delete', async (_, providerId: unknown) => {
    const state = ctx.getState();
    await deleteProvider(state, validateIpcInput(providerIdSchema, providerId, 'providers:delete'));
    await ctx.setState({ ...state });
    return { success: true as const };
  });

  ipcMain.handle('providers:usage', async (_, providerId: unknown) => {
    return countProviderUsage(
      ctx.getState(),
      validateIpcInput(providerIdSchema, providerId, 'providers:usage')
    );
  });

  ipcMain.handle('providers:setDefault', async (_, providerId: unknown) => {
    const state = ctx.getState();
    const aiSettings = setDefaultProvider(
      state,
      validateIpcInput(providerIdSchema, providerId, 'providers:setDefault')
    );
    await ctx.setState({ ...state });
    return aiSettings;
  });

  ipcMain.handle('providers:listModels', async (_, input: unknown) => {
    return listProviderModels(
      ctx.getState(),
      validateIpcInput(aiProviderModelListRequestSchema, input, 'providers:listModels')
    );
  });

  ipcMain.handle('providers:test', async (_, providerId: unknown) => {
    const state = ctx.getState();
    const validatedProviderId = validateIpcInput(providerIdSchema, providerId, 'providers:test');
    const provider = state.providers.find((item) => item.id === validatedProviderId);
    if (!provider) {
      throw new Error('Provider not found.');
    }

    const testedAt = new Date().toISOString();

    try {
      const runtimeStrategy = getAgentSettings().runtimeStrategy;
      const resolved = resolveProviderForRuntime({ state, explicitProvider: provider });
      const tokenLimits = resolveProviderTokenLimits(provider);
      const modelPresetLabel = tokenLimits.displayName || tokenLimits.modelId;
      const text = await testProviderConnection(provider);
      return {
        providerId: validatedProviderId,
        status: 'success' as const,
        message: [
          `Native provider 探针成功，模型返回：${text.slice(0, 80) || 'OK'}`,
          `Protocol: ${resolved.protocol}`,
          `Model: ${resolved.upstreamModel || resolved.model || provider.model}`,
          modelPresetLabel ? `Model preset: ${modelPresetLabel}` : '',
          `Context window: ${formatTokenLimit(tokenLimits.effectiveContextWindowTokens)}`,
          `Max output: ${formatTokenLimit(tokenLimits.effectiveMaxOutputTokens)}`,
          `Runtime strategy: ${runtimeStrategy}`
        ]
          .filter(Boolean)
          .join('\n'),
        testedAt
      };
    } catch (error) {
      const tokenLimits = resolveProviderTokenLimits(provider);
      const modelPresetLabel = tokenLimits.displayName || tokenLimits.modelId;
      return {
        providerId: validatedProviderId,
        status: 'error' as const,
        message: [
          error instanceof Error ? error.message : 'Unknown error',
          '请检查：Base URL 格式与协议(http/https)、是否需要 /v1 等路径、API Key 是否正确、以及代理或防火墙设置。',
          'Check: Base URL format and protocol (http/https), required path such as /v1, API Key correctness, and any proxy or firewall settings.',
          `Provider: ${provider.name}`,
          `Protocol: ${provider.protocol}`,
          `Base URL: ${provider.baseUrl || '(default)'}`,
          `Model: ${provider.model}`,
          modelPresetLabel ? `Model preset: ${modelPresetLabel}` : '',
          `Context window: ${formatTokenLimit(tokenLimits.effectiveContextWindowTokens)}`,
          `Max output: ${formatTokenLimit(tokenLimits.effectiveMaxOutputTokens)}`,
          `Runtime strategy: ${getAgentSettings().runtimeStrategy}`
        ]
          .filter(Boolean)
          .join('\n'),
        testedAt
      };
    }
  });

  ipcMain.handle('providers:doctor', async (_, providerId: unknown, input: unknown) => {
    const validatedProviderId = validateIpcInput(providerIdSchema, providerId, 'providers:doctor(providerId)');
    const options = validateIpcInput(
      runtimeDoctorInputSchema,
      { ...(input && typeof input === 'object' ? input : {}), providerId: validatedProviderId },
      'providers:doctor(input)'
    );
    return runRuntimeDoctor(ctx.getState(), options);
  });

  ipcMain.handle('providers:repair', async (_, input: unknown) => {
    const state = ctx.getState();
    const result = repairRuntimeDoctor(state, validateIpcInput(runtimeRepairInputSchema, input, 'providers:repair'));
    if (result.stateChanged) {
      await ctx.setState({ ...state });
    }
    return result;
  });
}
