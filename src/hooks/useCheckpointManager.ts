import { useCallback, useEffect, useState } from 'react';
import type { Project, SessionCheckpointPreview } from '../../shared/types';
import { type SessionCheckpointListItem } from '../components/layout/SessionManagementPanel';

export interface RestoredCheckpointState {
  projectId: string;
  sessionId: string;
  snapshotId: string;
  checkpointNote: string;
  rolledBackCount: number;
  triggerUserMessageId?: string;
  restoredAt: string;
}

interface UseCheckpointManagerParams {
  selectedProjectView: Project | null;
  selectedSessionId: string;
  selectedSessionLatestCheckpointId: string | undefined;
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  setLocalActiveSessionByProject: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSessionComposerErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSection: (section: 'agent' | 'settings' | 'assets') => void;
  enqueueSessionMutation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function useCheckpointManager({
  selectedProjectView,
  selectedSessionId,
  selectedSessionLatestCheckpointId,
  setProjects,
  setLocalActiveSessionByProject,
  setSessionComposerErrors,
  setSection,
  enqueueSessionMutation
}: UseCheckpointManagerParams) {
  const [restoreCheckpointPreview, setRestoreCheckpointPreview] = useState<SessionCheckpointPreview | null>(null);
  const [sessionChangePanelPreview, setSessionChangePanelPreview] = useState<SessionCheckpointPreview | null>(null);
  const [sessionChangePanelLoading, setSessionChangePanelLoading] = useState(false);
  const [sessionChangePanelOpen, setSessionChangePanelOpen] = useState(false);
  const [restoredCheckpointState, setRestoredCheckpointState] = useState<RestoredCheckpointState | null>(null);
  const [isRestoringCheckpoint, setIsRestoringCheckpoint] = useState(false);

  useEffect(() => {
    if (!restoredCheckpointState) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRestoredCheckpointState((current) =>
        current?.snapshotId === restoredCheckpointState.snapshotId &&
        current?.restoredAt === restoredCheckpointState.restoredAt
          ? null
          : current
      );
    }, 6000);

    return () => window.clearTimeout(timeoutId);
  }, [restoredCheckpointState]);

  useEffect(() => {
    if (!selectedProjectView || !selectedSessionLatestCheckpointId) {
      setSessionChangePanelPreview(null);
      setSessionChangePanelLoading(false);
      return;
    }

    let cancelled = false;
    setSessionChangePanelLoading(true);
    window.funplay
      .previewSessionCheckpoint(selectedProjectView.id, selectedSessionLatestCheckpointId)
      .then((preview) => {
        if (!cancelled) {
          setSessionChangePanelPreview(preview);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessionChangePanelPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSessionChangePanelLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectView?.id, selectedProjectView?.updatedAt, selectedSessionLatestCheckpointId]);

  const selectedProjectId = selectedProjectView?.id;

  const handleRequestRestoreSessionCheckpoint = useCallback(
    async (_sessionId: string, snapshotId: string): Promise<void> => {
      if (!selectedProjectId) {
        return;
      }

      const preview = await window.funplay.previewSessionCheckpoint(selectedProjectId, snapshotId);
      setRestoreCheckpointPreview(preview);
    },
    [selectedProjectId]
  );

  const handleRestoreSelectedSessionCheckpoint = useCallback(
    (snapshotId: string): void => {
      void handleRequestRestoreSessionCheckpoint(selectedSessionId, snapshotId);
    },
    [handleRequestRestoreSessionCheckpoint, selectedSessionId]
  );

  async function handleConfirmRestoreSessionCheckpoint(): Promise<void> {
    if (!selectedProjectView || !restoreCheckpointPreview) {
      return;
    }

    setIsRestoringCheckpoint(true);
    try {
      const updated = await enqueueSessionMutation(() =>
        window.funplay.restoreSessionCheckpoint(selectedProjectView!.id, restoreCheckpointPreview.snapshotId)
      );
      setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
      setLocalActiveSessionByProject((current) => ({
        ...current,
        [updated.id]: updated.activeSessionId || restoreCheckpointPreview.sessionId
      }));
      setSessionComposerErrors((current) => ({
        ...current,
        [restoreCheckpointPreview.sessionId]: ''
      }));
      setRestoredCheckpointState({
        projectId: updated.id,
        sessionId: restoreCheckpointPreview.sessionId,
        snapshotId: restoreCheckpointPreview.snapshotId,
        checkpointNote: restoreCheckpointPreview.checkpointNote,
        rolledBackCount: restoreCheckpointPreview.addedMessages,
        triggerUserMessageId: restoreCheckpointPreview.triggerUserMessageId,
        restoredAt: new Date().toISOString()
      });
      setSection('agent');
      setRestoreCheckpointPreview(null);
    } finally {
      setIsRestoringCheckpoint(false);
    }
  }

  return {
    restoreCheckpointPreview,
    setRestoreCheckpointPreview,
    sessionChangePanelPreview,
    sessionChangePanelLoading,
    sessionChangePanelOpen,
    setSessionChangePanelOpen,
    restoredCheckpointState,
    isRestoringCheckpoint,
    handleRequestRestoreSessionCheckpoint,
    handleRestoreSelectedSessionCheckpoint,
    handleConfirmRestoreSessionCheckpoint
  };
}
