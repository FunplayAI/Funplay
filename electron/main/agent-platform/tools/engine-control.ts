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
  description: '通用引擎状态诊断工具。默认使用当前项目引擎配置；Unity 会检查 Hub、Editor、项目打开状态、Bridge/MCP 安装和连通性；Cocos 会检测 Creator CLI、项目结构和命令行构建能力；其他引擎返回结构化 unsupported 状态。',
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
  description: '刷新当前项目的运行时引擎状态快照。Unity 会重新检测项目是否存在/打开、Bridge 是否安装、MCP 是否在线，并读取可用资源摘要；Cocos 会重新检测 Creator CLI 和项目结构。',
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
  description: '打开当前项目对应的引擎 Hub/Launcher。Unity 会打开 Unity Hub；Cocos 会尝试打开 Cocos Dashboard；其他引擎返回 unsupported。',
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
  description: '打开当前项目对应的引擎工程。Unity 会直接启动 Unity 打开项目，并在已安装 Bridge 时写入 MCP 端口配置；Cocos 会通过 CocosCreator --project 打开工程；其他引擎返回 unsupported。',
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
  description: '安装当前项目对应的 Funplay 引擎 Bridge。Unity adapter 会写入 Unity MCP Package 依赖和 MCP 配置；Cocos adapter 会安装 funplay-cocos-mcp 扩展；其他引擎返回 unsupported。',
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

// Agent-facing subset of EnvironmentActionKind: the project-level staged-setup
// actions (create / import / open / install-bridge / verify). The heavy OS-level
// software installers (install_unity_hub, install_unity_editor,
// install_cocos_dashboard) are deliberately EXCLUDED — those multi-GB downloads
// stay UI-only and are not driven by the agent.
const environmentActionIdSchema = z.enum([
  'open_unity_hub',
  'select_unity_hub',
  'create_unity_project',
  'import_unity_project',
  'open_unity_project',
  'install_project_bridge',
  'open_cocos_dashboard',
  'create_cocos_project',
  'open_cocos_project',
  'install_cocos_bridge',
  'verify_project_path'
]);

registerAgentTool({
  name: 'run_engine_environment_action',
  title: 'Run Engine Environment Action',
  description:
    '驱动当前项目引擎的分阶段环境编排动作(创建/导入/打开工程、安装 Bridge、校验路径)。Unity 走 Hub/Editor/项目编排;Cocos 走 create_cocos_project → install_cocos_bridge → open_cocos_project 流程。重型软件安装(安装 Unity Hub/Editor、Cocos Dashboard)不在此工具范围内,请用户在 UI onboarding 中完成。',
  inputSchema: engineContextSchema.extend({
    actionId: environmentActionIdSchema,
    reason: z.string().trim().max(500).optional()
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'run_engine_environment_action',
    ...input
  })
});
