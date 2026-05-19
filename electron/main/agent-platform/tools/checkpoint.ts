import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'checkpoint_diff',
  title: 'Preview Checkpoint Diff',
  description: '查看当前 Agent 运行 checkpoint 以来被 Funplay 写入工具记录的文件变更和 diff 预览；不会写入文件。',
  inputSchema: z.object({}),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: () => ({
    type: 'checkpoint_diff'
  })
});

registerAgentTool({
  name: 'checkpoint_rollback',
  title: 'Rollback Checkpoint Files',
  description: '将当前 Agent 运行 checkpoint 记录过的文件恢复到运行前状态。适合用户要求撤回本轮文件修改；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    reason: z.string().optional().describe('为什么需要回滚 checkpoint 文件。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'checkpoint_rollback',
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});
