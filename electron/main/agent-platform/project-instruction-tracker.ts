import type { Project } from '../../../shared/types';
import { collectProjectInstructions } from './context';
import type { GenericAgentWorkspaceContext } from './types';

export const DYNAMIC_PROJECT_INSTRUCTIONS_MARKER = '[Funplay Dynamic Project Instructions]';

type ProjectInstruction = GenericAgentWorkspaceContext['projectInstructions'][number];

const PROJECT_INSTRUCTION_GUARDED_WRITE_TOOLS = new Set([
  'create_directory',
  'write_file',
  'edit_file',
  'multi_edit',
  'patch_file'
]);

export interface ProjectInstructionGuardResult {
  instructions: ProjectInstruction[];
  paths: string[];
  failureKind: 'project_instructions_required';
  recoveryHint: string;
  summary: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function addInputPath(tokens: string[], value: unknown): void {
  const path = asString(value);
  if (path) {
    tokens.push(path);
  }
}

export function extractNativeToolInputInstructionQuery(
  toolName: string,
  input?: Record<string, unknown>
): string | undefined {
  if (!input) {
    return undefined;
  }

  const tokens: string[] = [];

  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    addInputPath(tokens, input.path);
  } else if (toolName === 'summarize_directory') {
    addInputPath(tokens, input.path);
  } else if (toolName === 'find_files') {
    addInputPath(tokens, input.path);
    const pattern = asString(input.pattern);
    if (pattern?.includes('/')) {
      tokens.push(pattern);
    }
  } else if (toolName === 'run_command') {
    addInputPath(tokens, input.cwd);
  } else {
    addInputPath(tokens, input.path);
    addInputPath(tokens, input.filePath);
    addInputPath(tokens, input.file_path);
    addInputPath(tokens, input.cwd);
    addInputPath(tokens, input.workdir);
  }

  return tokens.length > 0 ? tokens.join('\n') : undefined;
}

export function isProjectInstructionGuardedWriteTool(toolName: string): boolean {
  return PROJECT_INSTRUCTION_GUARDED_WRITE_TOOLS.has(toolName);
}

export function createProjectInstructionGuardSummary(input: {
  toolName: string;
  paths: string[];
}): string {
  return [
    `写入工具 ${input.toolName} 触达了包含局部 Agent 指令的新目录，host 已在执行写入前拦截本次工具调用。`,
    `已载入局部指令：${input.paths.join(', ')}`,
    '请先遵守这些局部指令，再重新发起必要的写入工具调用。'
  ].join('\n');
}

export class ProjectInstructionTracker {
  private readonly seenPaths = new Set<string>();
  private readonly dynamicInstructions: ProjectInstruction[] = [];
  private readonly project: Project;

  constructor(
    project: Project,
    initialInstructions: ProjectInstruction[] = []
  ) {
    this.project = project;
    for (const instruction of initialInstructions) {
      this.seenPaths.add(instruction.path.toLowerCase());
    }
  }

  discoverFromMessage(message: string | undefined): ProjectInstruction[] {
    const discovered = collectProjectInstructions(this.project, message).filter((instruction) => {
      const seenKey = instruction.path.toLowerCase();
      if (this.seenPaths.has(seenKey)) {
        return false;
      }
      this.seenPaths.add(seenKey);
      return true;
    });

    this.dynamicInstructions.push(...discovered);
    return discovered;
  }

  discoverFromToolInput(toolName: string, input?: Record<string, unknown>): ProjectInstruction[] {
    return this.discoverFromMessage(extractNativeToolInputInstructionQuery(toolName, input));
  }

  guardWriteBeforeLocalInstructions(toolName: string, input?: Record<string, unknown>): ProjectInstructionGuardResult | undefined {
    if (!isProjectInstructionGuardedWriteTool(toolName)) {
      return undefined;
    }
    const instructions = this.discoverFromToolInput(toolName, input);
    if (instructions.length === 0) {
      return undefined;
    }
    const paths = instructions.map((instruction) => instruction.path);
    return {
      instructions,
      paths,
      failureKind: 'project_instructions_required',
      recoveryHint: 'Read the newly injected local project instructions, then retry the write only if it still satisfies those rules.',
      summary: createProjectInstructionGuardSummary({
        toolName,
        paths
      })
    };
  }

  formatDynamicInstructionMessage(): string | undefined {
    if (this.dynamicInstructions.length === 0) {
      return undefined;
    }

    return [
      DYNAMIC_PROJECT_INSTRUCTIONS_MARKER,
      '工具调用触达了新的项目子目录。以下局部 Agent 指令适用于后续步骤，优先于更上层目录：',
      ...this.dynamicInstructions.map((instruction) =>
        [
          `## ${instruction.path}${instruction.truncated ? ' (truncated)' : ''}`,
          instruction.content
        ].join('\n')
      )
    ].join('\n\n');
  }
}
