import { generateText, streamText } from 'ai';
import { z } from 'zod';
import { createLanguageModel } from './ai-provider';
import { generateOpenAiCompatibleText } from './openai-compatible-client';
import { getChatMessageContextText } from '../../shared/project-sessions';
import type { ProjectAgentContext } from './game-context-manager';
import type { AiExecutionReplan, AiProjectPlan, AiProjectUpdate, AiProvider, GameAgentAction, Project } from '../../shared/types';

function trimConversationForPrompt(project: Project): Array<{ role: string; content: string }> {
  return project.chat.slice(-8).map((message) => ({
    role: message.role,
    content: getChatMessageContextText(message, 1600)
  }));
}

const taskPhaseSchema = z.enum(['Concept', 'Content', 'Unity', 'Validation']);
const assetTypeSchema = z.enum(['character', 'environment', 'ui', 'audio', 'vfx']);
const pluginKindSchema = z.enum(['engine', 'asset', 'qa', 'custom']);
const executionActionSchema = z.object({
  pluginKind: pluginKindSchema,
  title: z.string().min(2),
  objective: z.string().min(6),
  suggestedTools: z.array(z.string().min(1)).max(6),
  inputs: z.array(z.string().min(2)).max(6),
  operations: z.array(
    z.object({
      type: z.enum(['tool_call', 'resource_read']),
      target: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional()
    })
  ).max(8),
  successCriteria: z.array(z.string().min(2)).max(6)
});
const executionPlanSchema = z.object({
  summary: z.string().min(6),
  rationale: z.string().min(6),
  actions: z.array(executionActionSchema).min(1).max(8)
});
const repairActionSchema = executionActionSchema.extend({
  repairSummary: z.string().min(6)
});
const executionReplanSchema = z.object({
  executionPlan: executionPlanSchema,
  assistantReply: z.string().min(12),
  activitySummary: z.string().min(6)
});

const aiProjectPlanSchema = z.object({
  premise: z.string().min(10),
  playerFantasy: z.string().min(8),
  targetAudience: z.string().min(6),
  artDirection: z.string().min(8),
  coreLoop: z.array(z.string().min(2)).min(3).max(6),
  pillars: z.array(z.string().min(2)).min(3).max(5),
  differentiators: z.array(z.string().min(2)).min(2).max(5),
  tasks: z.array(
    z.object({
      title: z.string().min(2),
      phase: taskPhaseSchema,
      owner: z.string().min(2),
      description: z.string().min(6)
    })
  ).min(3).max(8),
  assets: z.array(
    z.object({
      name: z.string().min(2),
      type: assetTypeSchema,
      prompt: z.string().min(6),
      notes: z.string().min(2)
    })
  ).min(3).max(10),
  executionPlan: executionPlanSchema,
  assistantReply: z.string().min(12)
});

const aiProjectUpdateSchema = z.object({
  premise: z.string().min(10).optional(),
  playerFantasy: z.string().min(8).optional(),
  targetAudience: z.string().min(6).optional(),
  artDirection: z.string().min(8).optional(),
  coreLoop: z.array(z.string().min(2)).min(3).max(6).optional(),
  pillars: z.array(z.string().min(2)).min(3).max(5).optional(),
  differentiators: z.array(z.string().min(2)).min(2).max(5).optional(),
  tasksToAdd: z.array(
    z.object({
      title: z.string().min(2),
      phase: taskPhaseSchema,
      owner: z.string().min(2),
      description: z.string().min(6)
    })
  ).max(6),
  assetsToAdd: z.array(
    z.object({
      name: z.string().min(2),
      type: assetTypeSchema,
      prompt: z.string().min(6),
      notes: z.string().min(2)
    })
  ).max(6),
  executionPlan: executionPlanSchema,
  assistantReply: z.string().min(12),
  activitySummary: z.string().min(6)
});

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Model did not return valid JSON.');
}

function createBoundAbortSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  return externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

async function generateJson<T>(
  provider: AiProvider,
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  abortSignal?: AbortSignal
): Promise<T> {
  if (provider.protocol === 'openai-compatible') {
    const result = await generateOpenAiCompatibleText({
      provider,
      system,
      prompt,
      maxOutputTokens: 4096,
      abortSignal: createBoundAbortSignal(120_000, abortSignal)
    });
    const parsed = JSON.parse(extractJson(result.text));
    return schema.parse(parsed);
  }

  const model = createLanguageModel(provider);
  const result = await generateText({
    model,
    system,
    prompt,
    maxOutputTokens: 4096,
    abortSignal: createBoundAbortSignal(120_000, abortSignal)
  });

  const parsed = JSON.parse(extractJson(result.text));
  return schema.parse(parsed);
}

export async function testProviderConnection(provider: AiProvider): Promise<string> {
  if (provider.protocol === 'openai-compatible') {
    const result = await generateOpenAiCompatibleText({
      provider,
      system: 'You are a connectivity probe.',
      prompt: 'Reply with exactly: OK',
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(30_000)
    });
    return result.text.trim();
  }

  const model = createLanguageModel(provider);
  const result = await generateText({
    model,
    system: 'You are a connectivity probe.',
    prompt: 'Reply with exactly: OK',
    maxOutputTokens: 16,
    abortSignal: AbortSignal.timeout(30_000)
  });
  return result.text.trim();
}

function buildProjectChatSystemPrompt(): string {
  return [
    '你是 Funplay 桌面应用里的 AI 开发搭档。',
    '你的主要职责是和用户进行自然、多轮、连续的通用工作对话。',
    '面向小白用户，回答必须直接、清晰、可执行，不要空话。',
    '优先结合最近对话和当前工作区信息来回答。',
    '如果用户在问方案、下一步、实现建议，请用简洁结构化表达。',
    '如果用户只是在聊天或提问，就直接回答，不要强行扩展需求。',
    '允许输出 Markdown，允许使用列表、标题和代码块。',
    '如果提到文件，请优先输出项目内相对路径，方便前端点击打开。'
  ].join('\n');
}

function buildProjectChatPrompt(project: Project, message: string, _context?: ProjectAgentContext): string {
  return [
    '当前工作区信息：',
    JSON.stringify(
      {
        name: project.name,
        status: project.status,
        engine: project.engine
          ? {
              platform: project.engine.platform,
              projectPath: project.engine.projectPath,
              dimension: project.engine.dimension
            }
          : undefined,
        runtime: project.runtimeState
          ? {
              projectExists: project.runtimeState.projectExists,
              projectOpen: project.runtimeState.projectOpen,
              bridgeStatus: project.runtimeState.bridgeHealth?.status,
              mcpEnabled: project.runtimeState.mcpSettings?.enabled,
              mcpUrl: project.runtimeState.mcpSettings?.url
            }
          : undefined,
        recentConversation: trimConversationForPrompt(project)
      },
      null,
      2
    ),
    '',
    `用户刚刚说：${message}`,
    '',
    '请直接回复用户。要求：',
    '1. 回答保持对话感，不要输出 JSON。',
    '2. 如果需要给建议，优先给最重要的 1~3 条。',
    '3. 如果上下文不足，要明确告诉用户还缺什么。',
    '4. 如果能从当前上下文推断下一步，可以直接建议。',
    '5. 不要编造已经执行过的工具结果。',
    '6. 不要默认把问题理解成游戏设计、玩法设计或资源规划，除非用户明确要求。'
  ].join('\n');
}

export async function generateProjectChatReplyWithAi(
  provider: AiProvider,
  project: Project,
  message: string,
  context?: ProjectAgentContext,
  abortSignal?: AbortSignal
): Promise<string> {
  if (provider.protocol === 'openai-compatible') {
    const result = await generateOpenAiCompatibleText({
      provider,
      system: buildProjectChatSystemPrompt(),
      prompt: buildProjectChatPrompt(project, message, context),
      maxOutputTokens: 2048,
      abortSignal: createBoundAbortSignal(120_000, abortSignal)
    });
    return result.text.trim();
  }

  const model = createLanguageModel(provider);
  const result = await generateText({
    model,
    system: buildProjectChatSystemPrompt(),
    prompt: buildProjectChatPrompt(project, message, context),
    maxOutputTokens: 2048,
    abortSignal: createBoundAbortSignal(120_000, abortSignal)
  });

  return result.text.trim();
}

export async function streamProjectChatReplyWithAi(
  provider: AiProvider,
  project: Project,
  message: string,
  context: ProjectAgentContext | undefined,
  options: {
    abortSignal?: AbortSignal;
    onDelta?: (delta: string, accumulated: string) => void;
  }
): Promise<string> {
  if (provider.protocol === 'openai-compatible') {
    const result = await generateOpenAiCompatibleText({
      provider,
      system: buildProjectChatSystemPrompt(),
      prompt: buildProjectChatPrompt(project, message, context),
      maxOutputTokens: 2048,
      abortSignal: createBoundAbortSignal(120_000, options.abortSignal),
      onDelta: options.onDelta
    });
    return result.text.trim();
  }

  const model = createLanguageModel(provider);
  const result = streamText({
    model,
    system: buildProjectChatSystemPrompt(),
    prompt: buildProjectChatPrompt(project, message, context),
    maxOutputTokens: 2048,
    abortSignal: createBoundAbortSignal(120_000, options.abortSignal)
  });

  let accumulated = '';
  for await (const delta of result.textStream) {
    accumulated += delta;
    options.onDelta?.(delta, accumulated);
  }

  return accumulated.trim();
}

export async function generateProjectPlanWithAi(
  provider: AiProvider,
  input: {
    name: string;
    templateName: string;
    artStyle: string;
    pitch: string;
  },
  extraContext?: {
    plugins?: Array<{
      kind: string;
      name: string;
      toolNames: string[];
      observations?: string[];
      projectContext?: string;
    }>;
  }
): Promise<AiProjectPlan> {
  return generateJson(
    provider,
    [
      '你是 Funplay 的 AI 游戏制作总监。',
      '你的任务是把用户的一句话创意整理成桌面端产品可执行的结构化项目蓝图。',
      '你必须只返回 JSON，不要输出 markdown，不要解释。',
      '任务 phase 只能是 Concept、Content、Unity、Validation。',
      '资源 type 只能是 character、environment、ui、audio、vfx。',
      'executionPlan.actions[].pluginKind 只能是 engine、asset、qa、custom。'
    ].join('\n'),
    [
      '请基于以下输入生成首版游戏制作蓝图 JSON：',
      `项目名：${input.name}`,
      `模板类型：${input.templateName}`,
      `美术风格：${input.artStyle}`,
      `创意描述：${input.pitch}`,
      extraContext ? `额外上下文：${JSON.stringify(extraContext, null, 2)}` : '',
      '',
      '要求：',
      '1. 输出适合非技术用户理解的表达。',
      '2. 任务数控制在 4~6 条，资源项 4~6 条。',
      '3. 必须给出 executionPlan，描述 engine / asset / qa 等插件下一步分别该做什么。',
      '4. executionPlan.actions 必须带 operations；写操作使用 tool_call，并给出完整 arguments。',
      '5. `execute_code` 的 arguments 里必须提供 `code` 字段。',
      '6. executionPlan 里的 suggestedTools 只写工具名，不要写解释。',
      '7. 如果当前上下文没有某类插件，也可以只输出已有插件类型。',
      '8. assistantReply 需要以制作总监口吻告诉用户接下来怎么推进。',
      '9. 所有字段都用简体中文，保留 phase/type/pluginKind 枚举值原样。'
    ].join('\n'),
    aiProjectPlanSchema
  );
}

export async function generateProjectUpdateWithAi(
  provider: AiProvider,
  project: Project,
  message: string,
  context?: ProjectAgentContext,
  abortSignal?: AbortSignal
): Promise<AiProjectUpdate> {
  return generateJson(
    provider,
    [
      '你是 Funplay 的 AI 游戏制作总监。',
      '你会基于已有项目蓝图和用户新增需求，返回结构化的增量更新 JSON。',
      '只返回 JSON，不要输出 markdown，不要解释。',
      '如果某些蓝图字段不需要改动，可以省略。',
      '任务 phase 只能是 Concept、Content、Unity、Validation。',
      '资源 type 只能是 character、environment、ui、audio、vfx。',
      'executionPlan.actions[].pluginKind 只能是 engine、asset、qa、custom。'
    ].join('\n'),
    [
      '当前项目摘要：',
      JSON.stringify(
        {
          name: project.name,
          templateId: project.templateId,
          artStyle: project.artStyle,
          pitch: project.pitch,
          blueprint: project.blueprint,
          tasks: project.tasks.map((task) => ({
            title: task.title,
            phase: task.phase,
            status: task.status
          })),
          assets: project.assets.map((asset) => ({
            name: asset.name,
            type: asset.type
          })),
          context
        },
        null,
        2
      ),
      '',
      `用户新需求：${message}`,
      '',
      '要求：',
      '1. 只返回和新需求相关的增量任务与资源。',
      '2. 必须给出 executionPlan，说明多插件下一步如何协同。',
      '3. executionPlan.actions 必须带 operations；写操作使用 tool_call，并给出完整 arguments。',
      '4. `execute_code` 的 arguments 里必须提供 `code` 字段。',
      '5. 如果上下文里有 plugin observations，要利用这些信息来制定计划。',
      '6. assistantReply 直接告诉用户你更新了什么以及下一步建议。',
      '7. activitySummary 用一句话概括这次更新。'
    ].join('\n'),
    aiProjectUpdateSchema,
    abortSignal
  );
}

export async function generateRepairActionWithAi(
  provider: AiProvider,
  params: {
    project: Project;
    action: GameAgentAction;
    diagnostics: string[];
    context?: ProjectAgentContext;
  }
): Promise<GameAgentAction & { repairSummary: string }> {
  const result = await generateJson(
    provider,
    [
      '你是 Funplay 的自动修复调度器。',
      '你会根据失败动作和诊断信息，返回一个单独的 repair action。',
      '只返回 JSON，不要输出 markdown。',
      'operations 必须是可执行的具体步骤；如果使用 execute_code，arguments 里必须有 code。'
    ].join('\n'),
    [
      '项目信息：',
      JSON.stringify(
        {
          name: params.project.name,
          blueprint: params.project.blueprint,
          currentExecutionPlan: params.project.currentExecutionPlan,
          failedAction: params.action,
          diagnostics: params.diagnostics,
          context: params.context
        },
        null,
        2
      ),
      '',
      '要求：',
      '1. 只返回一个适合自动修复的 action。',
      '2. 优先小步修复，不要做大范围重构。',
      '3. 如需执行脚本修改，请优先用 execute_code。'
    ].join('\n'),
    repairActionSchema
  );

  return {
    id: `repair_${Math.random().toString(36).slice(2, 10)}`,
    pluginKind: result.pluginKind,
    title: result.title,
    objective: result.objective,
    suggestedTools: result.suggestedTools,
    inputs: result.inputs,
    operations: result.operations,
    successCriteria: result.successCriteria,
    status: 'suggested',
    repairSummary: result.repairSummary
  };
}

export async function generateExecutionReplanWithAi(
  provider: AiProvider,
  params: {
    project: Project;
    executedPlan: unknown;
    diagnostics: string[];
    context?: ProjectAgentContext;
  }
): Promise<AiExecutionReplan> {
  return generateJson(
    provider,
    [
      '你是 Funplay 的多插件执行调度总监。',
      '你会根据刚执行完成的一轮计划结果，生成下一轮结构化执行计划。',
      '只返回 JSON，不要输出 markdown。',
      'executionPlan.actions 必须带 operations；写操作使用 tool_call，并提供完整 arguments。',
      '如果当前没有必要继续执行，可以给出更少的动作，但至少保留一个最合理的下一步。'
    ].join('\n'),
    [
      '执行反馈再规划输入：',
      JSON.stringify(
        {
          project: {
            name: params.project.name,
            blueprint: params.project.blueprint,
            memory: params.project.memory,
            contextSummary: params.project.contextSummary
          },
          executedPlan: params.executedPlan,
          diagnostics: params.diagnostics,
          context: params.context
        },
        null,
        2
      ),
      '',
      '要求：',
      '1. executionPlan 要直接服务下一轮执行。',
      '2. 对已经完成的动作，不要简单重复，除非诊断明确显示仍有问题。',
      '3. assistantReply 用简体中文总结本轮结果和下一轮重点。',
      '4. activitySummary 用一句话概括本次再规划。'
    ].join('\n'),
    executionReplanSchema
  );
}
