import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

const platformSchema = z.enum(['web', 'unity', 'cocos', 'godot', 'unreal']);
const setupModeSchema = z.enum(['create', 'import']);
const dimensionSchema = z.enum(['2d', '3d', 'unknown']);

const engineContextSchema = z.object({
  platform: platformSchema.optional(),
  mode: setupModeSchema.optional(),
  dimension: dimensionSchema.optional(),
  projectName: z.string().trim().min(1).max(160).optional(),
  projectPath: z.string().trim().max(4096).optional(),
  enginePluginId: z.string().trim().max(160).optional(),
  unityEditorVersion: z.string().trim().max(80).optional()
});

const enginePathSchema = z.object({
  platform: platformSchema.optional(),
  projectPath: z.string().trim().max(4096).optional(),
  reason: z.string().trim().max(500).optional()
});

registerAgentTool({
  name: 'diagnose_engine_status',
  title: 'Diagnose Engine Status',
  description: '通用引擎状态诊断工具。默认使用当前项目引擎配置；Unity 会检查 Hub、Editor、项目打开状态、Bridge/MCP 安装和连通性，其他引擎返回结构化 unsupported 状态。',
  inputSchema: engineContextSchema,
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'diagnose_engine_status',
    ...input
  })
});

registerAgentTool({
  name: 'refresh_engine_runtime_state',
  title: 'Refresh Engine Runtime State',
  description: '刷新当前项目的运行时引擎状态快照。Unity 会重新检测项目是否存在/打开、Bridge 是否安装、MCP 是否在线，并读取可用资源摘要。',
  inputSchema: z.object({
    platform: platformSchema.optional(),
    projectPath: z.string().trim().max(4096).optional()
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'refresh_engine_runtime_state',
    ...input
  })
});

registerAgentTool({
  name: 'open_engine_hub',
  title: 'Open Engine Hub',
  description: '打开当前项目对应的引擎 Hub/Launcher。当前 Unity adapter 会打开 Unity Hub；其他引擎返回 unsupported。',
  inputSchema: z.object({
    platform: platformSchema.optional(),
    reason: z.string().trim().max(500).optional()
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'open_engine_hub',
    ...input
  })
});

registerAgentTool({
  name: 'open_engine_project',
  title: 'Open Engine Project',
  description: '打开当前项目对应的引擎工程。当前 Unity adapter 会直接启动 Unity 打开项目，并在已安装 Bridge 时写入 MCP 端口配置；其他引擎返回 unsupported。',
  inputSchema: enginePathSchema,
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'open_engine_project',
    ...input
  })
});

registerAgentTool({
  name: 'install_engine_bridge',
  title: 'Install Engine Bridge',
  description: '安装当前项目对应的 Funplay 引擎 Bridge。当前 Unity adapter 会写入 Unity MCP Package 依赖和 MCP 配置；其他引擎返回 unsupported。',
  inputSchema: enginePathSchema,
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'install_engine_bridge',
    ...input
  })
});
