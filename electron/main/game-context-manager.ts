import type {
  ActivityItem,
  ChatMessage,
  GameAgentPluginReport,
  Project,
  ProjectContextSummary,
  ProjectMemory,
  TaskItem
} from '../../shared/types';
import { getChatMessageContextText } from '../../shared/project-sessions';
import { nowIso } from '../../shared/utils';
import type { GameToolAssembly } from './game-tool-layer';

export interface ProjectAgentContext {
  memory: ProjectMemory;
  summary: ProjectContextSummary;
  recentChat: Array<{ role: string; content: string }>;
  recentActivity: Array<{ title: string; detail: string }>;
  activeTasks: Array<{ title: string; phase: string; status: string; description: string }>;
  focusedAssets: Array<{ name: string; type: string; prompt: string }>;
  plugins?: Array<{
    kind: string;
    name: string;
    toolNames: string[];
    projectContext?: string;
    observations?: string[];
  }>;
  unity?: {
    available: boolean;
    serverName?: string;
    toolNames: string[];
    projectContext?: string;
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function pickOpenQuestions(project: Project): string[] {
  const conceptTasks = project.tasks
    .filter((task) => task.phase === 'Concept' && task.status !== 'done')
    .slice(0, 2)
    .map((task) => `需要明确：${task.title}`);
  const validationTasks = project.tasks
    .filter((task) => task.phase === 'Validation' && task.status !== 'done')
    .slice(0, 2)
    .map((task) => `待验证：${task.title}`);

  return dedupe([...conceptTasks, ...validationTasks]).slice(0, 4);
}

function computeCurrentGoal(project: Project): string {
  return '';
}

function platformLabel(project: Project): string {
  if (project.engine?.platform === 'unity') return 'Unity';
  if (project.engine?.platform === 'cocos') return 'Cocos Creator';
  if (project.engine?.platform === 'godot') return 'Godot';
  if (project.engine?.platform === 'unreal') return 'Unreal';
  return '引擎';
}

function summarizeActivities(activity: ActivityItem[]): string[] {
  return activity.slice(0, 4).map((item) => `${item.title}：${item.detail}`);
}

function summarizeRecentDecisions(project: Project): string[] {
  const blueprintDecisions = [
    project.blueprint.playerFantasy,
    project.blueprint.artDirection,
    ...project.blueprint.pillars.slice(0, 2)
  ];
  return dedupe(blueprintDecisions).slice(0, 4);
}

function rankTasks(tasks: TaskItem[]): TaskItem[] {
  const phaseWeight: Record<string, number> = {
    Concept: 0,
    Content: 1,
    Unity: 2,
    Validation: 3
  };

  return [...tasks].sort((left, right) => {
    const statusWeight = (task: TaskItem): number => {
      if (task.status === 'in_progress') return 0;
      if (task.status === 'pending') return 1;
      return 2;
    };

    return statusWeight(left) - statusWeight(right) || phaseWeight[left.phase] - phaseWeight[right.phase];
  });
}

export function deriveProjectMemory(project: Project): ProjectMemory {
  const engineName = platformLabel(project);
  return {
    designDirectives: dedupe([
      project.blueprint.premise,
      project.blueprint.playerFantasy,
      ...project.blueprint.pillars,
      ...project.blueprint.differentiators
    ]).slice(0, 8),
    artDirectives: dedupe([
      `主风格：${project.artStyle}`,
      project.blueprint.artDirection,
      ...project.assets.filter((asset) => asset.type === 'character' || asset.type === 'ui').slice(0, 2).map((asset) => asset.name)
    ]).slice(0, 6),
    technicalConstraints: dedupe([
      '平台约束：macOS 桌面端',
      `引擎约束：${engineName}`,
      `模板约束：${project.templateId}`,
      '当前阶段优先确认项目结构，再逐步接入 Bridge / MCP 执行'
    ]).slice(0, 6),
    openQuestions: pickOpenQuestions(project),
    updatedAt: nowIso()
  };
}

export function deriveProjectContextSummary(project: Project): ProjectContextSummary {
  const rankedTasks = rankTasks(project.tasks);
  return {
    projectBrief: `${project.name}：${project.blueprint.premise}`,
    currentGoal: computeCurrentGoal(project),
    recentDecisions: summarizeRecentDecisions(project),
    activeTasks: rankedTasks.slice(0, 4).map((task) => `${task.phase} / ${task.title}`),
    recentActivity: summarizeActivities(project.activity),
    compressedFrom: project.chat.length + project.activity.length + project.tasks.length + project.assets.length,
    updatedAt: nowIso()
  };
}

export function refreshProjectContext(project: Project): Project {
  const memory = deriveProjectMemory(project);
  const contextSummary = deriveProjectContextSummary(project);
  return {
    ...project,
    memory,
    contextSummary
  };
}

function compactChat(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.slice(-4).map((message) => ({
    role: message.role,
    content: getChatMessageContextText(message, 600)
  }));
}

export function buildProjectAgentContext(
  project: Project,
  toolAssemblies?: Array<{ kind: string; assembly: GameToolAssembly; report?: GameAgentPluginReport }>
): ProjectAgentContext {
  const rankedTasks = rankTasks(project.tasks);
  const engineAssembly = toolAssemblies?.find((item) => item.kind === 'engine')?.assembly;
  return {
    memory: project.memory,
    summary: project.contextSummary,
    recentChat: compactChat(project.chat),
    recentActivity: project.activity.slice(0, 4).map((item) => ({
      title: item.title,
      detail: item.detail
    })),
    activeTasks: rankedTasks.slice(0, 6).map((task) => ({
      title: task.title,
      phase: task.phase,
      status: task.status,
      description: task.description
    })),
    focusedAssets: project.assets.slice(0, 6).map((asset) => ({
      name: asset.name,
      type: asset.type,
      prompt: asset.prompt
    })),
    plugins: toolAssemblies?.map((item) => ({
      kind: item.kind,
      name: item.assembly.serverInfo?.name || item.kind,
      toolNames: item.assembly.preferredTools.map((tool) => tool.name),
      projectContext: item.assembly.projectContext,
      observations: item.report?.observations ?? []
    })),
    unity: engineAssembly
      ? {
          available: engineAssembly.available,
          serverName: engineAssembly.serverInfo?.name,
          toolNames: engineAssembly.preferredTools.map((tool) => tool.name),
          projectContext: engineAssembly.projectContext
        }
      : undefined
  };
}
