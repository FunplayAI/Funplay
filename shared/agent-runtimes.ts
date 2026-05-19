import type { ProjectSessionRuntimeId } from './types';

export interface ProjectSessionRuntimeOption {
  id: ProjectSessionRuntimeId;
  label: string;
  description: string;
}

export const PROJECT_SESSION_RUNTIME_OPTIONS: ProjectSessionRuntimeOption[] = [
  {
    id: 'native',
    label: 'Native',
    description: 'Funplay built-in multi-provider runtime'
  },
  {
    id: 'claude-code-sdk',
    label: 'Claude Code',
    description: 'Claude Code CLI-backed runtime'
  }
];

export function getProjectSessionRuntimeLabel(runtimeId?: ProjectSessionRuntimeId): string {
  return PROJECT_SESSION_RUNTIME_OPTIONS.find((option) => option.id === runtimeId)?.label ?? 'Native';
}
