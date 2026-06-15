import { useEffect, useRef } from 'react';
import type { Project, PromptStreamEvent } from '../../shared/types';
import { localize, type UiLanguage } from '../i18n';
import { dispatchRefreshFileTree } from '../lib/file-tree-events';
import {
  applyPromptStreamEventToManager,
  listStreamSessions,
  removeStreamSession,
  type StreamSessionState
} from '../lib/stream-session-manager';
import { useProjectStore } from '../stores/projectStore';
import { useSessionComposerStore } from '../stores/sessionComposerStore';

/**
 * Terminal-event side effects for a prompt stream (completed / cancelled /
 * error), extracted as a pure function so the byte-exact draft-restore + GC
 * semantics are unit-testable without rendering. Reads/writes the project +
 * composer stores via getState(); `activePromptStream` is the in-flight stream
 * snapshot the hook tracks via a ref (the fallback when the manager has already
 * dropped the stream).
 */
export function applyPromptStreamLifecycleEvent(
  event: PromptStreamEvent,
  ctx: { language: UiLanguage; activePromptStream: StreamSessionState | null }
): void {
  if (event.type === 'completed') {
    useProjectStore
      .getState()
      .setProjects((current) => current.map((project) => (project.id === event.project.id ? event.project : project)));
    useSessionComposerStore.getState().setComposerErrors((current) => ({ ...current, [event.sessionId]: '' }));
    dispatchRefreshFileTree({ projectId: event.project.id, reason: 'prompt-completed' });
    removeStreamSession(event.streamId);
    return;
  }

  if (event.type === 'cancelled') {
    const current = listStreamSessions().find((stream) => stream.streamId === event.streamId) ?? ctx.activePromptStream;
    if (event.project) {
      // Interrupted, but the partial turn (user message + text streamed so far)
      // was persisted on the main side. Commit it like a completed turn so the
      // session row survives, and do NOT restore the draft — the user message now
      // lives in the session, restoring would duplicate it.
      const interruptedProject = event.project;
      useProjectStore
        .getState()
        .setProjects((projectsValue) =>
          projectsValue.map((project) => (project.id === interruptedProject.id ? interruptedProject : project))
        );
    } else if (current?.streamId === event.streamId) {
      useSessionComposerStore.getState().setDrafts((value) => ({
        ...value,
        [current.sessionId]: value[current.sessionId] || current.prompt
      }));
    }
    if (current?.sessionId) {
      useSessionComposerStore.getState().setComposerErrors((value) => ({
        ...value,
        [current.sessionId]: localize(ctx.language, '已取消本轮生成。', 'The current response was cancelled.')
      }));
    }
    return;
  }

  if (event.type === 'error') {
    const current = listStreamSessions().find((stream) => stream.streamId === event.streamId) ?? ctx.activePromptStream;
    if (current?.streamId === event.streamId) {
      useSessionComposerStore.getState().setDrafts((value) => ({
        ...value,
        [current.sessionId]: value[current.sessionId] || current.prompt
      }));
      useSessionComposerStore.getState().setComposerErrors((value) => ({
        ...value,
        [current.sessionId]: event.error
      }));
    }
  }
}

interface UsePromptStreamEventsParams {
  selectedProjectView: Project | null;
  activePromptStream: StreamSessionState | null;
  language: UiLanguage;
}

/**
 * Subscribes to main-process prompt-stream events: drives the streaming status
 * manager, applies terminal-event side effects (via the pure handler above), and
 * garbage-collects a completed stream once its assistant message has committed
 * to the session. Owns activePromptStreamRef (the stale-closure fallback used by
 * the cancelled/error branches). Extracted from App.tsx.
 */
export function usePromptStreamEvents({ selectedProjectView, activePromptStream, language }: UsePromptStreamEventsParams): void {
  const activePromptStreamRef = useRef<StreamSessionState | null>(null);

  useEffect(() => {
    activePromptStreamRef.current = activePromptStream;
  }, [activePromptStream]);

  useEffect(() => {
    if (!selectedProjectView || !activePromptStream || activePromptStream.phase !== 'completed') {
      return;
    }

    if (activePromptStream.projectId !== selectedProjectView.id) {
      return;
    }

    const targetSession =
      selectedProjectView.sessions.find((session) => session.id === activePromptStream.sessionId) ??
      selectedProjectView.sessions[0];

    if (!targetSession) {
      return;
    }

    const streamStartedAt = new Date(activePromptStream.startedAt).getTime();
    const hasCommittedAssistantMessage = targetSession.chat.some(
      (message) => message.role === 'assistant' && new Date(message.createdAt).getTime() >= streamStartedAt
    );

    if (hasCommittedAssistantMessage) {
      removeStreamSession(activePromptStream.streamId);
    }
  }, [selectedProjectView, activePromptStream]);

  useEffect(() => {
    if (!window.funplay?.onPromptStreamEvent) {
      return;
    }

    return window.funplay.onPromptStreamEvent((event: PromptStreamEvent) => {
      applyPromptStreamEventToManager(event, {
        streaming: localize(language, '正在实时生成回复…', 'Streaming response…'),
        reasoning: localize(language, '正在整理推理过程…', 'Reasoning…'),
        toolRunning: () => localize(language, '正在思考中...', 'Thinking...'),
        toolCompleted: localize(language, '工具调用完成。', 'Tool call completed.'),
        toolFailed: localize(language, '工具调用失败。', 'Tool call failed.'),
        waitingPermission: localize(language, '等待权限确认…', 'Waiting for permission…'),
        waitingUserInput: localize(language, '等待用户回答…', 'Waiting for user input…'),
        permissionAllowed: localize(language, '已允许本轮写入操作。', 'Write access allowed for this turn.'),
        permissionAllowedSession: localize(language, '已允许当前会话写入操作。', 'Write access allowed for this session.'),
        permissionDenied: localize(language, '已拒绝本轮写入操作。', 'Write access denied for this turn.'),
        userInputSubmitted: localize(language, '已提交回答，Agent 正在继续。', 'Answer submitted. Agent is continuing.'),
        completed: localize(language, '已生成完成，正在写入会话…', 'Completed. Writing into the session…')
      });

      applyPromptStreamLifecycleEvent(event, { language, activePromptStream: activePromptStreamRef.current });
    });
  }, [language]);
}
