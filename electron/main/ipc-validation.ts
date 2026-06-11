import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type {
  AiProviderApiMode,
  AiProviderAuthStyle,
  AiProviderInput,
  AiProviderMeta,
  AiProviderModel,
  AssetGenerationProviderInput,
  AssetGenerationRequest,
  PromptAttachment,
  PromptAttachmentImportItem,
  ProjectSessionEffort,
  ProjectSessionRuntimeId,
  WebSearchSettings
} from '../../shared/types';

const platformChoiceSchema = z.enum(['web', 'unity', 'cocos', 'godot', 'unreal']);
const projectSetupModeSchema = z.enum(['create', 'import']);
const engineProjectDimensionSchema = z.enum(['2d', '3d', 'unknown']);
const gameTemplateIdSchema = z.enum(['generic-workspace', 'engine-game-prototype', '2d-roguelike', 'narrative-adventure', 'topdown-action']);
const aiProviderProtocolSchema = z.enum(['openai-compatible', 'anthropic', 'google', 'bedrock', 'vertex']);
const aiProviderApiModeSchema = z.custom<AiProviderApiMode>((value) => ['responses', 'chat'].includes(String(value)));
export const aiProviderAuthStyleSchema = z.custom<AiProviderAuthStyle>((value) =>
  ['api_key', 'auth_token', 'env_only', 'custom_header'].includes(String(value))
);
const mcpPluginKindSchema = z.enum(['engine', 'asset', 'qa', 'custom']);
const mcpTransportSchema = z.enum(['http', 'stdio', 'streamable-http', 'sse']);
const mcpToolPermissionPolicySchema = z.enum(['infer', 'allow', 'ask', 'deny']);
const mcpToolRiskPolicySchema = z.enum(['infer', 'read', 'write']);
const unityProfileSchema = z.enum(['core', 'full']);
const unityHealthStatusSchema = z.enum(['idle', 'online', 'offline']);
const agentPermissionModeSchema = z.enum(['full-access', 'read-only']);
const agentRuntimeStrategySchema = z.enum(['auto', 'native']);
export const uiLanguageSchema = z.enum(['zh-CN', 'en-US']);
const webSearchProviderSchema = z.enum(['auto', 'duckduckgo', 'brave', 'bing']);
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
const assetGenerationProviderAdapterSchema = z.enum([
  'openai-image',
  'replicate',
  'stability',
  'comfyui',
  'meshy',
  'elevenlabs',
  'mcp'
]);
const configurableAssetGenerationProviderAdapterSchema = z.enum([
  'openai-image',
  'replicate',
  'stability',
  'comfyui',
  'meshy',
  'elevenlabs'
]);
const projectSessionRuntimeIdSchema = z.custom<ProjectSessionRuntimeId>((value) =>
  ['native'].includes(String(value))
);
const projectSessionEffortSchema = z.custom<ProjectSessionEffort>((value) => ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value)));
const environmentActionKindSchema = z.enum([
  'install_unity_hub',
  'open_unity_hub',
  'select_unity_hub',
  'install_unity_editor',
  'create_unity_project',
  'import_unity_project',
  'open_unity_project',
  'install_project_bridge',
  'install_cocos_dashboard',
  'open_cocos_dashboard',
  'create_cocos_project',
  'open_cocos_project',
  'install_cocos_bridge',
  'verify_project_path'
]);

const trimmedString = (min = 1, max = 4000) => z.string().trim().min(min).max(max);
const optionalTrimmedString = (max = 4000) => z.string().trim().max(max).optional();
const stringRecordSchema = z.record(z.string().trim().min(1).max(160), z.string().max(4000));
const mcpEnvRecordSchema = z.record(z.string().trim().min(1).max(160), z.string().max(4000));
const mcpToolPolicyOverrideSchema = z.object({
  permission: mcpToolPermissionPolicySchema.optional(),
  risk: mcpToolRiskPolicySchema.optional(),
  notes: optionalTrimmedString(1000)
}).strict();
const aiProviderModelSchema = z.object({
  modelId: trimmedString(1, 240),
  upstreamModelId: optionalTrimmedString(240),
  displayName: optionalTrimmedString(240),
  role: z.enum(['default', 'reasoning', 'small', 'haiku', 'sonnet', 'opus']).optional(),
  capabilities: z.object({
    reasoning: z.boolean().optional(),
    toolUse: z.boolean().optional(),
    vision: z.boolean().optional(),
    pdf: z.boolean().optional(),
    contextWindow: z.number().int().min(1).max(2_000_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(projectSessionEffortSchema).optional(),
    supportsAdaptiveThinking: z.boolean().optional()
  }).strict().optional()
}).strict() satisfies z.ZodType<AiProviderModel>;
const aiProviderMetaSchema = z.object({
  apiKeyUrl: optionalTrimmedString(2048),
  docsUrl: optionalTrimmedString(2048),
  pricingUrl: optionalTrimmedString(2048),
  statusPageUrl: optionalTrimmedString(2048),
  billingModel: z.enum(['pay_as_you_go', 'coding_plan', 'token_plan', 'free', 'self_hosted']).optional(),
  notes: z.array(z.string().trim().max(1000)).optional()
}).strict() satisfies z.ZodType<AiProviderMeta>;
const providerTimeoutSchema = z.union([
  z.number().int().min(1).max(60 * 60 * 1000),
  z.literal(false)
]).optional();
const providerContextWindowTokensSchema = z.number().int().min(1_024).max(2_000_000).optional();
const providerMaxOutputTokensSchema = z.number().int().min(1).max(1_000_000).optional();
const providerChunkTimeoutSchema = z.number().int().min(1).max(60 * 60 * 1000).optional();

export const createProjectInputSchema = z.object({
  name: trimmedString(1, 120),
  templateId: gameTemplateIdSchema,
  artStyle: trimmedString(1, 240),
  pitch: trimmedString(1, 4000),
  engine: z.object({
    platform: platformChoiceSchema,
    setupMode: projectSetupModeSchema.optional(),
    projectPath: optionalTrimmedString(2048),
    dimension: engineProjectDimensionSchema.optional(),
    unityEditorVersion: optionalTrimmedString(120)
  }).optional()
}).strict();

export const environmentInputSchema = z.object({
  platform: platformChoiceSchema,
  mode: projectSetupModeSchema,
  dimension: engineProjectDimensionSchema,
  projectName: optionalTrimmedString(120),
  projectPath: trimmedString(1, 2048),
  enginePluginId: optionalTrimmedString(120),
  unityEditorVersion: optionalTrimmedString(120)
}).strict();

export const environmentActionInputSchema = environmentInputSchema.extend({
  actionId: environmentActionKindSchema
}).strict();

export const folderPickerInputSchema = z.object({
  mode: projectSetupModeSchema,
  defaultPath: optionalTrimmedString(2048)
}).strict();

export const aiProviderInputSchema = z.object({
  name: trimmedString(1, 120),
  protocol: aiProviderProtocolSchema,
  apiMode: aiProviderApiModeSchema.optional(),
  authStyle: aiProviderAuthStyleSchema.optional(),
  baseUrl: z.string().trim().max(2048),
  apiKey: z.string().max(2048),
  model: trimmedString(1, 240),
  upstreamModel: optionalTrimmedString(240),
  headers: stringRecordSchema.optional(),
  envOverrides: stringRecordSchema.optional(),
  availableModels: z.array(aiProviderModelSchema).max(100).optional(),
  providerMeta: aiProviderMetaSchema.optional(),
  contextWindowTokens: providerContextWindowTokensSchema,
  maxOutputTokens: providerMaxOutputTokensSchema,
  requestTimeoutMs: providerTimeoutSchema,
  chunkTimeoutMs: providerChunkTimeoutSchema,
  enabled: z.boolean().optional(),
  notes: optionalTrimmedString(1000)
}).strict() satisfies z.ZodType<AiProviderInput>;

export const aiProviderModelListRequestSchema = z.object({
  providerId: optionalTrimmedString(120),
  provider: aiProviderInputSchema
}).strict();

export const mcpPluginInputSchema = z.object({
  name: trimmedString(1, 120),
  projectId: optionalTrimmedString(120),
  kind: mcpPluginKindSchema,
  transport: mcpTransportSchema,
  baseUrl: z.string().trim().max(2048).default(''),
  command: optionalTrimmedString(2048),
  args: z.array(z.string().max(2048)).max(80).optional(),
  cwd: optionalTrimmedString(4096),
  env: mcpEnvRecordSchema.optional(),
  defaultToolPermission: mcpToolPermissionPolicySchema.optional(),
  defaultToolRisk: mcpToolRiskPolicySchema.optional(),
  toolPolicies: z.record(z.string().trim().min(1).max(240), mcpToolPolicyOverrideSchema).optional(),
  enabled: z.boolean().optional(),
  notes: optionalTrimmedString(1000)
}).strict().refine((input) => {
  if (input.transport === 'stdio') {
    return Boolean(input.command?.trim());
  }
  return Boolean(input.baseUrl.trim());
}, 'HTTP MCP requires baseUrl; stdio MCP requires command.');

export const updateSettingsSchema = z.object({
  baseUrl: optionalTrimmedString(2048),
  profile: unityProfileSchema.optional(),
  lastCheckedAt: optionalTrimmedString(120),
  lastStatus: unityHealthStatusSchema.optional(),
  lastMessage: optionalTrimmedString(1000),
  lastCreatedProjectDirectory: optionalTrimmedString(2048),
  lastAssignedMcpPort: z.number().int().min(1).max(65535).optional(),
  unityHubPath: optionalTrimmedString(2048)
}).strict().refine((input) => Object.keys(input).length > 0, 'At least one setting must be provided.');

export const updateAgentSettingsSchema = z.object({
  permissionMode: agentPermissionModeSchema.optional(),
  runtimeStrategy: agentRuntimeStrategySchema.optional()
}).strict().refine((input) => Object.keys(input).length > 0, 'At least one agent setting must be provided.');

export const updateWebSearchSettingsSchema = z.object({
  provider: webSearchProviderSchema.optional(),
  braveApiKey: z.string().max(2048).optional(),
  bingApiKey: z.string().max(2048).optional(),
  cacheTtlMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  browserFallbackEnabled: z.boolean().optional(),
  telemetryEnabled: z.boolean().optional()
}).strict().refine((input) => Object.keys(input).length > 0, 'At least one web search setting must be provided.') satisfies z.ZodType<Partial<WebSearchSettings>>;

export const updateProjectAgentPolicySchema = z.object({
  permissionMode: agentPermissionModeSchema.optional(),
  skills: z.array(z.object({
    id: trimmedString(1, 120),
    name: trimmedString(1, 120),
    description: optionalTrimmedString(500),
    trigger: optionalTrimmedString(500),
    instruction: trimmedString(1, 6000),
    enabled: z.boolean(),
    source: z.enum(['custom', 'funplay-skill']).optional(),
    sourceId: optionalTrimmedString(160),
    sourcePath: optionalTrimmedString(500),
    repositoryUrl: optionalTrimmedString(2048),
    repositoryRef: optionalTrimmedString(120),
    version: optionalTrimmedString(120),
    dependencies: z.array(trimmedString(1, 120)).max(40).optional(),
    examples: z.array(trimmedString(1, 500)).max(40).optional(),
    createdAt: trimmedString(1, 80),
    updatedAt: trimmedString(1, 80)
  }).strict()).max(100).optional()
}).strict().refine((input) => Object.keys(input).length > 0, 'At least one project agent policy setting must be provided.');

export const listAgentSkillCatalogSchema = z.object({
  refresh: z.boolean().optional()
}).strict().optional();

export const updateSessionRuntimeSchema = z.object({
  runtimeId: projectSessionRuntimeIdSchema.optional(),
  providerId: optionalTrimmedString(120),
  model: optionalTrimmedString(240),
  upstreamModel: optionalTrimmedString(240),
  permissionMode: agentPermissionModeSchema.optional(),
  effort: projectSessionEffortSchema.optional(),
  context1m: z.boolean().optional(),
  thinking: z.record(z.string().trim().min(1).max(160), z.unknown()).optional(),
  outputFormat: z.record(z.string().trim().min(1).max(160), z.unknown()).optional(),
  agents: z.record(z.string().trim().min(1).max(160), z.unknown()).optional(),
  agent: optionalTrimmedString(120)
}).strict().refine((input) => Object.keys(input).length > 0, 'At least one session runtime override must be provided.');

export const projectIdSchema = trimmedString(1, 120);
export const providerIdSchema = trimmedString(1, 120);
export const assetGenerationProviderIdSchema = trimmedString(1, 160);
export const assetGenerationJobIdSchema = trimmedString(1, 160);
export const assetGenerationProviderInputSchema = z.object({
  name: trimmedString(1, 120),
  adapter: configurableAssetGenerationProviderAdapterSchema,
  enabled: z.boolean().optional(),
  baseUrl: optionalTrimmedString(2048),
  apiKey: z.string().max(8192).optional(),
  model: optionalTrimmedString(240),
  workflowJson: z.string().max(2_000_000).optional(),
  workflowPath: optionalTrimmedString(4096),
  voiceId: optionalTrimmedString(240),
  notes: optionalTrimmedString(1000)
}).strict() satisfies z.ZodType<AssetGenerationProviderInput>;
export const assetGenerationRequestSchema = z.object({
  title: trimmedString(1, 160),
  kind: assetGenerationKindSchema,
  prompt: trimmedString(1, 8000),
  negativePrompt: optionalTrimmedString(4000),
  providerId: optionalTrimmedString(160),
  providerAdapter: assetGenerationProviderAdapterSchema.optional(),
  stylePresetId: optionalTrimmedString(160),
  references: z.array(z.object({
    id: trimmedString(1, 160),
    name: trimmedString(1, 255),
    path: trimmedString(1, 4096),
    kind: assetGenerationKindSchema.optional(),
    role: z.enum(['style', 'character', 'pose', 'audio', 'mesh', 'other']).optional()
  }).strict()).max(24).optional(),
  targetEngine: platformChoiceSchema.optional(),
  outputSpec: z.object({
    format: optionalTrimmedString(32),
    width: z.number().int().min(16).max(3840).optional(),
    height: z.number().int().min(16).max(3840).optional(),
    frameCount: z.number().int().min(1).max(240).optional(),
    durationSeconds: z.number().min(0.1).max(600).optional(),
    loop: z.boolean().optional(),
    transparentBackground: z.boolean().optional(),
    engineImportMode: z.enum(['none', 'copy', 'unity']).optional()
  }).strict().optional(),
  count: z.number().int().min(1).max(4).optional(),
  createdBy: z.enum(['user', 'agent']).optional()
}).strict() satisfies z.ZodType<AssetGenerationRequest>;
export const listProjectAgentSkillRegistrySchema = projectIdSchema;
export const runtimeDoctorInputSchema = z.object({
  providerId: optionalTrimmedString(120),
  projectId: optionalTrimmedString(120),
  live: z.boolean().optional()
}).strict().default({});
export const runtimeRepairInputSchema = z.object({
  actionId: trimmedString(1, 120),
  providerId: optionalTrimmedString(120),
  projectId: optionalTrimmedString(120),
  sessionId: optionalTrimmedString(120),
  authStyle: aiProviderAuthStyleSchema.optional(),
  url: optionalTrimmedString(2048)
}).strict();
export const pluginIdSchema = trimmedString(1, 120);
export const noteSchema = trimmedString(1, 500);
export const promptSchema = trimmedString(1, 4000);
export const agentUserInputResponseSchema = z.object({
  answer: z.string().max(4000).default(''),
  optionId: optionalTrimmedString(120),
  optionIds: z.array(trimmedString(1, 120)).max(20).optional(),
  cancelled: z.boolean().optional()
}).strict();
export const promptAttachmentSchema = z.object({
  id: trimmedString(1, 120),
  name: trimmedString(1, 255),
  path: trimmedString(1, 4096),
  relativePath: optionalTrimmedString(2048),
  mimeType: optionalTrimmedString(120),
  kind: z.enum(['image', 'file']),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024),
  previewDataUrl: optionalTrimmedString(12 * 1024 * 1024)
}).strict() satisfies z.ZodType<PromptAttachment>;
export const promptAttachmentsSchema = z.array(promptAttachmentSchema).max(12).default([]);
export const promptAttachmentImportItemSchema = z.object({
  name: optionalTrimmedString(255),
  path: optionalTrimmedString(4096),
  mimeType: optionalTrimmedString(120),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  dataUrl: optionalTrimmedString(140 * 1024 * 1024)
}).strict().refine((value) => Boolean(value.path || value.dataUrl), 'Attachment import item requires path or dataUrl') satisfies z.ZodType<PromptAttachmentImportItem>;
export const promptAttachmentImportItemsSchema = z.array(promptAttachmentImportItemSchema).max(12).default([]);
export const filePathSchema = trimmedString(1, 2048).refine((value) => !value.startsWith('/'), 'Only project-relative file paths are allowed.');
export const projectFileContentSchema = z.string().max(500_000);
export const memoryFilePathSchema = trimmedString(1, 2048)
  .refine((value) => !value.startsWith('/'), 'Only project-relative memory paths are allowed.')
  .refine((value) => /^memory\.md$/i.test(value) || /^memory\//i.test(value), 'Only project memory files are allowed.')
  .refine((value) => /\.md$/i.test(value), 'Only Markdown memory files are allowed.');
export const memoryFileContentSchema = z.string().max(500_000);
export const memoryClearInputSchema = z.object({
  scope: z.enum(['file', 'daily', 'all']),
  filePath: memoryFilePathSchema.optional()
}).strict();
export const resourceUriSchema = trimmedString(1, 2048);
export const mcpPromptNameSchema = trimmedString(1, 240);
export const mcpPromptArgsSchema = z.record(z.string().trim().min(1).max(160), z.unknown()).default({});
export const mcpCompletionRefSchema = z.union([
  z.object({
    type: z.literal('ref/prompt'),
    name: mcpPromptNameSchema
  }).strict(),
  z.object({
    type: z.literal('ref/resource'),
    uri: resourceUriSchema
  }).strict()
]);
export const mcpCompletionValueSchema = z.string().max(1000).default('');
export const mcpCompletionContextSchema = z.record(z.string().trim().min(1).max(160), z.unknown()).default({});
export const externalUrlSchema = z.string().trim().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'Only http/https URLs can be opened externally.');
export const localPathSchema = trimmedString(1, 4096)
  .refine((value) => isAbsolute(value), 'Only absolute local file paths can be opened.')
  .refine((value) => !value.includes('\0'), 'Local file paths cannot contain null bytes.');
export const toolNameSchema = trimmedString(1, 120);
export const toolArgsSchema = z.record(z.string(), z.unknown()).default({});
export const mcpBindingKindSchema = mcpPluginKindSchema;

export function validateIpcInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`${label} is invalid: ${result.error.issues[0]?.message ?? 'unknown issue'}`);
  }
  return result.data;
}
