import type { TaskPhase, AssetType, GameAgentOperationType, AgentPermissionMode, AgentRuntimeStrategy, ProjectSessionEffort } from './project';
import type { McpPluginKind } from './unity';

export type AiProviderProtocol = 'openai-compatible' | 'anthropic' | 'google' | 'bedrock' | 'vertex';
export type AiProviderApiMode = 'responses' | 'chat';
export type AiProviderAuthStyle = 'api_key' | 'auth_token' | 'env_only' | 'custom_header';
export type AiTestStatus = 'success' | 'error';
export type OpenAiCompatibleChatTokenParameter = 'max_tokens' | 'max_completion_tokens' | 'auto';
export type OpenAiCompatibleToolChoiceMode = 'auto' | 'none' | 'required';
export type OpenAiCompatibleSchemaTransform = 'default' | 'moonshot' | 'gemini';
export type OpenAiCompatibleReasoningRequestStyle = 'none' | 'dashscope-enable-thinking' | 'zhipu-thinking';
export type OpenAiCompatibleInterleavedReasoningField = 'reasoning_content' | 'reasoning_details';

export interface AiProvider {
  id: string;
  name: string;
  protocol: AiProviderProtocol;
  apiMode?: AiProviderApiMode;
  authStyle?: AiProviderAuthStyle;
  baseUrl: string;
  apiKey: string;
  hasStoredApiKey?: boolean;
  model: string;
  upstreamModel?: string;
  headers?: Record<string, string>;
  envOverrides?: Record<string, string>;
  availableModels?: AiProviderModel[];
  providerMeta?: AiProviderMeta;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number | false;
  chunkTimeoutMs?: number;
  enabled: boolean;
  isDefault: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiProviderRoleModels {
  default?: string;
  reasoning?: string;
  small?: string;
  haiku?: string;
  sonnet?: string;
  opus?: string;
}

export interface AiProviderModelCapabilities {
  reasoning?: boolean;
  toolUse?: boolean;
  vision?: boolean;
  pdf?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsEffort?: boolean;
  supportedEffortLevels?: ProjectSessionEffort[];
  supportsAdaptiveThinking?: boolean;
}

export interface AiProviderModel {
  modelId: string;
  upstreamModelId?: string;
  displayName?: string;
  role?: keyof AiProviderRoleModels;
  capabilities?: AiProviderModelCapabilities;
}

export interface AiProviderMeta {
  apiKeyUrl?: string;
  docsUrl?: string;
  pricingUrl?: string;
  statusPageUrl?: string;
  billingModel?: 'pay_as_you_go' | 'coding_plan' | 'token_plan' | 'free' | 'self_hosted';
  notes?: string[];
}

export interface OpenAiCompatibleProviderProfile {
  supportsChatCompletions?: boolean;
  supportsResponses?: boolean;
  streamingToolCalls?: boolean;
  reasoningContent?: boolean;
  interleavedReasoningField?: OpenAiCompatibleInterleavedReasoningField;
  chatTokenParameter?: OpenAiCompatibleChatTokenParameter;
  toolChoiceModes?: OpenAiCompatibleToolChoiceMode[];
  omitToolChoice?: boolean;
  schemaTransform?: OpenAiCompatibleSchemaTransform;
  reasoningRequestStyle?: OpenAiCompatibleReasoningRequestStyle;
  nativeWebSearch?: boolean;
}

export interface AiProviderInput {
  name: string;
  protocol: AiProviderProtocol;
  apiMode?: AiProviderApiMode;
  authStyle?: AiProviderAuthStyle;
  baseUrl: string;
  apiKey: string;
  model: string;
  upstreamModel?: string;
  headers?: Record<string, string>;
  envOverrides?: Record<string, string>;
  availableModels?: AiProviderModel[];
  providerMeta?: AiProviderMeta;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number | false;
  chunkTimeoutMs?: number;
  enabled?: boolean;
  notes?: string;
}

export interface AiProviderModelListRequest {
  providerId?: string;
  provider: AiProviderInput;
}

export interface AiProviderModelListResult {
  models: AiProviderModel[];
  fetchedAt: string;
  sourceUrl: string;
}

export interface AiProviderPreset {
  id: string;
  name: string;
  protocol: AiProviderProtocol;
  apiMode?: AiProviderApiMode;
  authStyle?: AiProviderAuthStyle;
  baseUrl: string;
  defaultModel: string;
  upstreamModel?: string;
  defaultHeaders?: Record<string, string>;
  defaultEnvOverrides?: Record<string, string>;
  availableModels?: AiProviderModel[];
  providerMeta?: AiProviderMeta;
  openAiCompatible?: OpenAiCompatibleProviderProfile;
  apiKeyHint: string;
  description: string;
}

export type WebSearchProvider = 'auto' | 'duckduckgo' | 'brave' | 'bing';

export interface WebSearchSettings {
  provider: WebSearchProvider;
  braveApiKey?: string;
  bingApiKey?: string;
  cacheTtlMs: number;
  browserFallbackEnabled: boolean;
  telemetryEnabled: boolean;
}

export interface AiSettings {
  defaultProviderId?: string;
  fallbackToLocalPlanner: boolean;
  webSearch: WebSearchSettings;
}

export interface AgentSettings {
  permissionMode: AgentPermissionMode;
  runtimeStrategy: AgentRuntimeStrategy;
}

export interface AiTestResult {
  providerId: string;
  status: AiTestStatus;
  message: string;
  testedAt: string;
}

export interface WebResearchMetrics {
  searchRequests: number;
  fetchRequests: number;
  cacheHits: number;
  failures: number;
  browserFallbacks: number;
  documentExtractions: number;
  providerRequests: Record<string, number>;
  totalDurationMs: number;
  lastRequest?: {
    kind: 'search' | 'fetch';
    provider?: string;
    cacheHit: boolean;
    durationMs: number;
    ok: boolean;
    extraction?: string;
    at: string;
  };
}

export interface WebSearchQualityCaseResult {
  id: string;
  query: string;
  provider: Exclude<WebSearchProvider, 'auto'>;
  ok: boolean;
  durationMs: number;
  citationCount: number;
  requiredDomain?: string;
  error?: string;
}

export interface WebSearchQualityReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  averageDurationMs: number;
  cases: WebSearchQualityCaseResult[];
}

export interface AiProjectPlan {
  premise: string;
  playerFantasy: string;
  targetAudience: string;
  artDirection: string;
  coreLoop: string[];
  pillars: string[];
  differentiators: string[];
  tasks: Array<{
    title: string;
    phase: TaskPhase;
    owner: string;
    description: string;
  }>;
  assets: Array<{
    name: string;
    type: AssetType;
    prompt: string;
    notes: string;
  }>;
  executionPlan: {
    summary: string;
    rationale: string;
    actions: Array<{
      pluginKind: McpPluginKind;
      title: string;
      objective: string;
      suggestedTools: string[];
      inputs: string[];
      operations: Array<{
        type: GameAgentOperationType;
        target: string;
        arguments?: Record<string, unknown>;
      }>;
      successCriteria: string[];
    }>;
  };
  assistantReply: string;
}

export interface AiProjectUpdate {
  premise?: string;
  playerFantasy?: string;
  targetAudience?: string;
  artDirection?: string;
  coreLoop?: string[];
  pillars?: string[];
  differentiators?: string[];
  tasksToAdd: Array<{
    title: string;
    phase: TaskPhase;
    owner: string;
    description: string;
  }>;
  assetsToAdd: Array<{
    name: string;
    type: AssetType;
    prompt: string;
    notes: string;
  }>;
  executionPlan: {
    summary: string;
    rationale: string;
    actions: Array<{
      pluginKind: McpPluginKind;
      title: string;
      objective: string;
      suggestedTools: string[];
      inputs: string[];
      operations: Array<{
        type: GameAgentOperationType;
        target: string;
        arguments?: Record<string, unknown>;
      }>;
      successCriteria: string[];
    }>;
  };
  assistantReply: string;
  activitySummary: string;
}

export interface AiExecutionReplan {
  executionPlan: {
    summary: string;
    rationale: string;
    actions: Array<{
      pluginKind: McpPluginKind;
      title: string;
      objective: string;
      suggestedTools: string[];
      inputs: string[];
      operations: Array<{
        type: GameAgentOperationType;
        target: string;
        arguments?: Record<string, unknown>;
      }>;
      successCriteria: string[];
    }>;
  };
  assistantReply: string;
  activitySummary: string;
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  provider: 'auto',
  cacheTtlMs: 10 * 60 * 1000,
  browserFallbackEnabled: true,
  telemetryEnabled: true
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  fallbackToLocalPlanner: true,
  webSearch: DEFAULT_WEB_SEARCH_SETTINGS
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  permissionMode: 'full-access',
  runtimeStrategy: 'native'
};
