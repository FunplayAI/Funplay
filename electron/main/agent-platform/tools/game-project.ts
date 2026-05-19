import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'inspect_game_project',
  title: 'Inspect Game Project',
  description: '识别当前项目是否像 Web/Unity 游戏项目，汇总可玩入口、资源目录、验证方式和 Unity MCP 工作流建议。只读，不会修改文件。',
  inputSchema: z.object({}),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: () => ({
    type: 'inspect_game_project'
  })
});
