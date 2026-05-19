import { z } from 'zod';
import type { McpPluginKind } from '../../../../shared/types';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'list_mcp_tools',
  title: 'List MCP Tools',
  description: '列出当前项目已启用 MCP Server 暴露的工具名称、描述和 inputSchema。调用 call_mcp_tool 前应先用它确认 toolName 与参数结构。',
  inputSchema: z.object({
    pluginId: z.string().optional().describe('可选 MCP Server ID。'),
    pluginKind: z.enum(['engine', 'asset', 'qa', 'custom']).optional().describe('可选 MCP Server 类型。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'list_mcp_tools',
    pluginId: typeof input.pluginId === 'string' ? input.pluginId : undefined,
    pluginKind: typeof input.pluginKind === 'string' ? input.pluginKind as McpPluginKind : undefined
  })
});

registerAgentTool({
  name: 'list_mcp_resources',
  title: 'List MCP Resources',
  description: '列出当前项目已启用 MCP Server 暴露的资源 URI。调用 read_mcp_resource 前应先用它确认可读 resource uri。',
  inputSchema: z.object({
    pluginId: z.string().optional().describe('可选 MCP Server ID。'),
    pluginKind: z.enum(['engine', 'asset', 'qa', 'custom']).optional().describe('可选 MCP Server 类型。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'list_mcp_resources',
    pluginId: typeof input.pluginId === 'string' ? input.pluginId : undefined,
    pluginKind: typeof input.pluginKind === 'string' ? input.pluginKind as McpPluginKind : undefined
  })
});

registerAgentTool({
  name: 'read_mcp_resource',
  title: 'Read MCP Resource',
  description: '读取当前项目已绑定 MCP 插件暴露的资源。必须提供 pluginKind 或 pluginId 与 resource uri。',
  inputSchema: z.object({
    pluginId: z.string().optional().describe('可选 MCP 插件 ID。'),
    pluginKind: z.enum(['engine', 'asset', 'qa', 'custom']).optional().describe('可选 MCP 插件类型。'),
    uri: z.string().min(1).describe('MCP resource uri，例如 unity://project/context。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'read_mcp_resource',
    pluginId: typeof input.pluginId === 'string' ? input.pluginId : undefined,
    pluginKind: typeof input.pluginKind === 'string' ? input.pluginKind as McpPluginKind : undefined,
    uri: String(input.uri)
  })
});

registerAgentTool({
  name: 'call_mcp_tool',
  title: 'Call MCP Tool',
  description: '调用当前项目已绑定 MCP 插件暴露的工具。必须提供 pluginKind 或 pluginId、toolName 与 args。',
  inputSchema: z.object({
    pluginId: z.string().optional().describe('可选 MCP 插件 ID。'),
    pluginKind: z.enum(['engine', 'asset', 'qa', 'custom']).optional().describe('可选 MCP 插件类型。'),
    toolName: z.string().min(1).describe('MCP tool name。'),
    args: z.record(z.string(), z.unknown()).optional().describe('MCP tool 参数。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'call_mcp_tool',
    pluginId: typeof input.pluginId === 'string' ? input.pluginId : undefined,
    pluginKind: typeof input.pluginKind === 'string' ? input.pluginKind as McpPluginKind : undefined,
    toolName: String(input.toolName),
    args: typeof input.args === 'object' && input.args !== null && !Array.isArray(input.args)
      ? input.args as Record<string, unknown>
      : {}
  })
});
