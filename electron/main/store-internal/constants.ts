import type { UnitySettings } from '../../../shared/types';

export const DB_FILE_NAME = 'funplay.db';

export const SETTINGS_KEYS = {
  unity: 'unity_settings',
  ai: 'ai_settings',
  agent: 'agent_settings',
  mcp: 'mcp_settings',
  assetGenerationProviders: 'asset_generation_providers'
} as const;

export function createDefaultSettings(defaultProjectDirectory = '~/Downloads'): UnitySettings {
  return {
    baseUrl: 'http://127.0.0.1:8765/',
    profile: 'core',
    lastStatus: 'idle',
    lastCreatedProjectDirectory: defaultProjectDirectory,
    lastAssignedMcpPort: 8765
  };
}

export function resolveLastCreatedProjectDirectory(value: string | undefined, defaultProjectDirectory: string): string {
  if (!value || value === '~/projects') {
    return defaultProjectDirectory;
  }
  return value;
}
