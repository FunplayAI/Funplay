import type { PlatformChoice } from './unity';

export type AssetGenerationKind =
  | 'image_2d'
  | 'ui_2d'
  | 'texture_2d'
  | 'animation_2d_frames'
  | 'animation_2d_rig'
  | 'model_3d'
  | 'animation_3d'
  | 'audio_sfx'
  | 'audio_music'
  | 'voice';

export type AssetGenerationCapability =
  | 'image.generate'
  | 'image.edit'
  | 'ui.generate'
  | 'texture.generate'
  | 'animation.frames.generate'
  | 'animation.rig.generate'
  | 'model3d.generate'
  | 'animation3d.generate'
  | 'audio.sfx.generate'
  | 'audio.music.generate'
  | 'voice.generate';

export type AssetGenerationProviderAdapterKind =
  | 'openai-image'
  | 'replicate'
  | 'stability'
  | 'comfyui'
  | 'meshy'
  | 'elevenlabs'
  | 'mcp';

export type AssetGenerationConfigurableProviderAdapterKind = Exclude<AssetGenerationProviderAdapterKind, 'mcp'>;

export type AssetGenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AssetGenerationCreatedBy = 'user' | 'agent';

export interface AssetGenerationReference {
  id: string;
  name: string;
  path: string;
  kind?: AssetGenerationKind;
  role?: 'style' | 'character' | 'pose' | 'audio' | 'mesh' | 'other';
}

export interface AssetGenerationOutputSpec {
  format?: string;
  width?: number;
  height?: number;
  frameCount?: number;
  durationSeconds?: number;
  loop?: boolean;
  transparentBackground?: boolean;
  engineImportMode?: 'none' | 'copy' | 'unity';
}

export interface AssetGenerationRequest {
  title: string;
  kind: AssetGenerationKind;
  prompt: string;
  negativePrompt?: string;
  providerId?: string;
  providerAdapter?: AssetGenerationProviderAdapterKind;
  stylePresetId?: string;
  references?: AssetGenerationReference[];
  targetEngine?: PlatformChoice;
  outputSpec?: AssetGenerationOutputSpec;
  count?: number;
  createdBy?: AssetGenerationCreatedBy;
}

export interface AssetGenerationOutput {
  id: string;
  name: string;
  kind: AssetGenerationKind;
  path: string;
  mimeType: string;
  format: string;
  size: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  previewPath?: string;
  importedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetGenerationJob {
  id: string;
  projectId: string;
  title: string;
  kind: AssetGenerationKind;
  prompt: string;
  negativePrompt?: string;
  providerId: string;
  providerName: string;
  providerAdapter: AssetGenerationProviderAdapterKind;
  stylePresetId?: string;
  references: AssetGenerationReference[];
  targetEngine?: PlatformChoice;
  outputSpec: AssetGenerationOutputSpec;
  status: AssetGenerationJobStatus;
  progress: number;
  createdBy: AssetGenerationCreatedBy;
  outputs: AssetGenerationOutput[];
  error?: string;
  costEstimate?: string;
  remoteJobId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AssetGenerationPreset {
  id: string;
  name: string;
  kind: AssetGenerationKind;
  promptPrefix: string;
  negativePrompt?: string;
  outputSpec?: AssetGenerationOutputSpec;
  createdAt: string;
  updatedAt: string;
}

export interface AssetGenerationProviderProfile {
  id: string;
  name: string;
  adapter: AssetGenerationProviderAdapterKind;
  enabled: boolean;
  capabilities: AssetGenerationCapability[];
  supportedKinds: AssetGenerationKind[];
  modelLabel?: string;
  endpointLabel?: string;
  notes?: string;
  requiresNetwork: boolean;
  supportsAsyncJobs: boolean;
}

export interface AssetGenerationProviderConfig {
  id: string;
  name: string;
  adapter: AssetGenerationConfigurableProviderAdapterKind;
  enabled: boolean;
  baseUrl?: string;
  apiKey: string;
  hasStoredApiKey?: boolean;
  model?: string;
  workflowJson?: string;
  workflowPath?: string;
  voiceId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetGenerationProviderInput {
  name: string;
  adapter: AssetGenerationConfigurableProviderAdapterKind;
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  workflowJson?: string;
  workflowPath?: string;
  voiceId?: string;
  notes?: string;
}

export interface AssetGenerationImportResult {
  projectId: string;
  jobId: string;
  importedOutputIds: string[];
  projectUpdatedAt: string;
}
