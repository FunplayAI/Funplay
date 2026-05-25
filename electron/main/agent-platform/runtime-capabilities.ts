import type { GenericAgentRuntime, GenericAgentRuntimeCapabilityKey, GenericAgentRuntimeCapabilities } from './types';

export const DEFAULT_GENERIC_AGENT_RUNTIME_CAPABILITIES: GenericAgentRuntimeCapabilities = {
  conversation: false,
  toolLoop: false,
  nativeToolCalling: false,
  legacyJsonLoop: false,
  workspaceWrite: false,
  mcpTools: false,
  sessionPermission: false,
  checkpoint: false,
  toolCheckpoint: false,
  resume: false,
  toolResume: false,
  externalProcess: false,
  hostControlledWrites: false,
  contextHandoff: false,
  externalWriteAudit: false,
  externalWriteRollback: false,
  intentBoundMcp: false,
  exactlyOnceStream: false,
  liveE2EGated: false
};

export function createGenericAgentRuntimeCapabilities(
  overrides: Partial<GenericAgentRuntimeCapabilities>
): GenericAgentRuntimeCapabilities {
  return {
    ...DEFAULT_GENERIC_AGENT_RUNTIME_CAPABILITIES,
    ...overrides
  };
}

export function supportsGenericAgentRuntimeCapability(
  runtime: GenericAgentRuntime,
  capability: GenericAgentRuntimeCapabilityKey
): boolean {
  return runtime.capabilities[capability];
}
