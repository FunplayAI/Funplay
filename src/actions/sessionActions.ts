import type {
  AgentPermissionMode,
  Project,
  ProjectSessionEffort,
  ProjectSessionRuntimeId
} from '../../shared/types';
import { ensureProjectSessions } from '../../shared/project-sessions';
import { mergeProjectSessionSelection } from '../lib/app-helpers';
import { useProjectStore } from '../stores/projectStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionComposerStore } from '../stores/sessionComposerStore';
import { useUiShellStore } from '../stores/uiShellStore';

/**
 * Session CRUD orchestration extracted from App.tsx.
 *
 * These handlers coordinate a main-process mutation (`window.funplay.*`) with
 * several renderer stores. Everything they write — the project list, the
 * per-project active session, composer scratch state, the workspace section —
 * now lives in Zustand, so the factory reaches it through `getState()` and only
 * needs two things injected from App that can't live in a store:
 *
 *  - `getSelectedProject` — derived per render by `useSelectedProjectView`.
 *  - `enqueueSessionMutation` — App's ref-backed FIFO queue that serializes
 *    session mutations so out-of-order main-process replies can't interleave.
 *
 * Keeping them as a plain factory (rather than store actions) avoids pulling
 * React refs into the stores, and makes the orchestration unit-testable with a
 * mocked `window.funplay` plus the real stores.
 */

/** The session-runtime fields the project-settings UI can patch on the active session. */
export type SessionRuntimeUpdate = {
  runtimeId?: ProjectSessionRuntimeId;
  providerId?: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  effort?: ProjectSessionEffort;
};

interface SessionActionDeps {
  getSelectedProject: () => Project | null;
  /** The selected project resolved with its session list (for runtime updates). */
  getSelectedProjectView: () => Project | null;
  getSelectedSessionId: () => string;
  enqueueSessionMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  /**
   * App-owned mutable counter that makes a superseded session switch a no-op:
   * each switch claims a token and bails after its await if a newer switch has
   * since claimed one. Injected (not store-moved) — same precedent as the refs
   * promptStreamActions takes.
   */
  activeSessionSwitchTokenRef: { current: number };
  /** Open a project into the workspace (App's hoisted wrapper over projectNavActions). */
  openProject: (projectId: string) => void;
}

export interface SessionActions {
  createSession: () => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  updateSelectedSessionRuntime: (runtime: SessionRuntimeUpdate, fallbackErrorMessage: string) => Promise<void>;
  handleSelectSession: (sessionId: string, projectIdOverride?: string) => Promise<void>;
}

export function createSessionActions({
  getSelectedProject,
  getSelectedProjectView,
  getSelectedSessionId,
  enqueueSessionMutation,
  activeSessionSwitchTokenRef,
  openProject
}: SessionActionDeps): SessionActions {
  async function createSession(): Promise<void> {
    const selectedProject = getSelectedProject();
    if (!selectedProject) {
      return;
    }
    const updated = await enqueueSessionMutation(() => window.funplay.createProjectSession(selectedProject.id));
    useProjectStore.getState().setProjects((current) =>
      current.map((project) => (project.id === updated.id ? updated : project))
    );
    const nextSessionId = updated.activeSessionId || updated.sessions[0]?.id;
    if (nextSessionId) {
      useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
        ...current,
        [updated.id]: nextSessionId
      }));
      const composer = useSessionComposerStore.getState();
      composer.setDrafts((current) => ({ ...current, [nextSessionId]: '' }));
      composer.setAttachments((current) => ({ ...current, [nextSessionId]: [] }));
      composer.setComposerErrors((current) => ({ ...current, [nextSessionId]: '' }));
    }
    useUiShellStore.getState().setSection('agent');
  }

  async function renameSession(sessionId: string, title: string): Promise<void> {
    const selectedProject = getSelectedProject();
    if (!selectedProject) {
      return;
    }
    const updated = await enqueueSessionMutation(() =>
      window.funplay.renameProjectSession(selectedProject.id, sessionId, title)
    );
    useProjectStore.getState().setProjects((current) =>
      current.map((project) => (project.id === updated.id ? mergeProjectSessionSelection(project, updated) : project))
    );
  }

  async function deleteSession(sessionId: string): Promise<void> {
    const selectedProject = getSelectedProject();
    if (!selectedProject) {
      return;
    }
    const updated = await enqueueSessionMutation(() =>
      window.funplay.deleteProjectSession(selectedProject.id, sessionId)
    );
    useProjectStore.getState().setProjects((current) =>
      current.map((project) => (project.id === updated.id ? updated : project))
    );
    useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
      ...current,
      [updated.id]: updated.activeSessionId || updated.sessions[0]?.id || ''
    }));
    useSessionComposerStore.getState().clearSessionScoped([sessionId]);
    useUiShellStore.getState().setSection('agent');
  }

  function updateSelectedSessionRuntime(runtime: SessionRuntimeUpdate, fallbackErrorMessage: string): Promise<void> {
    const selectedProjectView = getSelectedProjectView();
    const sessionId = getSelectedSessionId();
    if (!selectedProjectView || !sessionId) {
      return Promise.resolve();
    }
    const projectId = selectedProjectView.id;
    return enqueueSessionMutation(() => window.funplay.updateProjectSessionRuntime(projectId, sessionId, runtime))
      .then((updated) => {
        useProjectStore.getState().setProjects((current) =>
          current.map((project) => (project.id === updated.id ? mergeProjectSessionSelection(project, updated) : project))
        );
      })
      .catch((error) => {
        useSessionComposerStore.getState().setComposerErrors((current) => ({
          ...current,
          [sessionId]: error instanceof Error ? error.message : fallbackErrorMessage
        }));
      });
  }

  async function handleSelectSession(sessionId: string, projectIdOverride?: string): Promise<void> {
    const targetProject = projectIdOverride
      ? (useProjectStore.getState().projects.find((project) => project.id === projectIdOverride) ?? null)
      : getSelectedProject();
    if (!targetProject) {
      useUiShellStore.getState().setSection('agent');
      return;
    }

    const currentProjectId = targetProject.id;
    const currentProject = ensureProjectSessions(targetProject);
    const currentActiveSessionId =
      useSessionStore.getState().localActiveSessionByProject[currentProject.id] || currentProject.activeSessionId;
    if (currentActiveSessionId === sessionId) {
      useUiShellStore.getState().setSection('agent');
      return;
    }

    const nextActiveSession = currentProject.sessions.find((session) => session.id === sessionId);
    if (!nextActiveSession) {
      return;
    }

    // Live store value is at least as current as App's selectedProjectIdRef (which
    // lags one effect cycle), and this is a synchronous read — no ref needed here.
    if (useProjectStore.getState().selectedProjectId !== currentProjectId) {
      openProject(currentProjectId);
    }

    const token = activeSessionSwitchTokenRef.current + 1;
    activeSessionSwitchTokenRef.current = token;
    useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
      ...current,
      [currentProjectId]: sessionId
    }));

    useProjectStore.getState().setProjects((current) =>
      current.map((project) =>
        project.id === currentProjectId
          ? { ...project, activeSessionId: sessionId, chat: [...nextActiveSession.chat] }
          : project
      )
    );

    const updated = await enqueueSessionMutation(() =>
      window.funplay.setActiveProjectSession(currentProjectId, sessionId)
    );
    // A newer switch superseded this one mid-flight — drop the stale result.
    if (activeSessionSwitchTokenRef.current !== token) {
      return;
    }

    useProjectStore.getState().setProjects((current) =>
      current.map((project) => (project.id === updated.id ? mergeProjectSessionSelection(project, updated) : project))
    );
    useUiShellStore.getState().setSection('agent');
  }

  return { createSession, renameSession, deleteSession, updateSelectedSessionRuntime, handleSelectSession };
}
