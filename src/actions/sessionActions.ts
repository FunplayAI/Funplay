import type {
  AgentPermissionMode,
  Project,
  ProjectSessionEffort,
  ProjectSessionRuntimeId
} from '../../shared/types';
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
}

export interface SessionActions {
  createSession: () => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  updateSelectedSessionRuntime: (runtime: SessionRuntimeUpdate, fallbackErrorMessage: string) => Promise<void>;
}

export function createSessionActions({
  getSelectedProject,
  getSelectedProjectView,
  getSelectedSessionId,
  enqueueSessionMutation
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

  return { createSession, renameSession, deleteSession, updateSelectedSessionRuntime };
}
