import { useMemo } from 'react';
import type { AgentRuntimeStatus, AiProvider, Project } from '../../shared/types';
import { ensureProjectSessions } from '../../shared/project-sessions';
import type { UiLanguage } from '../i18n';
import { buildProjectSwitcherItem, buildSessionListState, buildVirtualProjectFiles } from '../lib/app-helpers';
import { getVisibleRuntimeStatusMessage } from '../components/chat/runtime-display';
import type { ProjectFileItem } from '../components/layout/WorkspacePanels';
import type { SessionCheckpointListItem, SessionListState } from '../components/layout/SessionManagementPanel';
import type { StreamSessionState } from '../lib/stream-session-manager';
import { useProjectStore } from '../stores/projectStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionComposerStore } from '../stores/sessionComposerStore';

/**
 * Pure session/project-panel derivations lifted out of App.tsx — the per-session
 * list states + checkpoints, rewind snapshot map, the all-projects switcher
 * items, and the virtual project files. Reads the cross-cutting maps (queued
 * prompts, composer errors, projects, active-session-by-project) directly from
 * the stores; takes only the per-render values that don't live in a store.
 */

interface UseSessionPanelDerivationsParams {
  selectedProjectView: Project | null;
  selectedSessionId: string;
  providers: AiProvider[];
  activeStreamSessions: StreamSessionState[];
  agentRuntimeStatuses: AgentRuntimeStatus[];
  language: UiLanguage;
  developerMode: boolean;
}

export function useSessionPanelDerivations({
  selectedProjectView,
  selectedSessionId,
  providers,
  activeStreamSessions,
  agentRuntimeStatuses,
  language,
  developerMode
}: UseSessionPanelDerivationsParams) {
  const queuedPromptsBySession = useSessionComposerStore((store) => store.queuedPrompts);
  const sessionComposerErrors = useSessionComposerStore((store) => store.composerErrors);
  const projects = useProjectStore((store) => store.projects);
  const localActiveSessionByProject = useSessionStore((store) => store.localActiveSessionByProject);

  const enabledProviders = useMemo(() => providers.filter((provider) => provider.enabled), [providers]);

  const selectedProjectSessionStates = useMemo<Record<string, SessionListState>>(() => {
    if (!selectedProjectView) {
      return {};
    }

    return Object.fromEntries(
      selectedProjectView.sessions.map((session) => [
        session.id,
        buildSessionListState({
          session,
          language,
          isStreaming: Boolean(
            activeStreamSessions.some(
              (stream) =>
                stream.projectId === selectedProjectView.id &&
                stream.sessionId === session.id &&
                !['completed', 'cancelled', 'error'].includes(stream.phase)
            )
          ),
          statusMessage: getVisibleRuntimeStatusMessage(
            activeStreamSessions.find(
              (stream) => stream.projectId === selectedProjectView.id && stream.sessionId === session.id
            )?.statusMessage,
            developerMode,
            language
          ),
          queuedCount: queuedPromptsBySession[session.id]?.length ?? 0,
          composerError: sessionComposerErrors[session.id] ?? ''
        })
      ])
    );
  }, [activeStreamSessions, queuedPromptsBySession, selectedProjectView, sessionComposerErrors, developerMode, language]);

  const selectedProjectSessionCheckpoints = useMemo<Record<string, SessionCheckpointListItem[]>>(() => {
    if (!selectedProjectView) {
      return {};
    }

    return selectedProjectView.snapshots
      .filter((snapshot) => snapshot.sessionCheckpoint)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .reduce<Record<string, SessionCheckpointListItem[]>>((accumulator, snapshot) => {
        const sessionId = snapshot.sessionCheckpoint?.sessionId;
        if (sessionId) {
          const next = accumulator[sessionId] ?? [];
          next.push({
            id: snapshot.id,
            note: snapshot.note,
            createdAt: snapshot.createdAt
          });
          accumulator[sessionId] = next;
        }
        return accumulator;
      }, {});
  }, [selectedProjectView]);

  const selectedSessionRewindSnapshotIds = useMemo<Record<string, string>>(() => {
    if (!selectedProjectView || !selectedSessionId) {
      return {};
    }

    return selectedProjectView.snapshots
      .filter(
        (snapshot) =>
          snapshot.sessionCheckpoint?.sessionId === selectedSessionId &&
          snapshot.sessionCheckpoint?.triggerUserMessageId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .reduce<Record<string, string>>((accumulator, snapshot) => {
        const messageId = snapshot.sessionCheckpoint?.triggerUserMessageId;
        if (messageId && !accumulator[messageId]) {
          accumulator[messageId] = snapshot.id;
        }
        return accumulator;
      }, {});
  }, [selectedProjectView, selectedSessionId]);

  const selectedSessionLatestCheckpointId = selectedSessionId
    ? selectedProjectSessionCheckpoints[selectedSessionId]?.[0]?.id
    : undefined;

  const projectSwitcherItems = useMemo(
    () =>
      projects.map((project) =>
        buildProjectSwitcherItem({
          project: ensureProjectSessions(project),
          activeStreams: activeStreamSessions,
          runtimeStatuses: agentRuntimeStatuses,
          queuedPromptsBySession,
          composerErrors: sessionComposerErrors,
          activeSessionByProject: localActiveSessionByProject
        })
      ),
    [activeStreamSessions, agentRuntimeStatuses, localActiveSessionByProject, projects, queuedPromptsBySession, sessionComposerErrors]
  );

  const virtualProjectFiles: ProjectFileItem[] = selectedProjectView ? buildVirtualProjectFiles(selectedProjectView) : [];

  return {
    enabledProviders,
    selectedProjectSessionStates,
    selectedProjectSessionCheckpoints,
    selectedSessionRewindSnapshotIds,
    selectedSessionLatestCheckpointId,
    projectSwitcherItems,
    virtualProjectFiles
  };
}
