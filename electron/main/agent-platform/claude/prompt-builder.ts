import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildSessionConversationTurns } from '../../../../shared/project-sessions';
import {
  type AiProvider,
  type ClaudeContextSummaryCoverage,
  type PromptAttachment
} from '../../../../shared/types';
import {
  BUILTIN_MEMORY_SYSTEM_PROMPT,
  BUILTIN_MEDIA_SYSTEM_PROMPT,
  BUILTIN_NOTIFICATION_SYSTEM_PROMPT,
  BUILTIN_WORKSPACE_WRITE_SYSTEM_PROMPT,
  BUILTIN_WEB_SYSTEM_PROMPT,
  CLAUDE_NATIVE_WEB_SYSTEM_PROMPT
} from '../builtin-mcp';
import { FUNPLAY_HTML_PREVIEW_CAPABILITY_PROMPT_EN } from '../preview-capabilities';
import { createResponseLanguageContextLine, createResponseLanguageInstruction, type RuntimeUiLanguage } from '../response-language';
import type { GenericAgentRuntimeParams } from '../types';
import type {
  ClaudeMcpProfile,
  ClaudeSdkPromptContentBlock
} from './types';
import {
  getClaudeRuntimeSession,
  CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP,
  CLAUDE_IMAGE_ATTACHMENT_MAX_BYTES,
  CLAUDE_IMAGE_ATTACHMENT_MAX_COUNT,
  CLAUDE_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES,
  CLAUDE_SUPPORTED_IMAGE_MIME_TYPES
} from './constants';
import {
  filterClaudeMessagesAfterSummaryBoundary,
  normalizeClaudeHistoryMessageContent
} from './context-summary';

export function shouldUseClaudeNativeWeb(provider?: AiProvider): boolean {
  if (!provider) {
    return true;
  }
  return provider.protocol === 'anthropic' && !provider.sdkProxyOnly;
}

export function createSystemPrompt(provider?: AiProvider, profile?: ClaudeMcpProfile, uiLanguage?: RuntimeUiLanguage): string {
  const includeWeb = profile?.includeWeb ?? true;
  const includeMemory = profile?.includeMemory ?? true;
  const includeMedia = profile?.includeMedia ?? true;
  const includeImageGeneration = profile?.includeImageGeneration ?? true;
  const includeNotifications = profile?.includeNotifications ?? true;
  const includeWorkspaceWrite = profile?.includeWorkspaceWrite ?? false;

  return [
    'You are the Claude Code runtime inside Funplay.',
    'Work against the current project directory and keep responses concise and directly actionable.',
    'Use project-relative paths when you mention files.',
    'Do not claim to have changed files unless the tool output confirms it.',
    'Prefer reading only the minimum files needed for the current user request.',
    'For multi-step work, use TodoWrite to keep a short visible task list.',
    FUNPLAY_HTML_PREVIEW_CAPABILITY_PROMPT_EN,
    createResponseLanguageInstruction(uiLanguage),
    'When using Claude Code Read, omit optional parameters that have no value. In particular, never pass pages as an empty string; omit pages entirely unless you need a concrete 1-indexed range such as "1-5" or "3". If Read fails because pages is invalid, retry once without pages.',
    'If project instructions are provided in the user prompt, follow them with higher priority than these defaults.',
    '',
    includeMemory ? BUILTIN_MEMORY_SYSTEM_PROMPT : '',
    '',
    includeNotifications ? BUILTIN_NOTIFICATION_SYSTEM_PROMPT : '',
    '',
    includeMedia || includeImageGeneration ? BUILTIN_MEDIA_SYSTEM_PROMPT : '',
    '',
    includeWorkspaceWrite ? BUILTIN_WORKSPACE_WRITE_SYSTEM_PROMPT : '',
    '',
    'Use Claude Code\'s native AskUserQuestion tool when a missing user preference, business choice, or conflict decision blocks progress. Do not use it for tool permissions or for information you can determine by reading the project or using web tools.',
    '',
    includeWeb ? shouldUseClaudeNativeWeb(provider) ? CLAUDE_NATIVE_WEB_SYSTEM_PROMPT : BUILTIN_WEB_SYSTEM_PROMPT : ''
  ].filter(Boolean).join('\n');
}

export function formatProjectInstructions(params: GenericAgentRuntimeParams): string {
  if (params.context.projectInstructions.length === 0) {
    return '';
  }

  return [
    'Project instructions discovered by Funplay:',
    'These files are from the current workspace. Follow them exactly where they apply; deeper path instructions override broader ones.',
    ...params.context.projectInstructions.map((instruction) =>
      [
        `## ${instruction.path}${instruction.truncated ? ' (truncated)' : ''}`,
        instruction.content
      ].join('\n')
    )
  ].join('\n\n');
}

export function formatUserSkills(params: GenericAgentRuntimeParams): string {
  if (
    params.context.toolContext.skills.length === 0 &&
    params.context.toolContext.activeSkills.length === 0 &&
    params.context.toolContext.skillIndex.length === 0
  ) {
    return '';
  }

  return [
    params.context.toolContext.skills.length ? 'User-provided Agent Skills enabled for this project:' : '',
    ...params.context.toolContext.skills.map((skill) =>
      [
        `## ${skill.name}`,
        skill.description ? `Purpose: ${skill.description}` : '',
        skill.trigger ? `Use when: ${skill.trigger}` : '',
        skill.dependencies?.length ? `Dependencies: ${skill.dependencies.join(', ')}` : '',
        skill.examples?.length ? ['Examples:', ...skill.examples.map((example) => `- ${example}`)].join('\n') : '',
        'Instructions:',
        skill.instruction
      ].filter(Boolean).join('\n')
    ),
    params.context.toolContext.activeSkills.length
      ? [
          'Explicitly invoked filesystem Agent Skills loaded for this turn:',
          ...params.context.toolContext.activeSkills.map((skill) =>
            [
              `## ${skill.name}`,
              skill.description ? `Purpose: ${skill.description}` : '',
              `Source: ${skill.source}`,
              `Trust: ${skill.trustLevel} · Verification: ${skill.verificationStatus}`,
              `Permission policy: ${skill.permissionPolicy} (skill metadata does not grant tool permission)`,
              `Script policy: ${skill.scriptPolicy}${skill.declaredScripts?.length ? ` · ${skill.declaredScripts.length} declared script(s), run only through normal host tool permission` : ''}`,
              skill.allowedTools?.length ? `Suggested tools: ${skill.allowedTools.join(', ')}` : '',
              'Instructions:',
              skill.instruction
            ].filter(Boolean).join('\n')
          )
        ].join('\n\n')
      : '',
    params.context.toolContext.skillIndex.length
      ? [
          'Filesystem Agent Skills available as metadata:',
          'When a task clearly matches one of these skills, prefer the matching skill workflow. Full native Claude SDK Skills integration is tracked separately; project-policy skills above are already loaded in this prompt.',
          ...params.context.toolContext.skillIndex.map((skill) =>
            [
              `## ${skill.name}`,
              skill.description ? `Purpose: ${skill.description}` : '',
              `Source: ${skill.source}`,
              `Invocable: user=${skill.userInvocable ? 'yes' : 'no'} model=${skill.modelInvocable ? 'yes' : 'no'}`,
              `Trust: ${skill.trustLevel} · Verification: ${skill.verificationStatus}`,
              `Permission policy: ${skill.permissionPolicy}`,
              skill.declaredScripts?.length ? `Declared scripts: ${skill.declaredScripts.length} (execute only through normal host tool permission)` : '',
              skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(', ')}` : ''
            ].filter(Boolean).join('\n')
          )
        ].join('\n\n')
      : ''
  ].filter(Boolean).join('\n\n');
}

export function formatResumeContext(params: GenericAgentRuntimeParams): string {
  const context = params.resumeContext;
  if (!context) {
    return '';
  }
  const transaction = context.resumeCursor?.transaction ?? context.lastToolBoundary?.transaction;
  const transactionSummary = transaction
    ? [
        'Resume tool transaction summary:',
        `- transactionId: ${transaction.id}`,
        `- toolUseId: ${transaction.toolUseId}`,
        `- toolName: ${transaction.toolName}`,
        `- toolClass: ${transaction.toolClass}`,
        `- phase/status: ${transaction.phase}/${transaction.status}`,
        `- eventCount: ${transaction.eventCount}`,
        transaction.permission
          ? `- permission: ${transaction.permission.policy}/${transaction.permission.risk}${transaction.permission.decision ? `/${transaction.permission.decision}` : ''}${transaction.permission.requestId ? ` request=${transaction.permission.requestId}` : ''}`
          : '',
        transaction.checkpoint
          ? `- checkpoint: ${transaction.checkpoint.policy}${transaction.checkpoint.status ? `/${transaction.checkpoint.status}` : ''}${transaction.checkpoint.snapshotId ? ` snapshot=${transaction.checkpoint.snapshotId}` : ''}`
          : ''
      ].filter(Boolean).join('\n')
    : '';

  return [
    'Resume context from Funplay:',
    JSON.stringify(
      {
        resumedFromRunId: context.resumedFromRunId,
        strategy: context.strategy,
        previousStatus: context.previousStatus,
        coreState: context.coreState,
        checkpointSnapshotId: context.checkpointSnapshotId,
        filesRestoredToCheckpoint: context.filesRestoredToCheckpoint,
        lastError: context.lastError,
        lastToolBoundary: context.lastToolBoundary,
        resumeCursor: context.resumeCursor,
        recentTimeline: context.recentTimeline
      },
      null,
      2
    ),
    'Resume rules:',
    '- This is a resumed run, not a fresh task.',
    '- If lastToolBoundary.status is completed, treat that tool as already completed and avoid repeating it unless necessary.',
    transaction ? '- If the resume tool transaction summary shows status completed, treat that transactionId/toolUseId as a host-recorded completion boundary and do not rerun the same tool just to catch up.' : '',
    '- If files were restored to checkpoint, continue from the current filesystem state.',
    '- Continue after the last known tool boundary and summarize what happened after resume.',
    transactionSummary
  ].filter(Boolean).join('\n');
}

function resolveClaudeContextSummary(params: GenericAgentRuntimeParams, override?: string): string | undefined {
  const overrideSummary = override?.trim();
  if (overrideSummary) {
    return overrideSummary;
  }

  return getClaudeRuntimeSession(params).runtimeOverrides?.claudeContextSummary?.trim() || undefined;
}

function buildClaudeRecentTurnsForPrompt(params: GenericAgentRuntimeParams, coverageOverride?: ClaudeContextSummaryCoverage) {
  const session = getClaudeRuntimeSession(params);
  const uncoveredMessages = filterClaudeMessagesAfterSummaryBoundary(session, coverageOverride);
  const recentMessages = uncoveredMessages
    .slice(-CLAUDE_CONTEXT_RECENT_MESSAGE_KEEP)
    .map((message, index, array) => ({
      ...message,
      content: normalizeClaudeHistoryMessageContent(message, array.length - 1 - index)
    }));
  return buildSessionConversationTurns(recentMessages, 6);
}

export function createUserPrompt(params: GenericAgentRuntimeParams, options: {
  includeRecentTurns?: boolean;
  claudeContextSummaryOverride?: string;
  claudeContextSummaryCoverageOverride?: ClaudeContextSummaryCoverage;
} = {}): string {
  const includeRecentTurns = options.includeRecentTurns ?? true;
  const claudeContextSummary = resolveClaudeContextSummary(params, options.claudeContextSummaryOverride);
  const recentTurns = includeRecentTurns ? buildClaudeRecentTurnsForPrompt(params, options.claudeContextSummaryCoverageOverride) : [];

  return [
    'Current workspace context:',
    createResponseLanguageContextLine(params.uiLanguage),
    JSON.stringify(
      {
        projectName: params.context.projectName,
        projectPath: params.context.projectPath,
        platform: params.context.platform,
        runtimeEnvironment: params.context.runtimeEnvironment,
        currentGoal: params.context.currentGoal,
        projectContextIndex: params.context.projectContextIndex,
        sessionMode: params.context.sessionMode,
        sessionEffort: params.context.sessionEffort,
        runtimeSummary: params.context.runtimeSummary,
        executionPlanSummary: params.context.executionPlanSummary,
        lifecycleHookContext: params.lifecycleHookContext,
        activeSessionId: params.context.activeSessionId,
        toolContext: params.context.toolContext
      },
      null,
      2
    ),
    !claudeContextSummary && params.context.archivedSummary
      ? ['', `Earlier conversation summary (${params.context.archivedTurnCount} turns):`, params.context.archivedSummary].join('\n')
      : '',
    claudeContextSummary
      ? ['', 'Claude runtime long-context summary:', claudeContextSummary].join('\n')
      : '',
    formatResumeContext(params),
    params.lifecycleHookContext?.length
      ? [
          '',
          'Lifecycle hook additional context injected by the host runner:',
          ...params.lifecycleHookContext.map((context, index) => `## Hook Context ${index + 1}\n${context}`)
        ].join('\n\n')
      : '',
    formatProjectInstructions(params),
    formatUserSkills(params),
    includeRecentTurns && recentTurns.length
      ? [
          '',
          'Recent conversation turns:',
          ...recentTurns.slice(-6).map((turn, index) =>
            [
              `## Turn ${index + 1}`,
              turn.userMessage ? `User:\n${turn.userMessage}` : '',
              ...turn.assistantMessages.map((message) => `Assistant:\n${message.content}`)
            ]
              .filter(Boolean)
              .join('\n\n')
          )
        ].join('\n\n')
      : '',
    '',
    `User request:\n${params.message}`
  ]
    .filter(Boolean)
    .join('\n');
}

export function normalizeAttachmentMimeType(attachment: PromptAttachment): string {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType) {
    return mimeType;
  }

  switch (extname(attachment.path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
    default:
      return 'image/png';
  }
}

export function readAttachmentImageBase64(attachment: PromptAttachment): { data: string; byteLength: number; source: 'file' | 'previewDataUrl' } | undefined {
  try {
    const data = readFileSync(attachment.path);
    return {
      data: data.toString('base64'),
      byteLength: data.byteLength,
      source: 'file'
    };
  } catch {
    const match = attachment.previewDataUrl?.match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) {
      return undefined;
    }
    const mimeType = match[1]?.trim().toLowerCase();
    if (!mimeType || !CLAUDE_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      return undefined;
    }
    try {
      const buffer = Buffer.from(match[2] ?? '', 'base64');
      return {
        data: buffer.toString('base64'),
        byteLength: buffer.byteLength,
        source: 'previewDataUrl'
      };
    } catch {
      return undefined;
    }
  }
}

export function buildClaudeAttachmentPromptBlocks(params: GenericAgentRuntimeParams, textPrompt: string): {
  prompt: string | AsyncIterable<SDKUserMessage>;
  imageCount: number;
  degradedCount: number;
  droppedImageCount: number;
  totalMediaBytes: number;
  degradeReasons: string[];
} {
  const attachments = params.attachments ?? [];
  if (attachments.length === 0) {
    return {
      prompt: textPrompt,
      imageCount: 0,
      degradedCount: 0,
      droppedImageCount: 0,
      totalMediaBytes: 0,
      degradeReasons: []
    };
  }

  const blocks: ClaudeSdkPromptContentBlock[] = [];
  const notes: string[] = [];
  const degradeReasons: string[] = [];
  let imageCount = 0;
  let degradedCount = 0;
  let totalMediaBytes = 0;
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  const retainedImageIds = new Set(
    imageAttachments
      .slice(-CLAUDE_IMAGE_ATTACHMENT_MAX_COUNT)
      .map((attachment) => attachment.id)
  );
  let droppedImageCount = Math.max(0, imageAttachments.length - retainedImageIds.size);

  for (const attachment of attachments) {
    const pathLabel = attachment.relativePath || attachment.path;
    const meta = [
      attachment.kind,
      attachment.mimeType,
      `${attachment.size} bytes`
    ].filter(Boolean).join(', ');
    if (attachment.kind !== 'image') {
      notes.push(`File attachment "${attachment.name}" is available at: ${pathLabel}${meta ? ` (${meta})` : ''}`);
      continue;
    }
    if (!retainedImageIds.has(attachment.id)) {
      notes.push(`Image attachment "${attachment.name}" was dropped from Claude vision input because only the most recent ${CLAUDE_IMAGE_ATTACHMENT_MAX_COUNT} images are sent. Use path: ${pathLabel}`);
      continue;
    }

    const mimeType = normalizeAttachmentMimeType(attachment);
    if (!CLAUDE_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      degradedCount += 1;
      degradeReasons.push('unsupported_mime');
      notes.push(`Image attachment "${attachment.name}" was not sent as vision input because ${mimeType} is unsupported. Use path: ${pathLabel}`);
      continue;
    }
    if (attachment.size > CLAUDE_IMAGE_ATTACHMENT_MAX_BYTES) {
      degradedCount += 1;
      degradeReasons.push('image_too_large');
      notes.push(`Image attachment "${attachment.name}" was not sent as vision input because it is larger than ${CLAUDE_IMAGE_ATTACHMENT_MAX_BYTES} bytes. Use path: ${pathLabel}`);
      continue;
    }

    const imageData = readAttachmentImageBase64(attachment);
    if (!imageData) {
      degradedCount += 1;
      degradeReasons.push('read_failed');
      notes.push(`Image attachment "${attachment.name}" could not be read for vision input. Use path: ${pathLabel}`);
      continue;
    }
    if (totalMediaBytes + imageData.byteLength > CLAUDE_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES) {
      degradedCount += 1;
      droppedImageCount += 1;
      degradeReasons.push('media_budget_exceeded');
      notes.push(`Image attachment "${attachment.name}" was not sent as vision input because the total media budget is ${CLAUDE_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES} bytes. Use path: ${pathLabel}`);
      continue;
    }

    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: imageData.data
      }
    });
    imageCount += 1;
    totalMediaBytes += imageData.byteLength;
    notes.push(`Image attachment "${attachment.name}" is included as a Claude vision content block from ${imageData.source} and is also available at: ${pathLabel}`);
  }

  const text = [
    textPrompt,
    notes.length ? ['', 'Attachment vision routing:', ...notes].join('\n') : ''
  ].filter(Boolean).join('\n');
  if (blocks.length === 0) {
    return {
      prompt: text,
      imageCount,
      degradedCount,
      droppedImageCount,
      totalMediaBytes,
      degradeReasons
    };
  }

  const content: ClaudeSdkPromptContentBlock[] = [
    {
      type: 'text',
      text
    },
    ...blocks
  ];

  return {
    prompt: (async function* (): AsyncGenerator<SDKUserMessage, void> {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content
        } as SDKUserMessage['message'],
        parent_tool_use_id: null
      };
    })(),
    imageCount,
    degradedCount,
    droppedImageCount,
    totalMediaBytes,
    degradeReasons
  };
}

export function createClaudeSdkPrompt(params: GenericAgentRuntimeParams, options: {
  includeRecentTurns?: boolean;
  claudeContextSummaryOverride?: string;
  claudeContextSummaryCoverageOverride?: ClaudeContextSummaryCoverage;
} = {}): {
  prompt: string | AsyncIterable<SDKUserMessage>;
  imageCount: number;
  degradedCount: number;
  droppedImageCount: number;
  totalMediaBytes: number;
  degradeReasons: string[];
} {
  return buildClaudeAttachmentPromptBlocks(params, createUserPrompt(params, options));
}
