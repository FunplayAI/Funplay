import type { McpPlugin, Project } from '../../shared/types';

export function getProjectMcpServerIds(project: Project | null | undefined): string[] {
  if (!project) {
    return [];
  }
  const bindings = project.mcpBindings ?? {};
  return [...new Set([
    ...(bindings.servers ?? []),
    bindings.engine,
    bindings.asset,
    bindings.qa,
    bindings.custom
  ].filter(Boolean) as string[])];
}

export function canProjectUseMcpPlugin(project: Project | null | undefined, plugin: McpPlugin): boolean {
  return Boolean(project && (!plugin.projectId || plugin.projectId === project.id));
}
