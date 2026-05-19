import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'list_agent_skills',
  title: 'List Agent Skills',
  description: '列出当前项目可用的 Claude Code 风格 Agent Skills metadata。适合在任务可能需要特定工作流、领域流程或用户要求使用某个 skill 时先调用。',
  inputSchema: z.object({
    query: z.string().optional().describe('可选关键词，用于按名称或描述过滤 Skills。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'list_agent_skills',
    query: typeof input.query === 'string' ? input.query : undefined
  })
});

registerAgentTool({
  name: 'read_agent_skill',
  title: 'Read Agent Skill',
  description: '按 skillId 或精确名称读取一个 Agent Skill 的完整 SKILL.md 指令。应在 list_agent_skills 发现匹配项后按需调用，避免把所有 Skill 全量塞进上下文。',
  inputSchema: z.object({
    skillId: z.string().optional().describe('list_agent_skills 返回的 Skill id。'),
    skillName: z.string().optional().describe('精确 Skill 名称；没有 skillId 时使用。')
  }).refine((input) => Boolean(input.skillId?.trim() || input.skillName?.trim()), 'skillId or skillName is required'),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'read_agent_skill',
    skillId: typeof input.skillId === 'string' ? input.skillId : undefined,
    skillName: typeof input.skillName === 'string' ? input.skillName : undefined
  })
});

registerAgentTool({
  name: 'list_agent_skill_files',
  title: 'List Agent Skill Files',
  description: '列出某个 Agent Skill 目录下除 SKILL.md 之外的 supporting files。应在读取 Skill 后，需要引用模板、示例或脚本说明时调用。',
  inputSchema: z.object({
    skillId: z.string().optional().describe('list_agent_skills 返回的 Skill id。'),
    skillName: z.string().optional().describe('精确 Skill 名称；没有 skillId 时使用。')
  }).refine((input) => Boolean(input.skillId?.trim() || input.skillName?.trim()), 'skillId or skillName is required'),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'list_agent_skill_files',
    skillId: typeof input.skillId === 'string' ? input.skillId : undefined,
    skillName: typeof input.skillName === 'string' ? input.skillName : undefined
  })
});

registerAgentTool({
  name: 'read_agent_skill_file',
  title: 'Read Agent Skill File',
  description: '读取某个 Agent Skill supporting file 的文本内容。路径必须来自 list_agent_skill_files 返回结果，不能读取 SKILL.md 之外目录外的文件。',
  inputSchema: z.object({
    skillId: z.string().optional().describe('list_agent_skills 返回的 Skill id。'),
    skillName: z.string().optional().describe('精确 Skill 名称；没有 skillId 时使用。'),
    filePath: z.string().min(1).describe('list_agent_skill_files 返回的相对文件路径。')
  }).refine((input) => Boolean(input.skillId?.trim() || input.skillName?.trim()), 'skillId or skillName is required'),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'read_agent_skill_file',
    skillId: typeof input.skillId === 'string' ? input.skillId : undefined,
    skillName: typeof input.skillName === 'string' ? input.skillName : undefined,
    filePath: String(input.filePath)
  })
});
