import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'create_directory',
  title: 'Create Directory',
  description: '在当前项目内创建目录。必须提供项目内相对目录路径，例如 Assets/Art 或 resources/images。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对目录路径，例如 Assets/Art 或 resources/images。'),
    reason: z.string().optional().describe('为什么需要创建这个目录。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'before_write',
  readOnly: false,
  toAction: (input) => ({
    type: 'create_directory',
    path: String(input.path),
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'write_file',
  title: 'Write File',
  description: '写入当前项目内的文本文件。必须提供项目内相对路径和完整文件内容。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    content: z.string().min(1).describe('要写入的完整文件内容。'),
    reason: z.string().optional().describe('为什么需要写入这个文件。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'before_write',
  readOnly: false,
  toAction: (input) => ({
    type: 'write_file',
    path: String(input.path),
    content: String(input.content),
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'edit_file',
  title: 'Edit File',
  description: '通过精确替换 oldText -> newText 修改项目内文本文件。oldText 必须唯一匹配，除非 replaceAll=true。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    oldText: z.string().min(1).describe('要被替换的原文。建议包含足够上下文以保证唯一。'),
    newText: z.string().describe('替换后的文本。'),
    replaceAll: z.boolean().optional().describe('是否替换所有匹配。默认 false。'),
    reason: z.string().optional().describe('为什么需要编辑这个文件。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'before_write',
  readOnly: false,
  toAction: (input) => ({
    type: 'edit_file',
    path: String(input.path),
    oldText: String(input.oldText),
    newText: String(input.newText),
    replaceAll: typeof input.replaceAll === 'boolean' ? input.replaceAll : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'multi_edit',
  title: 'Multi Edit',
  description: '对同一个项目文本文件执行多处精确替换。所有编辑会先按顺序在内存中校验，任一 oldText 缺失、歧义或结果过大都会整体失败且不写入。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    edits: z.array(z.object({
      oldText: z.string().min(1).describe('要被替换的原文。按数组顺序应用，建议包含足够上下文以保证唯一。'),
      newText: z.string().describe('替换后的文本，可为空字符串。'),
      replaceAll: z.boolean().optional().describe('是否替换所有匹配。默认 false；默认要求 oldText 唯一匹配。')
    })).min(1).max(20).describe('按顺序应用的编辑列表。'),
    reason: z.string().optional().describe('为什么需要批量编辑这个文件。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'before_write',
  readOnly: false,
  toAction: (input) => ({
    type: 'multi_edit',
    path: String(input.path),
    edits: Array.isArray(input.edits)
      ? input.edits.map((edit) => ({
          oldText: String(edit.oldText),
          newText: String(edit.newText),
          replaceAll: typeof edit.replaceAll === 'boolean' ? edit.replaceAll : undefined
        }))
      : [],
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'preview_file_diff',
  title: 'Preview File Diff',
  description: '对比当前项目文本文件与完整候选内容，返回紧凑 unified diff 预览；不会写入文件。适合 write_file 前确认变更范围。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    content: z.string().describe('候选完整文件内容。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'preview_file_diff',
    path: String(input.path),
    content: String(input.content)
  })
});

registerAgentTool({
  name: 'preview_patch',
  title: 'Preview Patch',
  description: '预检一个 unified diff patch 是否能应用到当前项目文本文件，并返回应用后的 diff 预览；不会写入文件。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    patch: z.string().min(1).describe('unified diff hunk，可包含 ---/+++ 文件头和一个或多个 @@ hunk。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'preview_patch',
    path: String(input.path),
    patch: String(input.patch)
  })
});

registerAgentTool({
  name: 'patch_file',
  title: 'Patch File',
  description: '将 unified diff patch 应用到当前项目文本文件。所有 hunk 会先精确校验，任一上下文不匹配则整体失败且不写入；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    patch: z.string().min(1).describe('unified diff hunk，可包含 ---/+++ 文件头和一个或多个 @@ hunk。'),
    reason: z.string().optional().describe('为什么需要应用这个 patch。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'before_write',
  readOnly: false,
  toAction: (input) => ({
    type: 'patch_file',
    path: String(input.path),
    patch: String(input.patch),
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});
