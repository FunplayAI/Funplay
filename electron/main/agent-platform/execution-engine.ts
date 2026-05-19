import { createSnapshot, materializeExecutionPlan } from '../../../shared/planner';
import { appendProjectAssistantMessage, ensureProjectSessions, getActiveProjectSession } from '../../../shared/project-sessions';
import type {
  AgentCoreProviderStepResult,
  AgentToolMcpResult,
  AgentToolTransactionSummary,
  AgentOperationRecord,
  AgentOperationStatus,
  AppState,
  ChatContentBlock,
  GameAgentAction,
  GameAgentRun,
  GameAgentStep,
  GameAgentExecutionPlan,
  McpPlugin,
  Project,
  UnityMcpCallResult,
  UnityMcpTool
} from '../../../shared/types';
import { makeId, nowIso } from '../../../shared/utils';
import { buildProjectAgentContext, refreshProjectContext } from '../game-context-manager';
import { buildExecutionOperationLog, createExecutionPlanOperationLogCollector } from './operation-log';
import { resolveProjectPluginByKind } from '../mcp-plugin-service';
import { getDefaultProvider } from '../provider-service';
import { assembleGameTools, executeUnityTool } from '../game-tool-layer';
import { getAgentSettings } from '../store';
import { readUnityResource } from '../unity-mcp-client';
import { generateExecutionReplanWithAi, generateRepairActionWithAi } from '../text-generator';
import { resolveAgentToolPermission, type AgentPermissionContext } from './permission-broker';
import { listSessionMcpToolPermissionKeys, listSessionWritePermissionTools, hasSessionWritePermission } from './permission-session-store';
import { createExecutePlanStageMachine, type ExecutePlanStageEvent, type ExecutePlanStageMachine } from './execute-plan-state-machine';
import { createAgentRunController, type AgentRunControllerSnapshot } from './agent-run-controller';
import {
  advanceToolExecutorTransaction,
  completeToolExecutorTransaction,
  createToolExecutorTransaction,
  createToolExecutorTransactionSummary,
  normalizeToolExecutorTransactionResult
} from './tool-executor';

interface ExecutePlanStreamCallbacks {
  onStatus?: (message: string) => void;
  onToolUse?: (tool: {
    toolUseId: string;
    name: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed';
  }) => void;
  onToolResult?: (result: {
    toolUseId: string;
    toolName?: string;
    content: string;
    isError?: boolean;
    mcp?: AgentToolMcpResult;
    transaction?: AgentToolTransactionSummary;
  }) => void;
  onStage?: (stage: ExecutePlanStageEvent) => void;
  onPermissionRequest?: (request: {
    requestId: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
  }) => void;
  requestPermission?: (request: {
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
  }) => Promise<'allow' | 'allow_session' | 'deny'>;
  onPlanPermissionRequest?: (request: {
    toolUseId: string;
    requestId: string;
    toolName: string;
    title: string;
    detail: string;
    risk: 'low' | 'medium' | 'high';
    input?: Record<string, unknown>;
    impact?: Record<string, unknown>;
  }) => void;
  onPlanPermissionResolved?: (result: {
    toolUseId: string;
    toolName: string;
    decision: 'allow' | 'deny';
    content: string;
    recoveryHint?: string;
    transaction?: AgentToolTransactionSummary;
  }) => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createStep(kind: GameAgentStep['kind'], title: string, detail: string, status: GameAgentStep['status']): GameAgentStep {
  return {
    id: makeId('step'),
    kind,
    title,
    detail,
    status
  };
}

function summarizeResult(result: UnityMcpCallResult): string {
  const text = result.content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n')
    .trim();

  if (text) {
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }

  const imageCount = result.content.filter((part) => part.type === 'image').length;
  if (imageCount > 0) {
    return `Produced ${imageCount} image result(s).`;
  }

  return 'No output.';
}

const EXECUTION_PLAN_MCP_TIMEOUT_MS = 60_000;

function byteLengthOfJson(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? {})).length;
  } catch {
    return undefined;
  }
}

function createExecutionPlanMcpMetadata(
  plugin: McpPlugin,
  action: GameAgentAction,
  operation: GameAgentAction['operations'][number],
  options: {
    contentPartCount?: number;
    failureKind?: AgentToolMcpResult['failureKind'];
    schemaGuard?: AgentToolMcpResult['schemaGuard'];
  } = {}
): AgentToolMcpResult {
  const args = operation.type === 'tool_call' ? operation.arguments ?? {} : { uri: operation.target };
  return {
    pluginId: plugin.id,
    pluginKind: action.pluginKind,
    operation: operation.type === 'resource_read' ? 'read_resource' : 'call_tool',
    target: operation.target,
    exposedName: operation.type === 'tool_call' ? operation.target : undefined,
    policySummary: operation.type === 'tool_call' && isWriteTool(operation.target) ? 'ask/external_best_effort' : 'host-validated',
    timeoutMs: EXECUTION_PLAN_MCP_TIMEOUT_MS,
    argsSize: byteLengthOfJson(args),
    contentPartCount: options.contentPartCount,
    schemaGuard: options.schemaGuard ?? (options.failureKind ? 'failed' : 'passed'),
    failureKind: options.failureKind
  };
}

function hasEmptyInputSchema(tool: UnityMcpTool): boolean {
  const schema = tool.inputSchema ?? {};
  const properties =
    typeof schema.properties === 'object' && schema.properties
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return properties.length === 0 && required.length === 0;
}

function isWriteTool(toolName: string): boolean {
  return ['execute_code'].includes(toolName);
}

function buildUndoCheckpointCode(): string {
  return `
using UnityEditor;
public class FunPlayCheckpoint {
  public static string Run() {
    Undo.IncrementCurrentGroup();
    Undo.SetCurrentGroupName("Funplay Auto Checkpoint");
    return Undo.GetCurrentGroup().ToString();
  }
}`;
}

function buildUndoRollbackCode(groupId?: string): string {
  const groupLiteral = groupId ? intOrZero(groupId) : 0;
  return `
using UnityEditor;
using UnityEditor.SceneManagement;
public class FunPlayRollback {
  public static string Run() {
    ${groupLiteral > 0 ? `Undo.RevertAllDownToGroup(${groupLiteral});` : 'Undo.PerformUndo();'}
    AssetDatabase.Refresh();
    return "Rollback attempted via Unity Undo.";
  }
}`;
}

function intOrZero(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function createWriteCheckpoint(
  plugin: McpPlugin,
  _project: Project,
  action: GameAgentAction,
  abortSignal?: AbortSignal
): Promise<{ snapshotNote: string; undoGroup?: string }> {
  let undoGroup: string | undefined;
  try {
    const result = await executeUnityTool(plugin.baseUrl, 'execute_code', { code: buildUndoCheckpointCode() }, abortSignal);
    undoGroup = result.content.find((part) => part.type === 'text')?.text?.trim();
  } catch {
    undoGroup = undefined;
  }

  return {
    snapshotNote: `[Auto] Before ${action.pluginKind}:${action.title}`,
    undoGroup
  };
}

async function attemptRollback(plugin: McpPlugin, undoGroup?: string, abortSignal?: AbortSignal): Promise<string> {
  try {
    const result = await executeUnityTool(plugin.baseUrl, 'execute_code', { code: buildUndoRollbackCode(undoGroup) }, abortSignal);
    return summarizeResult(result);
  } catch (error) {
    return error instanceof Error ? error.message : 'Rollback failed';
  }
}

async function collectDiagnostics(project: Project, state: AppState, abortSignal?: AbortSignal): Promise<string[]> {
  const diagnostics: string[] = [];
  for (const kind of ['engine', 'qa'] as const) {
    const plugin = resolveProjectPluginByKind(state, project.mcpBindings, kind);
    if (!plugin) {
      continue;
    }

    try {
      const assembly = await assembleGameTools(plugin.baseUrl);
      for (const resource of ['unity://errors/compilation', 'unity://errors/console', 'unity://project/context']) {
        if (!assembly.resources.some((entry) => entry.uri === resource)) {
          continue;
        }
        const result = await readUnityResource(plugin.baseUrl, resource, abortSignal);
        diagnostics.push(`${plugin.name}/${resource}: ${summarizeResult(result)}`);
      }

      for (const toolName of ['get_compilation_status', 'get_console_logs']) {
        const tool = assembly.allTools.find((entry) => entry.name === toolName);
        if (tool && hasEmptyInputSchema(tool)) {
          const result = await executeUnityTool(plugin.baseUrl, toolName, {}, abortSignal);
          diagnostics.push(`${plugin.name}/${toolName}: ${summarizeResult(result)}`);
        }
      }
    } catch {
      diagnostics.push(`${plugin.name}: diagnostics unavailable`);
    }
  }

  return diagnostics;
}

function hasProblemSignals(outputs: string[]): boolean {
  const merged = outputs.join('\n').toLowerCase();
  return ['error', 'exception', 'failed', 'compile', 'cannot'].some((token) => merged.includes(token));
}

async function executeOperation(
  plugin: McpPlugin,
  action: GameAgentAction,
  operation: GameAgentAction['operations'][number],
  assembly: Awaited<ReturnType<typeof assembleGameTools>>,
  abortSignal?: AbortSignal,
  callbacks?: ExecutePlanStreamCallbacks
): Promise<{ output: string; executedTool?: string; readResource?: string }> {
  const toolUseId = makeId('tool');
  const toolName = operation.type === 'resource_read' ? 'read_resource' : operation.target;
  const input = operation.type === 'resource_read' ? { uri: operation.target, action: action.title } : operation.arguments ?? {};
  let transaction = createToolExecutorTransaction({
    toolUseId,
    toolName,
    toolClass: 'mcp',
    input
  });
  transaction = advanceToolExecutorTransaction(transaction, {
    phase: 'executing',
    eventType: 'execution_started',
    summary: `Executing execute-plan MCP operation ${toolName}.`,
    metadata: {
      actionId: action.id,
      actionTitle: action.title,
      operationType: operation.type,
      pluginId: plugin.id
    }
  });
  abortSignal?.throwIfAborted();
  callbacks?.onToolUse?.({
    toolUseId,
    name: toolName,
    input,
    status: 'running'
  });

  try {
    if (operation.type === 'resource_read') {
      const result = await readUnityResource(plugin.baseUrl, operation.target, abortSignal);
      const summary = `${operation.target}: ${summarizeResult(result)}`;
      const mcp = createExecutionPlanMcpMetadata(plugin, action, operation, {
        contentPartCount: result.content.length
      });
      transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
        content: summary,
        mcp
      }), {
        summary,
        metadata: {
          actionId: action.id,
          operationType: operation.type
        }
      });
      callbacks?.onToolResult?.({
        toolUseId,
        toolName,
        content: summary,
        mcp,
        transaction: createToolExecutorTransactionSummary(transaction)
      });
      callbacks?.onToolUse?.({
        toolUseId,
        name: toolName,
        input,
        status: 'completed'
      });
      return {
        output: summary,
        readResource: operation.target
      };
    }

    const tool = assembly.allTools.find((entry) => entry.name === operation.target);
    const args = operation.arguments ?? {};
    if (tool && !isWriteTool(operation.target) && !hasEmptyInputSchema(tool) && Object.keys(args).length === 0) {
      throw new Error(`Tool ${operation.target} requires arguments.`);
    }

    const result = await executeUnityTool(plugin.baseUrl, operation.target, args, abortSignal);
    const summary = `${operation.target}: ${summarizeResult(result)}`;
    const mcp = createExecutionPlanMcpMetadata(plugin, action, operation, {
      contentPartCount: result.content.length
    });
    transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
      content: summary,
      mcp
    }), {
      summary,
      metadata: {
        actionId: action.id,
        operationType: operation.type
      }
    });
    callbacks?.onToolResult?.({
      toolUseId,
      toolName,
      content: summary,
      mcp,
      transaction: createToolExecutorTransactionSummary(transaction)
    });
    callbacks?.onToolUse?.({
      toolUseId,
      name: toolName,
      input,
      status: 'completed'
    });
    return {
      output: summary,
      executedTool: operation.target
    };
  } catch (error) {
    const errorContent = error instanceof Error ? error.message : 'Execution failed';
    const mcp = createExecutionPlanMcpMetadata(plugin, action, operation, {
      failureKind: 'unknown',
      schemaGuard: 'failed'
    });
    transaction = completeToolExecutorTransaction(transaction, normalizeToolExecutorTransactionResult({
      content: errorContent,
      isError: true,
      mcp
    }), {
      summary: errorContent,
      metadata: {
        actionId: action.id,
        operationType: operation.type
      }
    });
    callbacks?.onToolResult?.({
      toolUseId,
      toolName,
      content: errorContent,
      isError: true,
      mcp,
      transaction: createToolExecutorTransactionSummary(transaction)
    });
    callbacks?.onToolUse?.({
      toolUseId,
      name: toolName,
      input,
      status: 'failed'
    });
    throw error;
  }
}

async function executeAction(
  state: AppState,
  project: Project,
  action: GameAgentAction,
  plugin: McpPlugin,
  permissionContext: AgentPermissionContext,
  abortSignal?: AbortSignal,
  callbacks?: ExecutePlanStreamCallbacks,
  stages?: ExecutePlanStageMachine
): Promise<GameAgentAction> {
  const startedAt = nowIso();
  const executedTools: string[] = [];
  const readResources: string[] = [];
  const outputs: string[] = [];
  let rollbackSummary = '';
  let repairSummary = '';

  const operations = action.operations.length > 0
    ? action.operations
    : [
        ...action.inputs.filter((input) => input.includes('://')).map((input) => ({
          type: 'resource_read' as const,
          target: input
        })),
        ...action.suggestedTools.slice(0, 2).map((toolName) => ({
          type: 'tool_call' as const,
          target: toolName,
          arguments: {}
        }))
      ];

  const containsWrite = operations.some((operation) => operation.type === 'tool_call' && isWriteTool(operation.target));
  let undoGroup: string | undefined;

  if (containsWrite) {
    const permissionToolName = 'execute_plan_unity_write';
    const permissionToolUseId = makeId('tool');
    const permissionRequestId = makeId('perm');
    const permissionInput = {
      actionId: action.id,
      actionTitle: action.title,
      pluginKind: action.pluginKind,
      operations: operations
        .filter((operation) => operation.type === 'tool_call' && isWriteTool(operation.target))
        .map((operation) => ({
          target: operation.target,
          arguments: operation.type === 'tool_call' ? operation.arguments : undefined
        }))
    };
    const permissionDetail = [
      `动作：${action.title}`,
      `插件：${plugin.name}`,
      `工具：${permissionToolName}`,
      '权限策略：ask',
      '检查点策略：external_best_effort',
      '允许后，本轮会执行写入型 Unity 工具，并尝试创建 Unity Undo checkpoint。'
    ].join('\n');
    let permissionTransaction = createToolExecutorTransaction({
      toolUseId: permissionToolUseId,
      toolName: permissionToolName,
      toolClass: 'mcp',
      input: permissionInput,
      permission: {
        policy: 'ask',
        risk: 'high',
        requestId: permissionRequestId
      },
      checkpoint: {
        policy: 'external_best_effort',
        status: 'pending'
      }
    });
    permissionTransaction = advanceToolExecutorTransaction(permissionTransaction, {
      phase: 'awaiting_permission',
      eventType: 'permission_requested',
      summary: 'Awaiting permission for execute-plan Unity writes.',
      metadata: {
        actionId: action.id,
        pluginId: plugin.id
      }
    });
    callbacks?.onPlanPermissionRequest?.({
      toolUseId: permissionToolUseId,
      requestId: permissionRequestId,
      toolName: permissionToolName,
      title: '允许执行计划修改 Unity 项目？',
      detail: permissionDetail,
      risk: 'high',
      input: permissionInput,
      impact: permissionInput
    });
    stages?.emit('execute', 'running', {
      stageId: `stage:execute_permission:${action.id}`,
      title: '校验执行计划写入权限',
      actionId: action.id,
      summary: `正在通过 Permission Broker 校验动作“${action.title}”的 Unity 写入权限。`,
      input: {
        actionTitle: action.title,
        permissionMode: permissionContext.permission.mode,
        toolName: permissionToolName
      }
    });
    const permissionDecision = await resolveAgentToolPermission(permissionContext, {
      tool: {
        name: permissionToolName,
        title: 'Execute Plan Unity Write',
        risk: 'high',
        readOnly: false,
        permissionPolicy: 'ask',
        checkpointPolicy: 'external_best_effort'
      },
      input: permissionInput,
      title: '允许执行计划修改 Unity 项目？',
      detail: permissionDetail,
      risk: 'high'
    });

    if (permissionDecision === 'deny') {
      const permissionDeniedContent = permissionContext.permission.mode === 'read-only' ? 'read-only 模式下阻止写操作。' : '写入权限未获批准，已跳过自动写操作。';
      permissionTransaction = advanceToolExecutorTransaction({
        ...permissionTransaction,
        permission: {
          policy: 'ask',
          risk: 'high',
          requestId: permissionRequestId,
          decision: 'deny'
        }
      }, {
        phase: 'recording_result',
        eventType: 'permission_denied',
        summary: 'Execution-plan Unity write permission denied.',
        metadata: {
          actionId: action.id,
          pluginId: plugin.id
        }
      });
      permissionTransaction = completeToolExecutorTransaction(permissionTransaction, normalizeToolExecutorTransactionResult({
        content: permissionDeniedContent,
        isError: true
      }), {
        summary: permissionDeniedContent,
        metadata: {
          actionId: action.id,
          pluginId: plugin.id
        }
      });
      callbacks?.onPlanPermissionResolved?.({
        toolUseId: permissionToolUseId,
        toolName: permissionToolName,
        decision: 'deny',
        content: permissionDeniedContent,
        recoveryHint: '执行计划可继续处理只读动作，或等待用户切换 Build/授权后重试写入动作。',
        transaction: createToolExecutorTransactionSummary(permissionTransaction)
      });
      stages?.emit('execute', 'skipped', {
        stageId: `stage:execute_permission:${action.id}`,
        title: '校验执行计划写入权限',
        actionId: action.id,
        summary: permissionDeniedContent,
        input: {
          actionTitle: action.title,
          permissionMode: permissionContext.permission.mode,
          toolName: permissionToolName
        }
      });
      return {
        ...action,
        pluginId: plugin.id,
        status: 'skipped',
        executedTools,
        readResources,
        outputSummary:
          permissionContext.permission.mode === 'read-only'
            ? '当前权限模式为 read-only，写操作已被阻止。'
            : '写入权限未获批准，自动写操作未执行。',
        errorMessage:
          permissionContext.permission.mode === 'read-only'
            ? 'Write actions are disabled in read-only mode.'
            : 'Write permission was not granted.',
        lastRunAt: startedAt
      };
    }

    permissionTransaction = advanceToolExecutorTransaction({
      ...permissionTransaction,
      permission: {
        policy: 'ask',
        risk: 'high',
        requestId: permissionRequestId,
        decision: 'allow'
      }
    }, {
      phase: 'recording_result',
      eventType: 'permission_allowed',
      summary: 'Execution-plan Unity write permission allowed.',
      metadata: {
        actionId: action.id,
        pluginId: plugin.id
      }
    });
    const permissionAllowedContent = '写入权限已获批准，继续执行 Unity 写入动作。';
    permissionTransaction = completeToolExecutorTransaction(permissionTransaction, normalizeToolExecutorTransactionResult({
      content: permissionAllowedContent
    }), {
      summary: permissionAllowedContent,
      metadata: {
        actionId: action.id,
        pluginId: plugin.id
      }
    });
    callbacks?.onPlanPermissionResolved?.({
      toolUseId: permissionToolUseId,
      toolName: permissionToolName,
      decision: 'allow',
      content: permissionAllowedContent,
      transaction: createToolExecutorTransactionSummary(permissionTransaction)
    });
    stages?.emit('execute', 'completed', {
      stageId: `stage:execute_permission:${action.id}`,
      title: '校验执行计划写入权限',
      actionId: action.id,
      summary: permissionAllowedContent,
      input: {
        actionTitle: action.title,
        permissionMode: permissionContext.permission.mode,
        toolName: permissionToolName
      }
    });
  }

  try {
    const assembly = await assembleGameTools(plugin.baseUrl);
    if (containsWrite) {
      stages?.emit('checkpoint', 'running', {
        stageId: `stage:execute_checkpoint:${action.id}`,
        title: '建立 Unity 写入检查点',
        actionId: action.id,
        summary: `正在为写入动作“${action.title}”创建 Unity Undo checkpoint。`
      });
      const checkpoint = await createWriteCheckpoint(plugin, project, action, abortSignal);
      undoGroup = checkpoint.undoGroup;
      stages?.emit('checkpoint', 'completed', {
        stageId: `stage:execute_checkpoint:${action.id}`,
        title: '建立 Unity 写入检查点',
        actionId: action.id,
        summary: undoGroup ? `已创建 Unity Undo group: ${undoGroup}` : '已尝试创建 Unity Undo checkpoint。',
        input: {
          actionTitle: action.title,
          undoGroup
        }
      });
    }

    for (const operation of operations) {
      abortSignal?.throwIfAborted();
      const result = await executeOperation(plugin, action, operation, assembly, abortSignal, callbacks);
      outputs.push(result.output);
      if (result.executedTool) executedTools.push(result.executedTool);
      if (result.readResource) readResources.push(result.readResource);
    }

    if (containsWrite || hasProblemSignals(outputs)) {
      stages?.emit('diagnose', 'running', {
        stageId: `stage:diagnose:${action.id}`,
        title: '收集执行诊断',
        actionId: action.id,
        summary: `正在诊断动作“${action.title}”的执行结果。`
      });
      const diagnostics = await collectDiagnostics(project, state, abortSignal);
      stages?.emit('diagnose', 'completed', {
        stageId: `stage:diagnose:${action.id}`,
        title: '收集执行诊断',
        actionId: action.id,
        summary: diagnostics.length > 0 ? `已收集 ${diagnostics.length} 条诊断。` : '没有收集到额外诊断。',
        input: {
          diagnosticCount: diagnostics.length
        }
      });
      const provider = getDefaultProvider(state);

      if (provider) {
        try {
          stages?.emit('repair', 'running', {
            stageId: `stage:repair:${action.id}`,
            title: '生成并执行修复动作',
            actionId: action.id,
            summary: `正在为动作“${action.title}”生成修复方案。`
          });
          const repairAction = await generateRepairActionWithAi(provider, {
            project,
            action,
            diagnostics,
            context: buildProjectAgentContext(project)
          });

          repairSummary = repairAction.repairSummary;
          const repairPlugin = resolveProjectPluginByKind(state, project.mcpBindings, repairAction.pluginKind) ?? plugin;
          const repairAssembly = await assembleGameTools(repairPlugin.baseUrl);
          for (const operation of repairAction.operations) {
            abortSignal?.throwIfAborted();
            const result = await executeOperation(repairPlugin, repairAction, operation, repairAssembly, abortSignal, callbacks);
            outputs.push(`repair:${result.output}`);
            if (result.executedTool) executedTools.push(result.executedTool);
            if (result.readResource) readResources.push(result.readResource);
          }
          stages?.emit('repair', 'completed', {
            stageId: `stage:repair:${action.id}`,
            title: '生成并执行修复动作',
            actionId: action.id,
            summary: repairSummary || '修复动作已执行完成。'
          });
        } catch (error) {
          repairSummary = error instanceof Error ? error.message : 'Repair action failed';
          stages?.emit('repair', 'failed', {
            stageId: `stage:repair:${action.id}`,
            title: '生成并执行修复动作',
            actionId: action.id,
            summary: repairSummary,
            errorMessage: repairSummary
          });
        }
      }

      stages?.emit('verify', 'running', {
        stageId: `stage:verify:${action.id}`,
        title: '验证执行结果',
        actionId: action.id,
        summary: `正在验证动作“${action.title}”修复后的项目状态。`
      });
      const postDiagnostics = await collectDiagnostics(project, state, abortSignal);
      if (hasProblemSignals(postDiagnostics)) {
        stages?.emit('verify', 'failed', {
          stageId: `stage:verify:${action.id}`,
          title: '验证执行结果',
          actionId: action.id,
          summary: `动作“${action.title}”修复后仍检测到问题。`,
          input: {
            diagnosticCount: postDiagnostics.length
          },
          errorMessage: 'Detected issues after execution and repair attempt.'
        });
        stages?.emit('rollback', 'running', {
          stageId: `stage:rollback:${action.id}`,
          title: '执行回滚',
          actionId: action.id,
          summary: `动作“${action.title}”修复后仍有问题，正在尝试 Unity Undo 回滚。`
        });
        rollbackSummary = await attemptRollback(plugin, undoGroup, abortSignal);
        stages?.emit('rollback', 'completed', {
          stageId: `stage:rollback:${action.id}`,
          title: '执行回滚',
          actionId: action.id,
          summary: rollbackSummary || 'Unity Undo 回滚已尝试完成。'
        });
        return {
          ...action,
          pluginId: plugin.id,
          status: 'failed',
          executedTools,
          readResources,
          outputSummary: [...outputs, ...postDiagnostics].join('\n'),
          errorMessage: 'Detected issues after execution and repair attempt.',
          repairSummary,
          rollbackSummary,
          lastRunAt: startedAt
        };
      }
      stages?.emit('verify', 'completed', {
        stageId: `stage:verify:${action.id}`,
        title: '验证执行结果',
        actionId: action.id,
        summary: postDiagnostics.length > 0 ? `验证完成，收集到 ${postDiagnostics.length} 条诊断。` : '验证完成，没有发现额外问题。',
        input: {
          diagnosticCount: postDiagnostics.length
        }
      });
    }

    if (executedTools.length === 0 && readResources.length === 0) {
      return {
        ...action,
        pluginId: plugin.id,
        status: 'skipped',
        executedTools,
        readResources,
        outputSummary: '当前计划动作没有可执行的操作。',
        lastRunAt: startedAt
      };
    }

    return {
      ...action,
      pluginId: plugin.id,
      status: 'completed',
      executedTools,
      readResources,
      outputSummary: outputs.join('\n'),
      repairSummary: repairSummary || undefined,
      rollbackSummary: rollbackSummary || undefined,
      lastRunAt: startedAt
    };
  } catch (error) {
    if (containsWrite) {
      stages?.emit('rollback', 'running', {
        stageId: `stage:rollback:${action.id}`,
        title: '执行回滚',
        actionId: action.id,
        summary: `动作“${action.title}”执行失败，正在尝试 Unity Undo 回滚。`
      });
      rollbackSummary = await attemptRollback(plugin, undoGroup, abortSignal);
      stages?.emit('rollback', 'completed', {
        stageId: `stage:rollback:${action.id}`,
        title: '执行回滚',
        actionId: action.id,
        summary: rollbackSummary || 'Unity Undo 回滚已尝试完成。'
      });
    }

    return {
      ...action,
      pluginId: plugin.id,
      status: 'failed',
      executedTools,
      readResources,
      outputSummary: outputs.join('\n'),
      errorMessage: error instanceof Error ? error.message : 'Execution failed',
      repairSummary: repairSummary || undefined,
      rollbackSummary: rollbackSummary || undefined,
      lastRunAt: startedAt
    };
  }
}

function summarizePlan(actions: GameAgentAction[]): string {
  const completed = actions.filter((action) => action.status === 'completed').length;
  const skipped = actions.filter((action) => action.status === 'skipped').length;
  const failed = actions.filter((action) => action.status === 'failed').length;
  return `计划执行完成：completed=${completed} / skipped=${skipped} / failed=${failed}`;
}

function buildFallbackNextPlan(executedPlan: GameAgentExecutionPlan): GameAgentExecutionPlan {
  const retryActions = executedPlan.actions
    .filter((action) => action.status === 'failed' || action.status === 'skipped')
    .map((action) => ({
      ...action,
      id: `${action.id}_next`,
      status: 'planned' as const,
      errorMessage: undefined,
      outputSummary: undefined,
      rollbackSummary: undefined,
      repairSummary: undefined,
      executedTools: [],
      readResources: [],
      lastRunAt: undefined
    }));

  if (retryActions.length > 0) {
    return {
      summary: '基于失败/跳过动作的下一轮重试计划',
      rationale: '优先处理未完成或需要重试的动作。',
      actions: retryActions
    };
  }

  return {
    summary: '当前执行已完成，等待新的创作指令或新的 AI 计划',
    rationale: '本轮计划已完成，没有必须自动继续的动作。',
    actions: []
  };
}

function mapOperationStatusToChatStatus(
  status: NonNullable<GameAgentRun['operationLog']>[number]['status']
): 'pending' | 'running' | 'completed' | 'failed' {
  if (status === 'pending') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  return 'failed';
}

function buildExecutionChatBlocks(run: GameAgentRun, assistantReply: string, diagnostics: string[]): ChatContentBlock[] {
  const blocks: ChatContentBlock[] = [
    {
      type: 'text',
      text: [
        assistantReply,
        '',
        `执行计划：${run.input}`,
        diagnostics.length > 0 ? `诊断摘要：\n${diagnostics.slice(0, 6).join('\n')}` : ''
      ].filter(Boolean).join('\n')
    }
  ];

  for (const record of run.operationLog ?? []) {
    blocks.push({
      type: 'tool_use',
      toolUseId: record.id,
      name: `${record.title} · ${record.target}`,
      input: record.input,
      status: mapOperationStatusToChatStatus(record.status)
    });

    if (record.summary || record.errorMessage) {
      blocks.push({
        type: 'tool_result',
        toolUseId: record.id,
        content: record.errorMessage || record.summary || '',
        isError: Boolean(record.errorMessage)
      });
    }
  }

  return blocks;
}

function mergeOperationLogs(...groups: AgentOperationRecord[][]): AgentOperationRecord[] {
  return groups
    .flat()
    .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
}

function summarizeRunControllerSnapshot(snapshot: AgentRunControllerSnapshot): Record<string, unknown> {
  return {
    state: snapshot.coreState.state,
    nextAction: snapshot.nextAction,
    providerStepCount: snapshot.providerStepCount,
    partCount: snapshot.parts.length,
    pendingToolUseIds: snapshot.pendingToolUseIds,
    completedToolUseIds: snapshot.completedToolUseIds,
    lastDecision: snapshot.lastDecision
      ? {
          outcome: snapshot.lastDecision.outcome,
          nextState: snapshot.lastDecision.nextState,
          terminal: snapshot.lastDecision.terminal,
          reason: snapshot.lastDecision.reason
        }
      : undefined
  };
}

export async function executeProjectPlanTurn(
  state: AppState,
  projectId: string,
  callbacks?: ExecutePlanStreamCallbacks,
  controller = new AbortController(),
  checkpointSnapshotId?: string
): Promise<{ project: Project; run: GameAgentRun }> {
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (index === -1) {
    throw new Error('Project not found.');
  }

  const project = state.projects[index];
  const ensuredProject = ensureProjectSessions(project);
  const activeSession = getActiveProjectSession(ensuredProject);
  const permissionMode = activeSession.runtimeOverrides?.permissionMode ?? ensuredProject.agentPolicy?.permissionMode ?? getAgentSettings().permissionMode;
  const sessionWriteTools = listSessionWritePermissionTools(activeSession.id);
  const sessionMcpTools = listSessionMcpToolPermissionKeys(activeSession.id);
  const permissionContext: AgentPermissionContext = {
    permission: {
      mode: permissionMode,
      allowWriteTools: permissionMode === 'full-access',
      allowSessionWriteTools: hasSessionWritePermission(activeSession.id, 'execute_plan_unity_write'),
      allowedWriteTools: permissionMode === 'full-access' ? ['*'] : sessionWriteTools,
      allowedMcpTools: sessionMcpTools
    },
    requestPermission: callbacks?.requestPermission
  };
  const currentPlan = project.currentExecutionPlan;
  const operationLogCollector = createExecutionPlanOperationLogCollector();
  const stages = createExecutePlanStageMachine((stage) => {
    operationLogCollector.onStage(stage);
    callbacks?.onStage?.(stage);
  });
  const runController = createAgentRunController();
  let latestRunControllerSnapshot = runController.start();
  let latestCoreProviderStep: AgentCoreProviderStepResult | undefined;
  const recordedControllerToolUseIds = new Set<string>();
  const controllerToolNamesByUseId = new Map<string, string>();
  const emitCoreStateStage = (status: AgentOperationStatus, summary: string): void => {
    callbacks?.onStage?.({
      stageId: 'stage:execute_plan_agent_core_v2',
      phase: 'execute',
      title: 'Agent Core v2 状态机',
      target: 'stage:execute_plan_agent_core_v2',
      status,
      summary,
      input: {
        coreState: latestRunControllerSnapshot.coreState,
        providerStep: latestCoreProviderStep,
        runController: summarizeRunControllerSnapshot(latestRunControllerSnapshot)
      }
    });
  };
  const controllerCallbacks: ExecutePlanStreamCallbacks = {
    ...callbacks,
    onToolUse: (tool) => {
      if ((tool.status === 'pending' || tool.status === 'running') && !recordedControllerToolUseIds.has(tool.toolUseId)) {
        recordedControllerToolUseIds.add(tool.toolUseId);
        controllerToolNamesByUseId.set(tool.toolUseId, tool.name);
        latestCoreProviderStep = {
          finishReason: 'tool_calls',
          toolCalls: [
            {
              toolUseId: tool.toolUseId,
              name: tool.name,
              input: tool.input
            }
          ]
        };
        latestRunControllerSnapshot = runController.recordProviderStep({
          providerStep: latestCoreProviderStep
        });
        emitCoreStateStage('running', `执行计划工具调用已进入 Agent Core：${tool.name}`);
      }
      callbacks?.onToolUse?.(tool);
    },
    onToolResult: (result) => {
      latestRunControllerSnapshot = runController.recordToolResult({
        toolUseId: result.toolUseId,
        toolName: controllerToolNamesByUseId.get(result.toolUseId),
        content: result.content,
        isError: result.isError,
        failureKind: result.isError ? result.mcp?.failureKind ?? 'execute_plan_tool_error' : undefined,
        mcp: result.mcp,
        transaction: result.transaction
      });
      emitCoreStateStage('completed', result.isError ? '执行计划工具错误已记录为结构化结果。' : '执行计划工具结果已记录为结构化结果。');
      callbacks?.onToolResult?.(result);
    },
    onPlanPermissionRequest: (request) => {
      recordedControllerToolUseIds.add(request.toolUseId);
      controllerToolNamesByUseId.set(request.toolUseId, request.toolName);
      latestCoreProviderStep = {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            toolUseId: request.toolUseId,
            name: request.toolName,
            input: request.input
          }
        ]
      };
      latestRunControllerSnapshot = runController.recordProviderStep({
        providerStep: latestCoreProviderStep,
        pendingPermission: {
          requestId: request.requestId,
          toolName: request.toolName,
          risk: request.risk,
          reason: request.detail,
          impact: request.impact
        }
      });
      emitCoreStateStage('running', `执行计划写入权限请求已进入 Agent Core：${request.toolName}`);
      callbacks?.onPlanPermissionRequest?.(request);
    },
    onPlanPermissionResolved: (result) => {
      latestRunControllerSnapshot = result.decision === 'allow'
        ? runController.recordPermissionApproved({
            toolUseId: result.toolUseId,
            toolName: result.toolName,
            content: result.content,
            transaction: result.transaction
          })
        : runController.recordPermissionDenied({
            toolUseId: result.toolUseId,
            toolName: result.toolName,
            content: result.content,
            recoveryHint: result.recoveryHint,
            transaction: result.transaction
          });
      emitCoreStateStage(result.decision === 'allow' ? 'completed' : 'skipped', result.content);
      callbacks?.onPlanPermissionResolved?.(result);
    }
  };

  if (!currentPlan || currentPlan.actions.length === 0) {
    throw new Error('No execution plan available for this project.');
  }

  try {
    callbacks?.onStatus?.('正在读取当前执行计划…');
    emitCoreStateStage('running', 'Execution Plan runtime 已接入 Agent Core v2 状态机。');

    const startedAt = nowIso();
    const executedActions: GameAgentAction[] = [];
    const executionSnapshots = [...project.snapshots];
    stages.emit('prepare', 'completed', {
      summary: `已装载 ${currentPlan.actions.length} 个待执行动作。`,
      input: {
        actionCount: currentPlan.actions.length,
        permissionMode
      }
    });
    if (checkpointSnapshotId) {
      stages.emit('checkpoint', 'completed', {
        summary: '已建立执行计划运行前会话检查点；写入型 Unity 动作会额外创建 Unity Undo checkpoint。',
        input: {
          checkpointSnapshotId,
          fileCheckpointTracked: false,
          unityUndoCheckpoint: true
        }
      });
    }

    for (const action of currentPlan.actions) {
      controller.signal.throwIfAborted();
      callbacks?.onStatus?.(`正在执行：${action.title}`);
      stages.emit('execute', 'running', {
        actionId: action.id,
        summary: `正在执行：${action.title}`,
        input: {
          pluginKind: action.pluginKind,
          operationCount: action.operations.length
        }
      });
      const plugin = resolveProjectPluginByKind(state, project.mcpBindings, action.pluginKind);
      if (!plugin) {
        stages.emit('execute', 'failed', {
          actionId: action.id,
          summary: `No plugin bound for kind=${action.pluginKind}`,
          errorMessage: `No plugin bound for kind=${action.pluginKind}`
        });
        executedActions.push({
          ...action,
          status: 'failed',
          errorMessage: `No plugin bound for kind=${action.pluginKind}`,
          lastRunAt: nowIso()
        });
        continue;
      }

      if (action.operations.some((operation) => operation.type === 'tool_call' && isWriteTool(operation.target))) {
        executionSnapshots.unshift(createSnapshot(project, `[Auto] Before write action: ${action.title}`));
      }

      executedActions.push(
        await executeAction(
          state,
          project,
          {
            ...action,
            status: 'running'
          },
          plugin,
          permissionContext,
          controller.signal,
          controllerCallbacks,
          stages
        )
      );
      const executedAction = executedActions[executedActions.length - 1];
      stages.emit('execute', executedAction?.status === 'failed' ? 'failed' : executedAction?.status === 'skipped' ? 'skipped' : 'completed', {
        actionId: action.id,
        summary: executedAction?.outputSummary || executedAction?.errorMessage || `已完成：${action.title}`,
        errorMessage: executedAction?.errorMessage
      });
    }

    const nextPlan: GameAgentExecutionPlan = {
      ...currentPlan,
      actions: executedActions,
      lastExecutedAt: nowIso()
    };

    const provider = getDefaultProvider(state);
    callbacks?.onStatus?.('正在收集执行诊断…');
    stages.emit('diagnose', 'running', {
      summary: '正在收集执行计划运行后的项目诊断。'
    });
    const diagnostics = await collectDiagnostics(project, state, controller.signal);
    stages.emit('diagnose', 'completed', {
      summary: diagnostics.length > 0 ? `已收集 ${diagnostics.length} 条计划级诊断。` : '没有收集到计划级诊断。',
      input: {
        diagnosticCount: diagnostics.length
      }
    });
    let replanned = buildFallbackNextPlan(nextPlan);
    let replanReply = '执行完成，已基于当前结果生成下一轮建议计划。';
    let replanActivity = summarizePlan(executedActions);

    if (provider) {
      try {
        callbacks?.onStatus?.('正在生成下一轮执行计划…');
        stages.emit('replan', 'running', {
          summary: '正在基于执行结果与诊断生成下一轮计划。'
        });
        const replan = await generateExecutionReplanWithAi(provider, {
          project,
          executedPlan: nextPlan,
          diagnostics,
          context: buildProjectAgentContext(refreshProjectContext(project))
        });
        replanned = materializeExecutionPlan(replan.executionPlan) ?? replanned;
        replanReply = replan.assistantReply;
        replanActivity = replan.activitySummary;
        stages.emit('replan', 'completed', {
          summary: replanActivity
        });
      } catch {
        stages.emit('replan', 'failed', {
          summary: 'AI replan 失败，保留 fallback 下一轮计划。',
          errorMessage: 'execution_replan_failed'
        });
        // keep fallback plan
      }
    } else {
      stages.emit('replan', 'skipped', {
        summary: '未配置默认 AI Provider，使用 fallback 下一轮计划。'
      });
    }

    const runStatus: GameAgentRun['status'] = executedActions.some((action) => action.status === 'failed') ? 'failed' : 'completed';
    stages.emit('commit', 'completed', {
      summary: '执行结果已准备写入项目状态、运行记录和当前会话。'
    });
    stages.emit('complete', runStatus === 'failed' ? 'failed' : 'completed', {
      summary: summarizePlan(executedActions)
    });
    latestCoreProviderStep = {
      text: replanReply,
      finishReason: 'stop',
      toolCalls: []
    };
    latestRunControllerSnapshot = runController.recordProviderStep({
      providerStep: latestCoreProviderStep
    });
    emitCoreStateStage(runStatus === 'failed' ? 'failed' : 'completed', 'Execution Plan runtime 已记录最终回复。');
    const operationLog = mergeOperationLogs(operationLogCollector.build(), buildExecutionOperationLog(executedActions));
    const executionRun: GameAgentRun = {
      id: makeId('run'),
      mode: 'execute-plan',
      input: currentPlan.summary,
      status: runStatus,
      usedProviderId: provider?.id,
      usedModel: provider?.model,
      startedAt,
      finishedAt: nowIso(),
      steps: [
        createStep('context', '读取当前执行计划', `已装载 ${currentPlan.actions.length} 个待执行动作。`, 'completed'),
        createStep('planning', '调度计划动作', summarizePlan(executedActions), runStatus === 'failed' ? 'failed' : 'completed'),
        createStep('planning', '生成下一轮计划', replanActivity, 'completed')
      ],
      pluginReports: [],
      executionPlan: replanned,
      operationLog
    };

    const updatedBase: Project = {
      ...refreshProjectContext(project),
      updatedAt: nowIso(),
      snapshots: executionSnapshots,
      currentExecutionPlan: replanned,
      lastExecutedPlan: nextPlan,
      activity: [
        {
          id: `act_${Date.now()}`,
          kind: 'planning',
          title: '执行计划已调度',
          detail: `${summarizePlan(executedActions)}；${replanActivity}`,
          createdAt: nowIso()
        },
        {
          id: `act_${Date.now()}_replan`,
          kind: 'planning',
          title: '执行反馈已自动再规划',
          detail: replanReply,
          createdAt: nowIso()
        },
        ...project.activity
      ],
      lastAgentRun: executionRun
    };

    const updated = appendProjectAssistantMessage(updatedBase, {
      sessionId: getActiveProjectSession(project).id,
      assistantMessage: replanReply,
      assistantContentBlocks: buildExecutionChatBlocks(executionRun, replanReply, diagnostics),
      assistantMetadata: {
        intent: 'chat',
        activitySummary: replanActivity,
        executionSummary: summarizePlan(executedActions),
        agentCoreParts: latestRunControllerSnapshot.parts
      },
      updatedAt: executionRun.finishedAt
    });

    state.projects[index] = updated;
    return {
      project: updated,
      run: executionRun
    };
  } catch (error) {
    if (isAbortError(error)) {
      latestCoreProviderStep = undefined;
      latestRunControllerSnapshot = runController.interruptResumable({
        reason: 'Execution plan run was interrupted before pending permission/tool work completed.',
        recoveryHint: 'Resume the execution plan from the latest stable plan boundary.'
      });
    } else {
      latestCoreProviderStep = {
        finishReason: 'error',
        toolCalls: []
      };
      latestRunControllerSnapshot = runController.recordProviderStep({
        providerStep: latestCoreProviderStep,
        error: error instanceof Error ? error.message : 'Execution plan failed.'
      });
    }
    emitCoreStateStage(isAbortError(error) ? 'skipped' : 'failed', isAbortError(error) ? 'Execution Plan runtime 已中断，可从稳定边界恢复。' : 'Execution Plan runtime 已记录失败状态。');
    throw error;
  }
}
