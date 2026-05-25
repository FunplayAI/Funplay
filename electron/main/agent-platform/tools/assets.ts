import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

const assetGenerationKindSchema = z.enum([
  'image_2d',
  'ui_2d',
  'texture_2d',
  'animation_2d_frames',
  'animation_2d_rig',
  'model_3d',
  'animation_3d',
  'audio_sfx',
  'audio_music',
  'voice'
]);

registerAgentTool({
  name: 'list_asset_generation_capabilities',
  title: 'List Asset Generation Capabilities',
  description: '列出当前项目可用的素材生成器、支持的素材类型和 adapter。生成素材前先用它确认 providerId 与支持范围。',
  inputSchema: z.object({
    kind: assetGenerationKindSchema.optional().describe('可选素材类型过滤，例如 image_2d、model_3d 或 audio_sfx。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'list_asset_generation_capabilities',
    kind: input.kind
  })
});

registerAgentTool({
  name: 'generate_asset',
  title: 'Generate Asset',
  description: '通过素材生成中心生成 2D 图片/UI/纹理、2D 动画、3D 模型/动画、音效、音乐或语音，并写入项目素材目录。',
  inputSchema: z.object({
    title: z.string().min(1).max(160).describe('素材名称，例如 Bird Idle Frames。'),
    kind: assetGenerationKindSchema.describe('素材类型。'),
    prompt: z.string().min(1).max(8000).describe('生成描述，包含用途、风格、约束和需要避免的元素。'),
    negativePrompt: z.string().max(4000).optional().describe('可选负面提示词。'),
    providerId: z.string().max(160).optional().describe('可选 providerId；不填使用默认素材生成器。'),
    count: z.number().int().min(1).max(4).optional().describe('生成数量，最多 4。'),
    width: z.number().int().min(16).max(3840).optional().describe('视觉类素材宽度，需为 16px 倍数；与高度总像素需在 655,360 到 8,294,400 之间。'),
    height: z.number().int().min(16).max(3840).optional().describe('视觉类素材高度，需为 16px 倍数；长边/短边不能超过 3:1。'),
    durationSeconds: z.number().min(0.1).max(600).optional().describe('音频或动画时长。'),
    transparentBackground: z.boolean().optional().describe('视觉素材是否偏向透明背景。'),
    reason: z.string().max(1000).optional().describe('为什么需要生成这个素材。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'generate_asset',
    title: String(input.title),
    kind: input.kind,
    prompt: String(input.prompt),
    negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt : undefined,
    providerId: typeof input.providerId === 'string' ? input.providerId : undefined,
    count: typeof input.count === 'number' ? input.count : undefined,
    width: typeof input.width === 'number' ? input.width : undefined,
    height: typeof input.height === 'number' ? input.height : undefined,
    durationSeconds: typeof input.durationSeconds === 'number' ? input.durationSeconds : undefined,
    transparentBackground: typeof input.transparentBackground === 'boolean' ? input.transparentBackground : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'import_generated_asset',
  title: 'Import Generated Asset',
  description: '把素材生成任务标记为已导入项目。适合生成后确认该任务输出已被纳入项目资产账本。',
  inputSchema: z.object({
    jobId: z.string().min(1).max(160).describe('素材生成任务 ID。'),
    reason: z.string().max(1000).optional().describe('为什么需要导入该生成任务。')
  }),
  risk: 'medium',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'import_generated_asset',
    jobId: String(input.jobId),
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});
