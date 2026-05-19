import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'media_attach_file',
  title: 'Attach Media File',
  description: '把项目内已有图片、音频或文件作为富媒体结果附加到聊天区。适合用户要求展示、预览或返回生成资产时使用；不会修改文件。',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('项目内相对文件路径，例如 Assets/preview.png。'),
    title: z.string().max(160).optional().describe('可选显示标题。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'media_attach_file',
    filePath: String(input.filePath),
    title: typeof input.title === 'string' ? input.title : undefined
  })
});

registerAgentTool({
  name: 'media_save_base64',
  title: 'Save Base64 Media',
  description: '把 base64 媒体数据保存到项目附件目录并作为富媒体结果附加到聊天区。适合工具生成了图片、音频或文件 payload 后落盘展示。',
  inputSchema: z.object({
    dataBase64: z.string().min(1).describe('原始 base64，或包含 base64 的 data URL。'),
    mimeType: z.string().optional().describe('媒体 MIME 类型，默认 image/png。'),
    fileName: z.string().max(180).optional().describe('可选保存文件名；不允许路径。'),
    title: z.string().max(160).optional().describe('可选显示标题。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'media_save_base64',
    dataBase64: String(input.dataBase64),
    mimeType: typeof input.mimeType === 'string' ? input.mimeType : undefined,
    fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
    title: typeof input.title === 'string' ? input.title : undefined
  })
});

registerAgentTool({
  name: 'image_generate',
  title: 'Generate Image',
  description: '通过配置的图片生成 API 生成图片，保存到项目附件目录并作为富媒体结果附加到聊天区。需要 FUNPLAY_IMAGE_API_KEY 或 OPENAI_API_KEY。',
  inputSchema: z.object({
    prompt: z.string().min(1).describe('图片生成提示词。'),
    size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional().describe('图片尺寸，默认 1024x1024。'),
    model: z.string().optional().describe('可选图片模型覆盖；默认 FUNPLAY_IMAGE_MODEL 或 gpt-image-1。'),
    fileName: z.string().max(180).optional().describe('可选保存文件名；不允许路径。'),
    title: z.string().max(160).optional().describe('可选显示标题。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'image_generate',
    prompt: String(input.prompt),
    size: input.size,
    model: typeof input.model === 'string' ? input.model : undefined,
    fileName: typeof input.fileName === 'string' ? input.fileName : undefined,
    title: typeof input.title === 'string' ? input.title : undefined
  })
});
