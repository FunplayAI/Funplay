import { useEffect, useMemo, useState } from 'react';
import type { AgentRuntimeStatus } from '../../shared/types';
import {
  getPreferredStreamSession,
  listStreamSessions,
  subscribeStreamSessions,
  type StreamSessionState
} from '../lib/stream-session-manager';
import { restoreMissingRuntimeStreams } from './agent-runtime-stream-restore';

export interface AgentRuntimeActivityState {
  activeStreamSessions: StreamSessionState[];
  activePromptStream: StreamSessionState | null;
  selectedProjectStream: StreamSessionState | null;
  agentRuntimeStatuses: AgentRuntimeStatus[];
}

export function useAgentRuntimeActivity(input: {
  enabled: boolean;
  projectId?: string;
  sessionId?: string;
}): AgentRuntimeActivityState {
  const [streamSessionVersion, setStreamSessionVersion] = useState(0);
  const [agentRuntimeStatuses, setAgentRuntimeStatuses] = useState<AgentRuntimeStatus[]>([]);

  useEffect(() => subscribeStreamSessions(() => setStreamSessionVersion((current) => current + 1)), []);

  useEffect(() => {
    if (!input.enabled) {
      setAgentRuntimeStatuses([]);
      return;
    }

    let cancelled = false;
    const refreshRuntimeStatuses = async (): Promise<void> => {
      try {
        const statuses = await window.funplay.getAgentRuntimeStatus();
        if (!cancelled) {
          restoreMissingRuntimeStreams(statuses);
          setAgentRuntimeStatuses(statuses);
        }
      } catch {
        if (!cancelled) {
          setAgentRuntimeStatuses([]);
        }
      }
    };

    void refreshRuntimeStatuses();
    const timer = window.setInterval(() => {
      void refreshRuntimeStatuses();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [input.enabled]);

  const activeStreamSessions = useMemo(
    () => (input.enabled ? listStreamSessions() : []),
    [input.enabled, streamSessionVersion]
  );

  const activePromptStream = useMemo(
    () => (input.enabled ? getPreferredStreamSession(input.projectId, input.sessionId) : null),
    [input.enabled, input.projectId, input.sessionId, streamSessionVersion]
  );

  const selectedProjectStream = useMemo(() => {
    if (!input.enabled || !input.projectId || !input.sessionId) {
      return null;
    }

    return activeStreamSessions.find((stream) => stream.projectId === input.projectId && stream.sessionId === input.sessionId) ?? null;
  }, [activeStreamSessions, input.enabled, input.projectId, input.sessionId]);

  return {
    activeStreamSessions,
    activePromptStream,
    selectedProjectStream,
    agentRuntimeStatuses
  };
}
