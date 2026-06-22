import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PlatformChoice } from '../../../shared/types';
import type { WorkspaceToolActionResult } from './workspace-tools-types';

export type EngineAdapterCapability =
  | 'diagnose'
  | 'refresh'
  | 'openHub'
  | 'openProject'
  | 'installBridge';

export interface EngineAdapterCapabilityStatus {
  supported: boolean;
  reason?: string;
  nextAction?: string;
}

export interface EngineAdapter {
  platform: PlatformChoice;
  displayName: string;
  capabilities: Record<EngineAdapterCapability, EngineAdapterCapabilityStatus>;
}

const UNSUPPORTED_NEXT_ACTION = 'Use the Unity adapter today, or install a future Funplay bridge for this engine.';

function unsupportedCapabilities(platform: PlatformChoice): Record<EngineAdapterCapability, EngineAdapterCapabilityStatus> {
  const reason = `${platform} engine adapter contract exists, but runtime control 尚未实现 in this build.`;
  return {
    diagnose: {
      supported: false,
      reason,
      nextAction: UNSUPPORTED_NEXT_ACTION
    },
    refresh: {
      supported: false,
      reason,
      nextAction: UNSUPPORTED_NEXT_ACTION
    },
    openHub: {
      supported: false,
      reason,
      nextAction: UNSUPPORTED_NEXT_ACTION
    },
    openProject: {
      supported: false,
      reason,
      nextAction: UNSUPPORTED_NEXT_ACTION
    },
    installBridge: {
      supported: false,
      reason,
      nextAction: UNSUPPORTED_NEXT_ACTION
    }
  };
}

const unityAdapter: EngineAdapter = {
  platform: 'unity',
  displayName: 'Unity',
  capabilities: {
    diagnose: { supported: true },
    refresh: { supported: true },
    openHub: { supported: true },
    openProject: { supported: true },
    installBridge: { supported: true }
  }
};

const cocosAdapter: EngineAdapter = {
  platform: 'cocos',
  displayName: 'Cocos Creator',
  capabilities: {
    diagnose: { supported: true },
    refresh: { supported: true },
    openHub: {
      supported: true,
      nextAction: 'Install Cocos Dashboard or set COCOS_DASHBOARD_EXECUTABLE if automatic discovery fails.'
    },
    openProject: {
      supported: true,
      nextAction: 'Install Cocos Creator via Dashboard or set COCOS_CREATOR_EXECUTABLE if automatic discovery fails.'
    },
    installBridge: {
      supported: true,
      nextAction: 'Clone FunplayAI/funplay-cocos-mcp into extensions/funplay-cocos-mcp, then open Funplay > MCP Server in Cocos Creator.'
    }
  }
};

const godotAdapter: EngineAdapter = {
  platform: 'godot',
  displayName: 'Godot',
  capabilities: {
    diagnose: { supported: true },
    refresh: { supported: true },
    openHub: {
      supported: true,
      nextAction: 'Install Godot 4.2+ from https://godotengine.org/download or set GODOT_BIN if automatic discovery fails.'
    },
    openProject: {
      supported: true,
      nextAction: 'Install Godot 4.2+ or set GODOT_BIN if automatic discovery fails.'
    },
    installBridge: {
      supported: true,
      nextAction: 'Clone FunplayAI/funplay-godot-mcp into addons/funplay_mcp, then enable "Funplay MCP for Godot" in Project Settings > Plugins.'
    }
  }
};

const adapters = new Map<PlatformChoice, EngineAdapter>([
  ['unity', unityAdapter],
  ['web', {
    platform: 'web',
    displayName: 'Web',
    capabilities: unsupportedCapabilities('web')
  }],
  ['godot', godotAdapter],
  ['unreal', {
    platform: 'unreal',
    displayName: 'Unreal',
    capabilities: unsupportedCapabilities('unreal')
  }],
  ['cocos', cocosAdapter]
]);

export function getEngineAdapter(platform: PlatformChoice): EngineAdapter {
  return adapters.get(platform) ?? {
    platform,
    displayName: platform,
    capabilities: unsupportedCapabilities(platform)
  };
}

function formatCapabilityMatrix(adapter: EngineAdapter): string {
  return Object.entries(adapter.capabilities)
    .map(([capability, status]) =>
      [
        `- ${capability}: ${status.supported ? 'supported' : 'unsupported'}`,
        status.reason ? `reason=${status.reason}` : '',
        status.nextAction ? `nextAction=${status.nextAction}` : ''
      ].filter(Boolean).join(' | ')
    )
    .join('\n');
}

export function createUnsupportedEngineResult(input: {
  platform: PlatformChoice;
  capability: EngineAdapterCapability;
  projectPath?: string;
}): WorkspaceToolActionResult {
  const adapter = getEngineAdapter(input.platform);
  const capability = adapter.capabilities[input.capability];
  const projectPath = input.projectPath?.trim();
  const resolvedPath = projectPath ? resolve(projectPath.replace(/^~/, process.env.HOME ?? '~')) : undefined;
  const projectExists = resolvedPath ? existsSync(resolvedPath) : undefined;
  return {
    ok: input.capability === 'diagnose' || input.capability === 'refresh',
    isError: input.capability !== 'diagnose' && input.capability !== 'refresh',
    summary: [
      `Engine platform: ${input.platform}`,
      `Engine adapter: ${adapter.displayName} Adapter`,
      `Capability: ${input.capability}`,
      `Supported: ${capability.supported ? 'yes' : 'no'}`,
      capability.supported ? '' : `Status detail: ${adapter.displayName} Adapter 尚未实现 ${input.capability}`,
      projectPath ? `Project path: ${projectPath}` : 'Project path: (none)',
      typeof projectExists === 'boolean' ? `Project path exists: ${projectExists ? 'yes' : 'no'}` : '',
      capability.reason ? `Reason: ${capability.reason}` : '',
      capability.nextAction ? `Next action: ${capability.nextAction}` : '',
      '',
      'Capability matrix:',
      formatCapabilityMatrix(adapter)
    ].filter(Boolean).join('\n')
  };
}
