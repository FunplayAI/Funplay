import type { PromptAttachment, Project } from '../../shared/types';
import { ensureProjectSessions } from '../../shared/project-sessions';
import { localize, type UiLanguage } from '../i18n';
import { formatQueuedPromptWithAttachments } from '../lib/app-helpers';
import { getStreamSessionForSession, seedStreamSession } from '../lib/stream-session-manager';
import { useProjectStore } from '../stores/projectStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionComposerStore } from '../stores/sessionComposerStore';
import { useUiShellStore } from '../stores/uiShellStore';

/**
 * Prompt-stream orchestration extracted from App.tsx — submitting a composer
 * message into a new agent stream, and resuming a persisted agent run. Both
 * share the private seedPromptHandle helper that seeds the local stream session
 * snapshot the UI renders against.
 *
 * Most state these handlers touch (composer drafts/attachments/errors, the
 * active session, the workspace section, the project list) lives in stores and
 * is reached via getState(). What can't: the per-render selected view, the UI
 * language, and two App-owned refs — selectedProjectIdRef (the stale-closure
 * guard) and sessionMutationQueueRef, whose tail handleSubmitComposer awaits
 * DIRECTLY (it does not enqueue), so the raw ref must be injected.
 */

interface PromptStreamHandle {
  streamId: string;
  projectId: string;
  sessionId: string;
  startedAt: string;
  prompt?: string;
  attachments?: PromptAttachment[];
  kind?: 'conversation' | 'bootstrap';
}

interface PromptStreamActionDeps {
  getSelectedProjectView: () => Project | null;
  getSelectedSessionId: () => string;
  language: UiLanguage;
  selectedProjectIdRef: { current: string };
  sessionMutationQueueRef: { current: Promise<void> };
}

export interface PromptStreamActions {
  handleSubmitComposer: (content?: string, sessionIdOverride?: string, projectIdOverride?: string) => Promise<void>;
  handleResumeAgentRun: (runId: string) => Promise<void>;
}

export function createPromptStreamActions({
  getSelectedProjectView,
  getSelectedSessionId,
  language,
  selectedProjectIdRef,
  sessionMutationQueueRef
}: PromptStreamActionDeps): PromptStreamActions {
  function seedPromptHandle(handle: PromptStreamHandle, fallbackPrompt: string): void {
    seedStreamSession({
      streamId: handle.streamId,
      projectId: handle.projectId,
      sessionId: handle.sessionId,
      prompt: handle.prompt || fallbackPrompt,
      attachments: handle.attachments,
      content: '',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      phase: 'starting',
      kind: handle.kind,
      statusMessage: localize(language, '已提交给 AI，正在准备上下文…', 'Queued for AI. Preparing context…'),
      startedAt: handle.startedAt
    });
  }

  async function handleSubmitComposer(
    content?: string,
    sessionIdOverride?: string,
    projectIdOverride?: string
  ): Promise<void> {
    const targetProject = projectIdOverride
      ? useProjectStore.getState().projects.find((project) => project.id === projectIdOverride)
      : getSelectedProjectView();
    if (!targetProject) {
      return;
    }

    const targetProjectView = ensureProjectSessions(targetProject);
    const sessionId = sessionIdOverride ?? targetProjectView.activeSessionId ?? targetProjectView.sessions[0]?.id;
    if (!sessionId) {
      return;
    }

    const composer = useSessionComposerStore.getState();
    const attachments = composer.attachments[sessionId] ?? [];
    const prompt = (content ?? composer.drafts[sessionId] ?? '').trim();
    const message =
      prompt ||
      (attachments.length
        ? localize(language, '请查看附件并继续处理。', 'Please review the attachments and continue.')
        : '');
    if (!message && attachments.length === 0) {
      return;
    }

    if (getStreamSessionForSession(targetProjectView.id, sessionId)) {
      composer.queuePrompt(sessionId, formatQueuedPromptWithAttachments(message, attachments, language));
      composer.setDrafts((current) => ({ ...current, [sessionId]: '' }));
      composer.setAttachments((current) => ({ ...current, [sessionId]: [] }));
      return;
    }

    composer.setComposerErrors((current) => ({ ...current, [sessionId]: '' }));
    if (targetProjectView.id === selectedProjectIdRef.current) {
      useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
        ...current,
        [targetProjectView.id]: sessionId
      }));
    }
    try {
      await sessionMutationQueueRef.current;
      const handle = await window.funplay.startPromptStream(
        targetProjectView.id,
        message,
        sessionId,
        attachments,
        language
      );
      composer.setDrafts((current) => ({ ...current, [sessionId]: '' }));
      composer.setAttachments((current) => ({ ...current, [sessionId]: [] }));
      seedPromptHandle({ ...handle, kind: 'conversation', prompt: handle.prompt || message, attachments }, message);
    } catch (error) {
      composer.setDrafts((current) => ({ ...current, [sessionId]: message }));
      composer.setComposerErrors((current) => ({
        ...current,
        [sessionId]:
          error instanceof Error
            ? error.message
            : localize(language, '发送失败，请检查 AI Provider 配置。', 'Send failed. Check your AI Provider settings.')
      }));
    }
  }

  async function handleResumeAgentRun(runId: string): Promise<void> {
    const selectedProjectView = getSelectedProjectView();
    if (!selectedProjectView) {
      return;
    }

    try {
      const handle = await window.funplay.resumeAgentRun(runId);
      useSessionStore.getState().setLocalActiveSessionByProject((current) => ({
        ...current,
        [handle.projectId]: handle.sessionId
      }));
      useUiShellStore.getState().setSection('agent');
      seedPromptHandle(
        {
          ...handle,
          kind: handle.kind,
          prompt: handle.prompt || localize(language, '恢复 Agent 运行', 'Resume Agent run')
        },
        localize(language, '恢复 Agent 运行', 'Resume Agent run')
      );
    } catch (error) {
      const sessionId = getSelectedSessionId() || selectedProjectView.sessions[0]?.id || selectedProjectView.id;
      useSessionComposerStore.getState().setComposerErrors((current) => ({
        ...current,
        [sessionId]:
          error instanceof Error
            ? error.message
            : localize(language, '恢复 Agent 运行失败。', 'Failed to resume the Agent run.')
      }));
    }
  }

  return { handleSubmitComposer, handleResumeAgentRun };
}
