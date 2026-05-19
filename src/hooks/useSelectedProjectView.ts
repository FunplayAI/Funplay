import { useMemo } from 'react';
import { ensureProjectSessions } from '../../shared/project-sessions';
import type { Project } from '../../shared/types';

export interface UseSelectedProjectViewInput {
  projects: Project[];
  selectedProjectId: string;
  localActiveSessionByProject: Record<string, string>;
}

export interface UseSelectedProjectViewResult {
  selectedProject: Project | null;
  selectedProjectView: Project | null;
  selectedSessionId: string;
}

export function buildSelectedProjectView(
  project: Project | null,
  localActiveSessionByProject: Record<string, string>
): Project | null {
  if (!project) {
    return null;
  }

  const ensured = ensureProjectSessions(project);
  const localActiveSessionId = localActiveSessionByProject[ensured.id];
  const resolvedActiveSessionId =
    localActiveSessionId && ensured.sessions.some((session) => session.id === localActiveSessionId)
      ? localActiveSessionId
      : ensured.activeSessionId || ensured.sessions[0]?.id || '';
  const activeSession = ensured.sessions.find((session) => session.id === resolvedActiveSessionId) ?? ensured.sessions[0];

  return {
    ...ensured,
    activeSessionId: resolvedActiveSessionId,
    chat: [...(activeSession?.chat ?? [])]
  };
}

export function useSelectedProjectView(input: UseSelectedProjectViewInput): UseSelectedProjectViewResult {
  const selectedProject = useMemo(
    () => input.projects.find((project) => project.id === input.selectedProjectId) ?? null,
    [input.projects, input.selectedProjectId]
  );
  const selectedProjectView = useMemo(
    () => buildSelectedProjectView(selectedProject, input.localActiveSessionByProject),
    [input.localActiveSessionByProject, selectedProject]
  );
  const selectedSessionId = selectedProjectView?.activeSessionId || selectedProjectView?.sessions[0]?.id || '';

  return {
    selectedProject,
    selectedProjectView,
    selectedSessionId
  };
}
