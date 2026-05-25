import type { AgentPermissionMode, ChatMessage, ChatMessageMetadata, Project, ProjectAgentPolicy, ProjectSession } from './types';
import { agentCorePartsToPlainText, agentCorePartsToVisibleAssistantText } from './agent-core-v2';
import { makeId, nowIso } from './utils';

export const DEFAULT_PROJECT_SESSION_MODE = 'agent' as const;

const MIN_DUPLICATE_LOGICAL_LINES = 4;

export function normalizeChatMessageOrdinals(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => ({
    ...message,
    ordinal: typeof message.ordinal === 'number' && Number.isFinite(message.ordinal) && message.ordinal >= 0
      ? Math.floor(message.ordinal)
      : index
  }));
}

function getNextChatMessageOrdinal(messages: ChatMessage[]): number {
  return messages.reduce((next, message, index) => {
    const ordinal = typeof message.ordinal === 'number' && Number.isFinite(message.ordinal) ? message.ordinal : index;
    return Math.max(next, Math.floor(ordinal) + 1);
  }, 0);
}

export function getChatMessageContextText(message: ChatMessage, maxLength?: number): string {
  const value = message.metadata?.agentCoreParts?.length
    ? agentCorePartsToPlainText(message.metadata.agentCoreParts)
    : message.content;

  if (!maxLength || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

export function getChatMessageVisibleAssistantText(message: ChatMessage, maxLength?: number): string {
  const value = message.metadata?.agentCoreParts?.length
    ? agentCorePartsToVisibleAssistantText(message.metadata.agentCoreParts)
    : message.content;

  if (!maxLength || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

function sanitizeRuntimeOverrides(runtimeOverrides: ProjectSession['runtimeOverrides']): ProjectSession['runtimeOverrides'] {
  const sanitized: ProjectSession['runtimeOverrides'] = { ...(runtimeOverrides ?? {}) };
  delete sanitized.mode;
  if (sanitized.permissionMode === 'ask') {
    sanitized.permissionMode = 'full-access';
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizePermissionMode(permissionMode: AgentPermissionMode | undefined): AgentPermissionMode | undefined {
  return permissionMode === 'ask' ? 'full-access' : permissionMode;
}

function sanitizeAgentPolicy(agentPolicy: ProjectAgentPolicy | undefined): ProjectAgentPolicy | undefined {
  if (!agentPolicy) {
    return undefined;
  }
  return {
    ...agentPolicy,
    permissionMode: sanitizePermissionMode(agentPolicy.permissionMode)
  };
}

function normalizeDuplicateLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[\s>*•+\-–—\d.)）(（]+/, '')
    .replace(/[`*_~#:[\]【】（）()，,。.!！?？;；:：\s]+/g, '')
    .trim();
}

function getCharacterBigrams(value: string): Set<string> {
  if (value.length <= 2) {
    return new Set(value ? [value] : []);
  }

  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

function getDuplicateLineSimilarity(leftLine: string, rightLine: string): number {
  const left = normalizeDuplicateLine(leftLine);
  const right = normalizeDuplicateLine(rightLine);

  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }

  const leftGrams = getCharacterBigrams(left);
  const rightGrams = getCharacterBigrams(right);
  if (!leftGrams.size || !rightGrams.size) {
    return 0;
  }

  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) {
      intersection += 1;
    }
  }

  return (2 * intersection) / (leftGrams.size + rightGrams.size);
}

function deduplicateRepeatedAssistantText(value: string): string {
  if (!value.trim() || value.includes('```')) {
    return value;
  }

  let lines = value.replace(/\r\n/g, '\n').split('\n');

  for (let pass = 0; pass < 3; pass += 1) {
    const logicalLines = lines
      .map((line, index) => ({
        index,
        line,
        normalized: normalizeDuplicateLine(line)
      }))
      .filter((item) => item.normalized.length >= 3);

    let duplicateRange: { start: number; end: number } | undefined;
    const maxWindow = Math.min(36, Math.floor(logicalLines.length / 2));

    for (let windowSize = maxWindow; windowSize >= MIN_DUPLICATE_LOGICAL_LINES && !duplicateRange; windowSize -= 1) {
      const suffixStart = logicalLines.length - windowSize;

      for (let start = 0; start + windowSize <= suffixStart; start += 1) {
        const scores = Array.from({ length: windowSize }, (_, offset) =>
          getDuplicateLineSimilarity(logicalLines[start + offset].line, logicalLines[suffixStart + offset].line)
        );
        const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        const strongMatches = scores.filter((score) => score >= 0.9).length;

        if (averageScore >= 0.82 && strongMatches >= Math.ceil(windowSize * 0.6)) {
          duplicateRange = {
            start: logicalLines[start].index,
            end: logicalLines[start + windowSize - 1].index
          };
          break;
        }
      }
    }

    if (!duplicateRange) {
      break;
    }

    while (duplicateRange.end + 1 < lines.length && !lines[duplicateRange.end + 1].trim()) {
      duplicateRange.end += 1;
    }

    lines = [...lines.slice(0, duplicateRange.start), ...lines.slice(duplicateRange.end + 1)];
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

export interface SessionConversationTurn {
  id: string;
  startedAt: string;
  userMessage?: string;
  assistantMessages: Array<{
    id: string;
    content: string;
    createdAt: string;
    intent?: ChatMessageMetadata['intent'];
  }>;
}

export function summarizeArchivedConversationTurns(turns: SessionConversationTurn[], maxItems = 8): string | undefined {
  if (turns.length === 0) {
    return undefined;
  }

  return turns
    .slice(-maxItems)
    .map((turn, index) => {
      const userLine = turn.userMessage ? `用户：${turn.userMessage.replace(/\s+/g, ' ').slice(0, 120)}` : '用户：无';
      const assistantLine = turn.assistantMessages[0]?.content
        ? `助手：${turn.assistantMessages[0].content.replace(/\s+/g, ' ').slice(0, 120)}`
        : '助手：无';
      return `历史轮次 ${index + 1}\n${userLine}\n${assistantLine}`;
    })
    .join('\n\n');
}

export function buildSessionConversationTurns(messages: ChatMessage[], maxTurns = 6): SessionConversationTurn[] {
  const turns: SessionConversationTurn[] = [];
  let currentTurn: SessionConversationTurn | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      if (currentTurn) {
        turns.push(currentTurn);
      }

      currentTurn = {
        id: message.id,
        startedAt: message.createdAt,
        userMessage: getChatMessageContextText(message, 1200),
        assistantMessages: []
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        id: message.id,
        startedAt: message.createdAt,
        assistantMessages: []
      };
    }

    currentTurn.assistantMessages.push({
      id: message.id,
      content: getChatMessageContextText(message, 1200),
      createdAt: message.createdAt,
      intent: message.metadata?.intent
    });
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns.slice(-maxTurns);
}

export function createProjectSessionRecord(input: {
  title: string;
  chat?: ChatMessage[];
  createdAt?: string;
  updatedAt?: string;
  autoTitle?: boolean;
  runtimeOverrides?: ProjectSession['runtimeOverrides'];
}): ProjectSession {
  const createdAt = input.createdAt ?? nowIso();
  const runtimeOverrides = sanitizeRuntimeOverrides(input.runtimeOverrides);
  return {
    id: makeId('session'),
    title: input.title.trim() || 'Session',
    autoTitle: input.autoTitle ?? true,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    runtimeOverrides,
    chat: normalizeChatMessageOrdinals([...(input.chat ?? [])])
  };
}

export function ensureProjectSessions(project: Project): Project {
  const sessions =
    project.sessions && project.sessions.length > 0
      ? project.sessions.map((session) => ({
          ...session,
          runtimeOverrides: sanitizeRuntimeOverrides(session.runtimeOverrides),
          chat: normalizeChatMessageOrdinals([...(session.chat ?? [])])
        }))
      : [
          createProjectSessionRecord({
            title: project.name,
            chat: [...(project.chat ?? [])],
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            autoTitle: false
          })
        ];

  const activeSessionId =
    project.activeSessionId && sessions.some((session) => session.id === project.activeSessionId)
      ? project.activeSessionId
      : sessions[0]?.id;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];

  return {
    ...project,
    agentPolicy: sanitizeAgentPolicy(project.agentPolicy),
    sessions,
    activeSessionId,
    chat: [...(activeSession?.chat ?? [])]
  };
}

export function getActiveProjectSession(project: Project): ProjectSession {
  const ensured = ensureProjectSessions(project);
  return ensured.sessions.find((session) => session.id === ensured.activeSessionId) ?? ensured.sessions[0];
}

export function syncProjectChatFromActiveSession(project: Project): Project {
  const ensured = ensureProjectSessions(project);
  const activeSession = getActiveProjectSession(ensured);
  return {
    ...ensured,
    chat: [...activeSession.chat]
  };
}

export function replaceActiveProjectSession(project: Project, nextSession: ProjectSession): Project {
  const ensured = ensureProjectSessions(project);
  const sessions = ensured.sessions.map((session) =>
    session.id === nextSession.id
      ? {
          ...nextSession,
          chat: normalizeChatMessageOrdinals([...nextSession.chat])
        }
      : session
  );

  return {
    ...ensured,
    sessions,
    activeSessionId: nextSession.id,
    chat: normalizeChatMessageOrdinals([...nextSession.chat])
  };
}

export function replaceProjectSession(project: Project, nextSession: ProjectSession, activeSessionId?: string): Project {
  const ensured = ensureProjectSessions(project);
  const sessions = ensured.sessions.map((session) =>
    session.id === nextSession.id
      ? {
          ...nextSession,
          chat: normalizeChatMessageOrdinals([...nextSession.chat])
        }
      : session
  );
  const resolvedActiveSessionId =
    activeSessionId && sessions.some((session) => session.id === activeSessionId)
      ? activeSessionId
      : ensured.activeSessionId;
  const activeSession = sessions.find((session) => session.id === resolvedActiveSessionId) ?? sessions[0];

  return {
    ...ensured,
    sessions,
    activeSessionId: activeSession?.id,
    chat: normalizeChatMessageOrdinals([...(activeSession?.chat ?? [])])
  };
}

export function deriveSessionTitleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Session';
  }
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized;
}

export function appendProjectConversationTurn(
  project: Project,
  input: {
    userMessageId?: string;
    userMessage: string;
    assistantMessage: string;
    assistantMetadata?: ChatMessageMetadata;
    updatedAt?: string;
    activityTitle?: string;
    activityDetail?: string;
  }
): Project {
  const ensured = ensureProjectSessions(project);
  const activeSession = getActiveProjectSession(ensured);
  const updatedAt = input.updatedAt ?? nowIso();
  const previousUserMessageCount = activeSession.chat.filter((message) => message.role === 'user').length;
  const title =
    activeSession.autoTitle && previousUserMessageCount === 0
      ? deriveSessionTitleFromPrompt(input.userMessage)
      : activeSession.title;
  const assistantMessage = deduplicateRepeatedAssistantText(input.assistantMessage);
  const baseChat = normalizeChatMessageOrdinals(activeSession.chat);
  const nextOrdinal = getNextChatMessageOrdinal(baseChat);
  const userMessageId = input.userMessageId ?? makeId('msg');
  const assistantMessageId = makeId('msg');
  const assistantMetadata = input.assistantMetadata;

  const nextSession: ProjectSession = {
    ...activeSession,
    title,
    autoTitle: activeSession.autoTitle && previousUserMessageCount === 0 ? false : activeSession.autoTitle,
    updatedAt,
    chat: [
      ...baseChat,
      {
        id: userMessageId,
        role: 'user',
        content: input.userMessage,
        createdAt: updatedAt,
        ordinal: nextOrdinal
      },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: assistantMessage,
        createdAt: updatedAt,
        ordinal: nextOrdinal + 1,
        metadata: assistantMetadata
      }
    ]
  };

  const nextProject = replaceActiveProjectSession(
    {
      ...ensured,
      updatedAt,
      activity: input.activityTitle
        ? [
            {
              id: makeId('act'),
              kind: 'planning',
              title: input.activityTitle,
              detail: input.activityDetail || input.userMessage,
              createdAt: updatedAt
            },
            ...ensured.activity
          ]
        : ensured.activity
    },
    nextSession
  );

  return {
    ...nextProject,
    status: 'active',
    updatedAt
  };
}

export function appendProjectAssistantMessage(
  project: Project,
  input: {
    assistantMessage: string;
    assistantMetadata?: ChatMessageMetadata;
    updatedAt?: string;
    activityTitle?: string;
    activityDetail?: string;
    sessionId?: string;
  }
): Project {
  const ensured = ensureProjectSessions(project);
  const activeSession =
    input.sessionId && ensured.sessions.some((session) => session.id === input.sessionId)
      ? ensured.sessions.find((session) => session.id === input.sessionId) ?? getActiveProjectSession(ensured)
      : getActiveProjectSession(ensured);
  const updatedAt = input.updatedAt ?? nowIso();
  const assistantMessage = deduplicateRepeatedAssistantText(input.assistantMessage);
  const baseChat = normalizeChatMessageOrdinals(activeSession.chat);
  const nextOrdinal = getNextChatMessageOrdinal(baseChat);
  const assistantMessageId = makeId('msg');
  const assistantMetadata = input.assistantMetadata;

  const nextSession: ProjectSession = {
    ...activeSession,
    updatedAt,
    chat: [
      ...baseChat,
      {
        id: assistantMessageId,
        role: 'assistant',
        content: assistantMessage,
        createdAt: updatedAt,
        ordinal: nextOrdinal,
        metadata: assistantMetadata
      }
    ]
  };

  const nextProject = replaceProjectSession(
    {
      ...ensured,
      updatedAt,
      activity: input.activityTitle
        ? [
            {
              id: makeId('act'),
              kind: 'planning',
              title: input.activityTitle,
              detail: input.activityDetail || assistantMessage,
              createdAt: updatedAt
            },
            ...ensured.activity
          ]
        : ensured.activity
    },
    nextSession,
    ensured.activeSessionId
  );

  return {
    ...nextProject,
    status: 'active',
    updatedAt
  };
}
