import type { AgentRuntimeCapabilityReport } from '../../shared/types';
import { listGenericAgentRuntimes } from './agent-platform/runtime-registry';
import type { GenericAgentRuntime } from './agent-platform/types';

export function listAgentRuntimeCapabilities(): AgentRuntimeCapabilityReport[] {
  return listGenericAgentRuntimes().map((runtime) => ({
    id: runtime.id,
    displayName: runtime.displayName,
    description: runtime.description,
    available: isRuntimeAvailable(runtime),
    capabilities: { ...runtime.capabilities },
    notes: buildRuntimeNotes(runtime)
  }));
}

function isRuntimeAvailable(runtime: GenericAgentRuntime): boolean {
  try {
    return runtime.isAvailable();
  } catch {
    return false;
  }
}

function buildRuntimeNotes(runtime: GenericAgentRuntime): string[] {
  const notes: string[] = [];

  if (runtime.capabilities.hostControlledWrites) {
    notes.push('Workspace writes are routed through host-side permission and checkpoint controls.');
  } else if (runtime.capabilities.workspaceWrite) {
    notes.push('Workspace writes are delegated to an external runtime process.');
  }

  if (runtime.capabilities.toolCheckpoint && runtime.capabilities.toolResume) {
    notes.push('Tool boundaries are persisted for restart and resume flows.');
  } else if (runtime.capabilities.resume) {
    notes.push('Session resume is available, but tool-level checkpoints are runtime-owned.');
  }

  if (runtime.capabilities.externalProcess) {
    notes.push('Runs in a local external process and inherits its installed CLI state.');
  }

  return notes;
}
