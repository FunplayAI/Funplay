import { useEffect } from 'react';
import type { BootstrapPayload } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import { useProjectStore } from '../stores/projectStore';
import { useSessionStore } from '../stores/sessionStore';
import { useEngineSetupStore } from '../stores/engineSetupStore';
import { useUiShellStore } from '../stores/uiShellStore';

interface UseBootstrapDeps {
  // Hydrated state owned by singleton hooks (not stores) — injected.
  setProviders: (value: BootstrapPayload['providers']) => void;
  setMcpPlugins: (value: BootstrapPayload['mcpPlugins']) => void;
  setAiSettings: (value: BootstrapPayload['aiSettings']) => void;
  setAgentSettings: (value: BootstrapPayload['agentSettings']) => void;
  setAssetGenerationProviderConfigs: (value: NonNullable<BootstrapPayload['assetGenerationProviders']>) => void;
  language: UiLanguage;
}

/**
 * One-time app bootstrap: runs window.funplay.bootstrap() once on mount and
 * fans the payload out to the renderer stores (projects/session/engine-setup/
 * ui-shell, via getState()) plus the hook-owned provider/mcp/asset state passed
 * in. Surfaces the preload-missing + failure cases as a bootstrap error and
 * always clears the loading flag. Extracted from App.tsx.
 */
export function useBootstrap(deps: UseBootstrapDeps): void {
  const { setProviders, setMcpPlugins, setAiSettings, setAgentSettings, setAssetGenerationProviderConfigs, language } =
    deps;

  useEffect(() => {
    const ui = useUiShellStore.getState();
    if (!window.funplay?.bootstrap) {
      ui.setBootstrapError(
        localize(
          language,
          'Funplay preload API 未成功注入。请重启应用；如果仍有问题，检查 Electron preload 是否正确加载。',
          'Funplay preload API was not injected. Restart the app, and if it still fails, verify Electron preload is loading correctly.'
        )
      );
      ui.setIsLoading(false);
      return;
    }

    void window.funplay
      .bootstrap()
      .then((payload: BootstrapPayload) => {
        const project = useProjectStore.getState();
        const engine = useEngineSetupStore.getState();
        project.setProjects(payload.projects);
        useSessionStore.getState().setLocalActiveSessionByProject(
          Object.fromEntries(
            payload.projects.map((entry) => [entry.id, entry.activeSessionId || entry.sessions[0]?.id || ''])
          )
        );
        setProviders(payload.providers);
        setMcpPlugins(payload.mcpPlugins);
        setAssetGenerationProviderConfigs(payload.assetGenerationProviders ?? []);
        setAiSettings(payload.aiSettings);
        setAgentSettings(payload.agentSettings);
        engine.setSettings(payload.settings);
        engine.setSettingsDraft(payload.settings);
        engine.setOnboardingProjectPath(payload.settings.lastCreatedProjectDirectory || '~/Downloads');
        project.setSelectedProjectId(payload.projects[0]?.id ?? '');
        engine.setOnboardingEnginePluginId(
          payload.mcpPlugins.find(
            (plugin) => !plugin.projectId && plugin.kind === 'engine' && /unity/i.test(plugin.name)
          )?.id ??
            payload.mcpPlugins.find((plugin) => !plugin.projectId && plugin.kind === 'engine' && plugin.enabled)?.id ??
            ''
        );
        useUiShellStore.getState().setAppMode(payload.projects.length > 0 ? 'workspace' : 'welcome');
      })
      .catch((error) => {
        useUiShellStore
          .getState()
          .setBootstrapError(
            error instanceof Error ? error.message : localize(language, '应用启动失败', 'Failed to launch app')
          );
      })
      .finally(() => {
        useUiShellStore.getState().setIsLoading(false);
      });
    // Bootstrap runs exactly once on mount.
  }, []);
}
