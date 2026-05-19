import { useRef, useState } from 'react';
import { DEFAULT_AGENT_SETTINGS, DEFAULT_AI_SETTINGS } from '../../shared/types';
import type { AiProvider, AiProviderInput, AiSettings, AiTestResult, AgentSettings } from '../../shared/types';

interface ProviderManagerState {
  providers: AiProvider[];
  aiSettings: AiSettings;
  agentSettings: AgentSettings;
  providerTests: Record<string, AiTestResult>;
}

export function useProviderManager(initial?: Partial<ProviderManagerState>) {
  const [providers, setProviders] = useState<AiProvider[]>(initial?.providers ?? []);
  const [aiSettings, setAiSettings] = useState<AiSettings>(initial?.aiSettings ?? DEFAULT_AI_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(initial?.agentSettings ?? DEFAULT_AGENT_SETTINGS);
  const [providerTests, setProviderTests] = useState<Record<string, AiTestResult>>({});
  const providerTestRequestCounter = useRef(0);
  const activeProviderTestRequests = useRef<Record<string, number>>({});

  async function refreshProviderStateFromMain(): Promise<void> {
    const payload = await window.funplay.bootstrap();
    setProviders(payload.providers);
    setAiSettings(payload.aiSettings);
    setAgentSettings(payload.agentSettings);
  }

  async function handleCreateProvider(input: AiProviderInput): Promise<void> {
    await window.funplay.createProvider(input);
    await refreshProviderStateFromMain();
  }

  async function handleUpdateProvider(providerId: string, input: AiProviderInput): Promise<void> {
    await window.funplay.updateProvider(providerId, input);
    await refreshProviderStateFromMain();
  }

  async function handleDeleteProvider(providerId: string): Promise<void> {
    await window.funplay.deleteProvider(providerId);
    await refreshProviderStateFromMain();
  }

  async function handleTestProvider(providerId: string): Promise<void> {
    const requestId = providerTestRequestCounter.current + 1;
    providerTestRequestCounter.current = requestId;
    activeProviderTestRequests.current[providerId] = requestId;
    setProviderTests((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    try {
      const result = await window.funplay.testProvider(providerId);
      if (activeProviderTestRequests.current[providerId] === requestId) {
        setProviderTests((current) => ({ ...current, [providerId]: result }));
      }
    } catch (error) {
      if (activeProviderTestRequests.current[providerId] === requestId) {
        setProviderTests((current) => ({
          ...current,
          [providerId]: {
            providerId,
            status: 'error',
            message: error instanceof Error ? error.message : 'Provider test failed.',
            testedAt: new Date().toISOString()
          }
        }));
      }
    }
  }

  async function handleSetDefaultProvider(providerId: string): Promise<void> {
    await window.funplay.setDefaultProvider(providerId);
    await refreshProviderStateFromMain();
  }

  return {
    providers,
    setProviders,
    aiSettings,
    setAiSettings,
    agentSettings,
    setAgentSettings,
    providerTests,
    setProviderTests,
    refreshProviderStateFromMain,
    handleCreateProvider,
    handleUpdateProvider,
    handleDeleteProvider,
    handleTestProvider,
    handleSetDefaultProvider
  };
}
