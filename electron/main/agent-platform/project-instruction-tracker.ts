import type { Project } from '../../../shared/types';
import { collectProjectInstructions } from './context';
import type { GenericAgentWorkspaceContext } from './types';

export const DYNAMIC_PROJECT_INSTRUCTIONS_MARKER = '[Funplay Dynamic Project Instructions]';

type ProjectInstruction = GenericAgentWorkspaceContext['projectInstructions'][number];

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
