import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AppState,
  AssetGenerationCapability,
  AssetGenerationConfigurableProviderAdapterKind,
  AssetGenerationJob,
  AssetGenerationKind,
  AssetGenerationOutput,
  AssetGenerationProviderConfig,
  AssetGenerationProviderInput,
  AssetGenerationProviderProfile,
  AssetGenerationRequest,
  Project
} from '../../shared/types';
import {
  formatAssetGenerationImageDimensionValidation,
  isAssetGenerationImageDimensionConstrainedKind,
  validateAssetGenerationRequestImageDimensions
} from '../../shared/asset-generation-validation';
import { resolveProjectRootPathForProject } from './project-file-service';
import { isPathInsideRoot } from './path-guard';
import { callUnityTool, listUnityTools } from './unity-mcp-client';
import {
  deleteAssetGenerationProviderSecret,
  persistAssetGenerationProviderSecret
} from './asset-generation-secret-store';

const allLocalCapabilities: AssetGenerationCapability[] = [
  'image.generate',
  'image.edit',
  'ui.generate',
  'texture.generate',
  'animation.frames.generate',
  'animation.rig.generate',
  'model3d.generate',
  'animation3d.generate',
  'audio.sfx.generate',
  'audio.music.generate',
  'voice.generate'
];

const allGenerationKinds: AssetGenerationKind[] = [
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
];

const visualGenerationKinds: AssetGenerationKind[] = ['image_2d', 'ui_2d', 'texture_2d', 'animation_2d_frames'];
const openAiGenerationKinds: AssetGenerationKind[] = ['image_2d', 'ui_2d', 'texture_2d'];
const audioGenerationKinds: AssetGenerationKind[] = ['audio_sfx', 'audio_music'];
const defaultProviderTimeoutMs = 180_000;
// Shorter timeout for the very first submit/queue request to a provider, so an
// unreachable endpoint surfaces as a fast failure instead of hanging near the
// start of the progress bar for the full provider timeout.
const initialSubmitTimeoutMs = 30_000;

interface ExecutableAssetGenerationProvider extends AssetGenerationProviderProfile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  workflowJson?: string;
  workflowPath?: string;
  voiceId?: string;
}

interface GeneratedAssetPayload {
  body?: string | Buffer;
  sourceUrl?: string;
  existingPath?: string;
  name?: string;
  mimeType?: string;
  format?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  metadata?: Record<string, unknown>;
}

interface AssetGenerationRunOptions {
  onProjectUpdate?: (project: Project) => void | Promise<void>;
}

interface AssetGenerationProviderProgress {
  fraction: number;
  remoteJobId?: string;
}

interface AssetGenerationProviderContext {
  onProgress?: (progress: AssetGenerationProviderProgress) => void | Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function enabledWhen(...values: Array<string | undefined>): boolean {
  return values.every(Boolean);
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/\/+$/, '');
}

function resolveOpenAiImageGenerationsUrl(baseUrl: string | undefined): string {
  const normalized = normalizeBaseUrl(baseUrl?.trim(), 'https://api.openai.com/v1');
  if (/\/images\/generations$/i.test(normalized)) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath || '/v1'}/images/generations`;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return `${normalized}/images/generations`;
  }
}

function truncateProviderBody(value: string): string {
  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
}

function compactProviderText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripHtmlProviderBody(value: string): string {
  return compactProviderText(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

function providerStatusLabel(response: Response): string {
  return compactProviderText(`${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
}

function extractProviderJsonError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const directMessage = typeof record.message === 'string' ? record.message : undefined;
  const directError = typeof record.error === 'string' ? record.error : undefined;
  if (directMessage || directError) {
    return compactProviderText([directMessage, directError].filter(Boolean).join(' '));
  }
  if (record.error && typeof record.error === 'object') {
    return extractProviderJsonError(record.error);
  }
  return undefined;
}

function summarizeProviderBody(value: string, contentType: string | null): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const parsed = parseMaybeJson(trimmed);
  const jsonError = extractProviderJsonError(parsed);
  if (jsonError) {
    return truncateProviderBody(jsonError);
  }
  const looksLikeHtml = /html/i.test(contentType ?? '') || /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  const compact = looksLikeHtml ? stripHtmlProviderBody(trimmed) : compactProviderText(trimmed);
  return truncateProviderBody(compact);
}

function providerFailureHint(response: Response, bodySummary: string): string | undefined {
  if (response.status === 504) {
    return 'Provider gateway timed out before returning an image. Try again with one image, a smaller size, or retry later.';
  }
  if (response.status === 502 || response.status === 503) {
    return 'Provider gateway is temporarily unavailable. Retry later or switch to another asset provider.';
  }
  if (response.status === 429) {
    return 'Provider rate limit was reached. Wait a moment, reduce the request count, or switch provider.';
  }
  if (response.status >= 500) {
    return 'Provider returned a server error. Retry later or switch to another asset provider.';
  }
  if (/cloudflare|gateway time-out|gateway timeout/i.test(bodySummary)) {
    return 'Provider gateway timed out before returning a result. Retry later or switch provider.';
  }
  return undefined;
}

function clampProgress(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeRemoteProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value > 1 ? clampProgress(value / 100) : clampProgress(value);
}

function readRemoteProgressValue(value: unknown): number | undefined {
  const direct = normalizeRemoteProgress(value);
  if (direct !== undefined) {
    return direct;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return normalizeRemoteProgress(record.progress) ??
    normalizeRemoteProgress(record.percentage) ??
    normalizeRemoteProgress(record.percent) ??
    normalizeRemoteProgress(record.completed) ??
    normalizeRemoteProgress(record.metrics && typeof record.metrics === 'object'
      ? (record.metrics as Record<string, unknown>).progress
      : undefined);
}

function providerPollIntervalMs(defaultMs: number): number {
  const configured = Number.parseInt(process.env.FUNPLAY_ASSET_GENERATION_POLL_INTERVAL_MS ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : defaultMs;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = defaultProviderTimeoutMs): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function assertOkResponse(response: Response, label: string): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const body = await readResponseText(response);
  const bodySummary = summarizeProviderBody(body, response.headers.get('content-type'));
  const hint = providerFailureHint(response, bodySummary);
  const detail = hint ?? (bodySummary || response.statusText || 'Request failed.');
  const providerDetail = hint && bodySummary && !/gateway time-?out|cloudflare|error code 504/i.test(bodySummary)
    ? ` Provider said: ${bodySummary}`
    : '';
  throw new Error(`${label} failed (${providerStatusLabel(response)}): ${detail}${providerDetail}`);
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  await assertOkResponse(response, label);
  const text = await readResponseText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    const bodySummary = summarizeProviderBody(text, response.headers.get('content-type'));
    throw new Error(`${label} returned invalid JSON: ${bodySummary || 'empty response'}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extensionForMimeType(mimeType: string | undefined, fallback: string): string {
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/wave' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'audio/ogg') return 'ogg';
  if (normalized === 'model/gltf+json') return 'gltf';
  if (normalized === 'model/gltf-binary' || normalized === 'model/gltf+binary') return 'glb';
  if (normalized === 'application/json') return 'json';
  return fallback;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function downloadUrlPayload(url: string): Promise<{ body: Buffer; mimeType?: string; format?: string }> {
  const response = await assertOkResponse(await fetchWithTimeout(url), 'Download generated asset');
  const mimeType = response.headers.get('content-type') ?? undefined;
  const body = Buffer.from(await response.arrayBuffer());
  const urlPath = new URL(url).pathname;
  const extension = extname(urlPath).slice(1).toLowerCase();
  return {
    body,
    mimeType,
    format: extension || extensionForMimeType(mimeType, 'bin')
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'asset';
}

async function writeUniqueProjectOutputFile(
  project: Project,
  basePath: string,
  baseName: string,
  extension: string,
  body: string | Buffer
): Promise<{ relativePath: string; absolutePath: string }> {
  const slug = slugify(baseName);
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : `_${index}`;
    const relativePath = `${basePath}/${slug}${suffix}.${extension}`;
    const absolutePath = resolveProjectOutputPath(project, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, body, { flag: 'wx' });
      return { relativePath, absolutePath };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  throw new Error('无法找到可用的素材输出文件名。');
}

function assetTypeForKind(kind: AssetGenerationKind): Project['assets'][number]['type'] {
  if (kind === 'audio_sfx' || kind === 'audio_music' || kind === 'voice') {
    return 'audio';
  }
  if (kind === 'ui_2d') {
    return 'ui';
  }
  if (kind === 'animation_2d_frames' || kind === 'animation_2d_rig' || kind === 'animation_3d') {
    return 'vfx';
  }
  if (kind === 'texture_2d') {
    return 'environment';
  }
  return 'character';
}

function categoryForKind(kind: AssetGenerationKind): string {
  if (kind === 'audio_sfx' || kind === 'audio_music' || kind === 'voice') return 'audio';
  if (kind === 'model_3d') return 'models';
  if (kind === 'animation_2d_frames' || kind === 'animation_2d_rig' || kind === 'animation_3d') return 'animations';
  if (kind === 'ui_2d') return 'ui';
  if (kind === 'texture_2d') return 'textures';
  return 'images';
}

function extensionForKind(kind: AssetGenerationKind): string {
  if (kind === 'audio_sfx' || kind === 'audio_music' || kind === 'voice') return 'wav';
  if (kind === 'model_3d' || kind === 'animation_3d') return 'gltf';
  if (kind === 'animation_2d_rig') return 'json';
  return 'svg';
}

function mimeForExtension(extension: string): string {
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'ogg') return 'audio/ogg';
  if (extension === 'glb') return 'model/gltf-binary';
  if (extension === 'gltf') return 'model/gltf+json';
  if (extension === 'json') return 'application/json';
  return 'text/plain';
}

function labelForKind(kind: AssetGenerationKind): string {
  const labels: Record<AssetGenerationKind, string> = {
    image_2d: '2D Image',
    ui_2d: '2D UI',
    texture_2d: '2D Texture',
    animation_2d_frames: '2D Frame Animation',
    animation_2d_rig: '2D Rig Animation',
    model_3d: '3D Model',
    animation_3d: '3D Animation',
    audio_sfx: 'Sound Effect',
    audio_music: 'Music Loop',
    voice: 'Voice'
  };
  return labels[kind];
}

function outputBasePath(project: Project, kind: AssetGenerationKind): string {
  const category = categoryForKind(kind);
  if (project.engine?.platform === 'unity') {
    return `Assets/FunplayGenerated/${category}`;
  }
  return `assets/generated/${category}`;
}

function resolveProjectOutputPath(project: Project, relativePath: string): string {
  const rootPath = resolveProjectRootPathForProject(project);
  const normalized = relativePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) {
    throw new Error('非法素材输出路径。');
  }
  const absolutePath = resolve(rootPath, normalized);
  if (!isPathInsideRoot(rootPath, absolutePath)) {
    throw new Error('非法素材输出路径。');
  }
  return absolutePath;
}

function toProjectRelativePath(project: Project, absolutePath: string): string {
  return relative(resolveProjectRootPathForProject(project), absolutePath).replaceAll('\\', '/');
}

async function writeGeneratedPayload(
  project: Project,
  input: AssetGenerationRequest,
  payload: GeneratedAssetPayload,
  variant: number
): Promise<AssetGenerationOutput> {
  if (payload.existingPath) {
    const absolutePath = resolveProjectOutputPath(project, payload.existingPath);
    const fileStat = await stat(absolutePath);
    const extension = extname(absolutePath).slice(1).toLowerCase() || payload.format || extensionForKind(input.kind);
    return {
      id: `output_${randomUUID()}`,
      name: payload.name ?? `${input.title}${variant > 1 ? `-${variant}` : ''}`,
      kind: input.kind,
      path: toProjectRelativePath(project, absolutePath),
      mimeType: payload.mimeType ?? mimeForExtension(extension),
      format: extension,
      size: fileStat.size,
      width: payload.width,
      height: payload.height,
      durationSeconds: payload.durationSeconds,
      previewPath: toProjectRelativePath(project, absolutePath),
      importedAt: nowIso(),
      metadata: payload.metadata
    };
  }

  const resolvedPayload = payload.sourceUrl ? {
    ...payload,
    ...(await downloadUrlPayload(payload.sourceUrl))
  } : payload;
  if (!resolvedPayload.body) {
    throw new Error('Asset provider did not return file data or a downloadable URL.');
  }

  const fallbackExtension = extensionForKind(input.kind);
  const extension = (resolvedPayload.format || extensionForMimeType(resolvedPayload.mimeType, fallbackExtension)).replace(/^\./, '').toLowerCase();
  const basePath = outputBasePath(project, input.kind);
  const { absolutePath } = await writeUniqueProjectOutputFile(project, basePath, payload.name ?? input.title, extension, resolvedPayload.body);
  const fileStat = await stat(absolutePath);
  return {
    id: `output_${randomUUID()}`,
    name: payload.name ?? `${input.title}${variant > 1 ? ` ${variant}` : ''}`,
    kind: input.kind,
    path: toProjectRelativePath(project, absolutePath),
    mimeType: resolvedPayload.mimeType ?? mimeForExtension(extension),
    format: extension,
    size: fileStat.size,
    width: resolvedPayload.width,
    height: resolvedPayload.height,
    durationSeconds: resolvedPayload.durationSeconds,
    previewPath: toProjectRelativePath(project, absolutePath),
    importedAt: nowIso(),
    metadata: resolvedPayload.metadata
  };
}

function readWorkflowJsonFromEnv(): string | undefined {
  const inline = env('FUNPLAY_COMFYUI_WORKFLOW_JSON') ?? env('COMFYUI_WORKFLOW_JSON');
  if (inline) {
    return inline;
  }
  const workflowPath = env('FUNPLAY_COMFYUI_WORKFLOW_PATH') ?? env('COMFYUI_WORKFLOW_PATH');
  if (!workflowPath || !existsSync(workflowPath)) {
    return undefined;
  }
  return readFileSync(workflowPath, 'utf8');
}

function defaultAssetProviderBaseUrl(adapter: AssetGenerationConfigurableProviderAdapterKind): string {
  const defaults: Record<AssetGenerationConfigurableProviderAdapterKind, string> = {
    'openai-image': 'https://api.openai.com/v1',
    stability: 'https://api.stability.ai',
    replicate: 'https://api.replicate.com/v1',
    comfyui: 'http://127.0.0.1:8188',
    meshy: 'https://api.meshy.ai/openapi/v2',
    elevenlabs: 'https://api.elevenlabs.io/v1'
  };
  return defaults[adapter];
}

function defaultAssetProviderModel(adapter: AssetGenerationConfigurableProviderAdapterKind): string {
  const defaults: Record<AssetGenerationConfigurableProviderAdapterKind, string> = {
    'openai-image': 'gpt-image-2',
    stability: 'core',
    replicate: '',
    comfyui: '',
    meshy: 'meshy-6',
    elevenlabs: 'eleven_text_to_sound_v2'
  };
  return defaults[adapter];
}

function defaultAssetProviderName(adapter: AssetGenerationConfigurableProviderAdapterKind): string {
  const defaults: Record<AssetGenerationConfigurableProviderAdapterKind, string> = {
    'openai-image': 'OpenAI Images',
    stability: 'Stability AI',
    replicate: 'Replicate',
    comfyui: 'ComfyUI',
    meshy: 'Meshy',
    elevenlabs: 'ElevenLabs Audio'
  };
  return defaults[adapter];
}

function adapterCapabilities(adapter: AssetGenerationConfigurableProviderAdapterKind, voiceId?: string): {
  capabilities: AssetGenerationCapability[];
  supportedKinds: AssetGenerationKind[];
  supportsAsyncJobs: boolean;
  requiresNetwork: boolean;
} {
  if (adapter === 'openai-image' || adapter === 'stability') {
    return {
      capabilities: ['image.generate', 'ui.generate', 'texture.generate'],
      supportedKinds: openAiGenerationKinds,
      supportsAsyncJobs: false,
      requiresNetwork: true
    };
  }
  if (adapter === 'replicate') {
    return {
      capabilities: ['image.generate', 'ui.generate', 'texture.generate', 'animation.frames.generate', 'model3d.generate', 'audio.sfx.generate'],
      supportedKinds: allGenerationKinds.filter((kind) => kind !== 'animation_2d_rig' && kind !== 'voice'),
      supportsAsyncJobs: true,
      requiresNetwork: true
    };
  }
  if (adapter === 'comfyui') {
    return {
      capabilities: ['image.generate', 'ui.generate', 'texture.generate'],
      supportedKinds: visualGenerationKinds,
      supportsAsyncJobs: true,
      requiresNetwork: false
    };
  }
  if (adapter === 'meshy') {
    return {
      capabilities: ['model3d.generate'],
      supportedKinds: ['model_3d'],
      supportsAsyncJobs: true,
      requiresNetwork: true
    };
  }
  return {
    capabilities: voiceId ? ['audio.sfx.generate', 'audio.music.generate', 'voice.generate'] : ['audio.sfx.generate', 'audio.music.generate'],
    supportedKinds: voiceId ? [...audioGenerationKinds, 'voice'] : audioGenerationKinds,
    supportsAsyncJobs: false,
    requiresNetwork: true
  };
}

function configuredProviderReady(provider: AssetGenerationProviderConfig): { ready: boolean; note: string } {
  if (provider.adapter === 'comfyui') {
    const ready = Boolean(provider.baseUrl?.trim() && (provider.workflowJson?.trim() || provider.workflowPath?.trim()));
    return {
      ready,
      note: ready ? 'Uses a configured ComfyUI API workflow.' : 'Configure Base URL and workflow JSON or workflow path.'
    };
  }
  if (provider.adapter === 'replicate') {
    const ready = Boolean(provider.apiKey.trim() && provider.model?.trim());
    return {
      ready,
      note: ready ? 'Uses Replicate predictions with the configured model or version.' : 'Configure API token and model/version.'
    };
  }
  if (provider.adapter === 'elevenlabs') {
    const ready = Boolean(provider.apiKey.trim());
    return {
      ready,
      note: ready ? 'Uses ElevenLabs sound generation and optional text-to-speech.' : 'Configure ElevenLabs API key.'
    };
  }
  const ready = Boolean(provider.apiKey.trim());
  return {
    ready,
    note: ready ? `Uses ${defaultAssetProviderName(provider.adapter)}.` : 'Configure API key.'
  };
}

// Conservative per-adapter maximum output edge (px) for image-style generations.
// Used to surface a friendly over-limit error before issuing the provider call,
// instead of letting the bar stall until the provider rejects oversized requests.
const assetProviderMaxImageEdge: Partial<Record<AssetGenerationConfigurableProviderAdapterKind, number>> = {
  'openai-image': 1536,
  stability: 1536
};

function checkProviderImageDimensionLimit(
  provider: ExecutableAssetGenerationProvider,
  request: AssetGenerationRequest
): string | undefined {
  if (!isAssetGenerationImageDimensionConstrainedKind(request.kind)) {
    return undefined;
  }
  const maxEdge = assetProviderMaxImageEdge[provider.adapter as AssetGenerationConfigurableProviderAdapterKind];
  if (!maxEdge) {
    return undefined;
  }
  const width = request.outputSpec?.width;
  const height = request.outputSpec?.height;
  if (typeof width !== 'number' || typeof height !== 'number') {
    return undefined;
  }
  if (Math.max(width, height) <= maxEdge) {
    return undefined;
  }
  return `Provider ${provider.name} 支持的最大边为 ${maxEdge}px，当前 ${width}x${height} 超限。请缩小尺寸后重试。/ Provider ${provider.name} supports a maximum edge of ${maxEdge}px; the requested ${width}x${height} exceeds it. Reduce the size and try again.`;
}

function assertConfiguredAssetProviderReady(provider: AssetGenerationProviderConfig): void {
  const readiness = configuredProviderReady(provider);
  if (readiness.ready) {
    return;
  }
  const adapterLabel = defaultAssetProviderName(provider.adapter);
  if (provider.adapter === 'comfyui') {
    throw new Error(
      `ComfyUI 配置不完整：需要填写 Base URL，以及工作流 JSON 或工作流文件路径。/ ComfyUI configuration is incomplete: set Base URL and either workflow JSON or a workflow file path.`
    );
  }
  if (provider.adapter === 'replicate') {
    throw new Error(
      `Replicate 配置不完整：需要填写 API Key 和模型/版本。/ Replicate configuration is incomplete: set an API Key and a model or version.`
    );
  }
  if (provider.adapter === 'elevenlabs') {
    throw new Error(
      `ElevenLabs 配置不完整：需要填写 API Key。/ ElevenLabs configuration is incomplete: set an API Key.`
    );
  }
  throw new Error(
    `${adapterLabel} 配置不完整：需要填写 API Key。/ ${adapterLabel} configuration is incomplete: set an API Key.`
  );
}

function readConfiguredWorkflowJson(provider: AssetGenerationProviderConfig): string | undefined {
  if (provider.workflowJson?.trim()) {
    return provider.workflowJson;
  }
  const workflowPath = provider.workflowPath?.trim();
  if (!workflowPath || !existsSync(workflowPath)) {
    return undefined;
  }
  return readFileSync(workflowPath, 'utf8');
}

function configuredProviderToExecutable(provider: AssetGenerationProviderConfig): ExecutableAssetGenerationProvider {
  const readiness = configuredProviderReady(provider);
  const capabilities = adapterCapabilities(provider.adapter, provider.voiceId);
  const baseUrl = normalizeBaseUrl(provider.baseUrl, defaultAssetProviderBaseUrl(provider.adapter));
  const workflowJson = provider.adapter === 'comfyui' ? readConfiguredWorkflowJson(provider) : provider.workflowJson;
  const model = provider.model?.trim() || defaultAssetProviderModel(provider.adapter) || undefined;
  return {
    id: provider.id,
    name: provider.name || defaultAssetProviderName(provider.adapter),
    adapter: provider.adapter,
    enabled: provider.enabled && readiness.ready && (provider.adapter !== 'comfyui' || Boolean(workflowJson)),
    ...capabilities,
    baseUrl,
    apiKey: provider.apiKey.trim() || undefined,
    model,
    workflowJson,
    workflowPath: provider.workflowPath,
    voiceId: provider.voiceId?.trim() || undefined,
    modelLabel: model || (provider.adapter === 'comfyui' ? 'workflow' : 'unconfigured'),
    endpointLabel: baseUrl,
    notes: provider.notes || readiness.note,
    requiresNetwork: capabilities.requiresNetwork,
    supportsAsyncJobs: capabilities.supportsAsyncJobs
  };
}

function buildEnvironmentAssetGenerationProviders(): ExecutableAssetGenerationProvider[] {
  const openAiApiKey = env('OPENAI_API_KEY');
  const stabilityApiKey = env('STABILITY_API_KEY');
  const replicateApiKey = env('REPLICATE_API_TOKEN') ?? env('REPLICATE_API_KEY');
  const comfyBaseUrl = env('FUNPLAY_COMFYUI_BASE_URL') ?? env('COMFYUI_BASE_URL');
  const comfyWorkflowJson = readWorkflowJsonFromEnv();
  const meshyApiKey = env('MESHY_API_KEY');
  const elevenLabsApiKey = env('ELEVENLABS_API_KEY');
  const elevenLabsVoiceId = env('FUNPLAY_ELEVENLABS_VOICE_ID') ?? env('ELEVENLABS_VOICE_ID');
  const replicateModel = env('FUNPLAY_REPLICATE_MODEL') ?? env('REPLICATE_MODEL') ?? env('FUNPLAY_REPLICATE_VERSION') ?? env('REPLICATE_VERSION');

  return [
    {
      id: 'openai-image',
      name: 'OpenAI Images',
      adapter: 'openai-image',
      enabled: enabledWhen(openAiApiKey),
      capabilities: ['image.generate', 'ui.generate', 'texture.generate'],
      supportedKinds: openAiGenerationKinds,
      model: env('FUNPLAY_OPENAI_IMAGE_MODEL') ?? 'gpt-image-2',
      baseUrl: normalizeBaseUrl(env('FUNPLAY_OPENAI_IMAGE_BASE_URL'), 'https://api.openai.com/v1'),
      apiKey: openAiApiKey,
      modelLabel: env('FUNPLAY_OPENAI_IMAGE_MODEL') ?? 'gpt-image-2',
      endpointLabel: env('FUNPLAY_OPENAI_IMAGE_BASE_URL') ?? 'https://api.openai.com/v1',
      notes: openAiApiKey ? 'Uses the OpenAI Image API.' : 'Set OPENAI_API_KEY to enable OpenAI image generation.',
      requiresNetwork: true,
      supportsAsyncJobs: false
    },
    {
      id: 'stability-image',
      name: 'Stability AI',
      adapter: 'stability',
      enabled: enabledWhen(stabilityApiKey),
      capabilities: ['image.generate', 'ui.generate', 'texture.generate'],
      supportedKinds: openAiGenerationKinds,
      model: env('FUNPLAY_STABILITY_IMAGE_MODEL') ?? 'core',
      baseUrl: normalizeBaseUrl(env('FUNPLAY_STABILITY_BASE_URL'), 'https://api.stability.ai'),
      apiKey: stabilityApiKey,
      modelLabel: env('FUNPLAY_STABILITY_IMAGE_MODEL') ?? 'core',
      endpointLabel: env('FUNPLAY_STABILITY_BASE_URL') ?? 'https://api.stability.ai',
      notes: stabilityApiKey ? 'Uses Stability Stable Image REST v2beta.' : 'Set STABILITY_API_KEY to enable Stability image generation.',
      requiresNetwork: true,
      supportsAsyncJobs: false
    },
    {
      id: 'replicate-asset',
      name: 'Replicate',
      adapter: 'replicate',
      enabled: enabledWhen(replicateApiKey, replicateModel),
      capabilities: ['image.generate', 'ui.generate', 'texture.generate', 'animation.frames.generate', 'model3d.generate', 'audio.sfx.generate'],
      supportedKinds: allGenerationKinds.filter((kind) => kind !== 'animation_2d_rig' && kind !== 'voice'),
      model: replicateModel,
      baseUrl: normalizeBaseUrl(env('FUNPLAY_REPLICATE_BASE_URL'), 'https://api.replicate.com/v1'),
      apiKey: replicateApiKey,
      modelLabel: replicateModel ?? 'unconfigured model/version',
      endpointLabel: env('FUNPLAY_REPLICATE_BASE_URL') ?? 'https://api.replicate.com/v1',
      notes: enabledWhen(replicateApiKey, replicateModel)
        ? 'Uses Replicate predictions with the configured model or version.'
        : 'Set REPLICATE_API_TOKEN and FUNPLAY_REPLICATE_MODEL or FUNPLAY_REPLICATE_VERSION.',
      requiresNetwork: true,
      supportsAsyncJobs: true
    },
    {
      id: 'comfyui-asset',
      name: 'ComfyUI',
      adapter: 'comfyui',
      enabled: enabledWhen(comfyBaseUrl, comfyWorkflowJson),
      capabilities: ['image.generate', 'ui.generate', 'texture.generate'],
      supportedKinds: visualGenerationKinds,
      baseUrl: normalizeBaseUrl(comfyBaseUrl, 'http://127.0.0.1:8188'),
      workflowJson: comfyWorkflowJson,
      modelLabel: env('FUNPLAY_COMFYUI_WORKFLOW_NAME') ?? 'workflow',
      endpointLabel: comfyBaseUrl ?? 'http://127.0.0.1:8188',
      notes: enabledWhen(comfyBaseUrl, comfyWorkflowJson)
        ? 'Uses a configured ComfyUI API workflow.'
        : 'Set FUNPLAY_COMFYUI_BASE_URL and FUNPLAY_COMFYUI_WORKFLOW_JSON or FUNPLAY_COMFYUI_WORKFLOW_PATH.',
      requiresNetwork: false,
      supportsAsyncJobs: true
    },
    {
      id: 'meshy-3d',
      name: 'Meshy',
      adapter: 'meshy',
      enabled: enabledWhen(meshyApiKey),
      capabilities: ['model3d.generate'],
      supportedKinds: ['model_3d'],
      model: env('FUNPLAY_MESHY_MODEL') ?? 'meshy-6',
      baseUrl: normalizeBaseUrl(env('FUNPLAY_MESHY_BASE_URL'), 'https://api.meshy.ai/openapi/v2'),
      apiKey: meshyApiKey,
      modelLabel: env('FUNPLAY_MESHY_MODEL') ?? 'meshy-6',
      endpointLabel: env('FUNPLAY_MESHY_BASE_URL') ?? 'https://api.meshy.ai/openapi/v2',
      notes: meshyApiKey ? 'Uses Meshy Text to 3D.' : 'Set MESHY_API_KEY to enable Meshy 3D generation.',
      requiresNetwork: true,
      supportsAsyncJobs: true
    },
    {
      id: 'elevenlabs-audio',
      name: 'ElevenLabs Audio',
      adapter: 'elevenlabs',
      enabled: enabledWhen(elevenLabsApiKey),
      capabilities: elevenLabsVoiceId
        ? ['audio.sfx.generate', 'audio.music.generate', 'voice.generate']
        : ['audio.sfx.generate', 'audio.music.generate'],
      supportedKinds: elevenLabsVoiceId ? [...audioGenerationKinds, 'voice'] : audioGenerationKinds,
      model: env('FUNPLAY_ELEVENLABS_MODEL') ?? 'eleven_text_to_sound_v2',
      voiceId: elevenLabsVoiceId,
      baseUrl: normalizeBaseUrl(env('FUNPLAY_ELEVENLABS_BASE_URL'), 'https://api.elevenlabs.io/v1'),
      apiKey: elevenLabsApiKey,
      modelLabel: env('FUNPLAY_ELEVENLABS_MODEL') ?? 'eleven_text_to_sound_v2',
      endpointLabel: env('FUNPLAY_ELEVENLABS_BASE_URL') ?? 'https://api.elevenlabs.io/v1',
      notes: elevenLabsApiKey ? 'Uses ElevenLabs sound generation and optional text-to-speech.' : 'Set ELEVENLABS_API_KEY to enable audio generation.',
      requiresNetwork: true,
      supportsAsyncJobs: false
    }
  ];
}

function buildExecutableAssetGenerationProviders(state: AppState): ExecutableAssetGenerationProvider[] {
  const configuredProviders = (state.assetGenerationProviders ?? []).map(configuredProviderToExecutable);
  const mcpAssetProviders: ExecutableAssetGenerationProvider[] = state.mcpPlugins
    .filter((plugin) => plugin.kind === 'asset')
    .map((plugin) => ({
      id: `mcp:${plugin.id}`,
      name: plugin.name,
      adapter: 'mcp',
      enabled: plugin.enabled,
      capabilities: allLocalCapabilities,
      supportedKinds: allGenerationKinds,
      endpointLabel: plugin.transport === 'stdio' ? plugin.command : plugin.baseUrl,
      notes: plugin.notes || 'Uses the configured MCP asset server tool interface.',
      requiresNetwork: plugin.transport !== 'stdio',
      supportsAsyncJobs: true
    }));

  return [
    ...configuredProviders,
    ...buildEnvironmentAssetGenerationProviders(),
    ...mcpAssetProviders
  ];
}

export function listAssetGenerationProviders(state: AppState): AssetGenerationProviderProfile[] {
  return buildExecutableAssetGenerationProviders(state).map(({ apiKey, workflowJson, workflowPath, voiceId, baseUrl, model, ...profile }) => profile);
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAssetGenerationProviderInput(
  input: AssetGenerationProviderInput,
  current?: AssetGenerationProviderConfig
): AssetGenerationProviderConfig {
  const timestamp = nowIso();
  const apiKey = input.apiKey?.trim() || current?.apiKey?.trim() || '';
  const adapter = input.adapter;
  return {
    id: current?.id ?? `asset_provider_${randomUUID()}`,
    name: input.name.trim() || defaultAssetProviderName(adapter),
    adapter,
    enabled: input.enabled ?? current?.enabled ?? true,
    baseUrl: cleanOptional(input.baseUrl) ?? cleanOptional(current?.baseUrl) ?? defaultAssetProviderBaseUrl(adapter),
    apiKey,
    hasStoredApiKey: Boolean(apiKey),
    model: cleanOptional(input.model) ?? (current?.adapter === adapter ? cleanOptional(current.model) : undefined) ?? cleanOptional(defaultAssetProviderModel(adapter)),
    workflowJson: input.workflowJson?.trim() || (current?.adapter === adapter ? current.workflowJson : undefined) || undefined,
    workflowPath: cleanOptional(input.workflowPath) ?? (current?.adapter === adapter ? cleanOptional(current.workflowPath) : undefined),
    voiceId: cleanOptional(input.voiceId) ?? (current?.adapter === adapter ? cleanOptional(current.voiceId) : undefined),
    notes: cleanOptional(input.notes) ?? '',
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

export async function createAssetGenerationProvider(
  state: AppState,
  input: AssetGenerationProviderInput
): Promise<AssetGenerationProviderConfig> {
  const provider = normalizeAssetGenerationProviderInput(input);
  assertConfiguredAssetProviderReady(provider);
  await persistAssetGenerationProviderSecret(provider.id, provider.apiKey);
  state.assetGenerationProviders = [provider, ...(state.assetGenerationProviders ?? [])];
  return provider;
}

export async function updateAssetGenerationProvider(
  state: AppState,
  providerId: string,
  input: AssetGenerationProviderInput
): Promise<AssetGenerationProviderConfig> {
  const providers = state.assetGenerationProviders ?? [];
  const index = providers.findIndex((provider) => provider.id === providerId);
  if (index < 0) {
    throw new Error('Asset generation provider not found.');
  }
  const provider = normalizeAssetGenerationProviderInput(input, providers[index]);
  assertConfiguredAssetProviderReady(provider);
  await persistAssetGenerationProviderSecret(provider.id, provider.apiKey);
  state.assetGenerationProviders = providers.map((current, currentIndex) => (currentIndex === index ? provider : current));
  return provider;
}

export async function deleteAssetGenerationProvider(state: AppState, providerId: string): Promise<void> {
  const providers = state.assetGenerationProviders ?? [];
  const next = providers.filter((provider) => provider.id !== providerId);
  if (next.length === providers.length) {
    throw new Error('Asset generation provider not found.');
  }
  await deleteAssetGenerationProviderSecret(providerId);
  state.assetGenerationProviders = next;
}

function normalizeImageOutputFormat(input: AssetGenerationRequest, fallback = 'png'): string {
  const requested = input.outputSpec?.format?.toLowerCase();
  if (requested === 'jpg' || requested === 'jpeg') return 'jpeg';
  if (requested === 'webp') return 'webp';
  if (requested === 'png') return 'png';
  return fallback;
}

function imageSize(input: AssetGenerationRequest): string | undefined {
  const width = input.outputSpec?.width;
  const height = input.outputSpec?.height;
  if (!width || !height) {
    return undefined;
  }
  return `${width}x${height}`;
}

async function generateOpenAiImage(provider: ExecutableAssetGenerationProvider, input: AssetGenerationRequest): Promise<GeneratedAssetPayload[]> {
  if (!provider.apiKey) {
    throw new Error('OpenAI image provider is missing OPENAI_API_KEY.');
  }
  const outputFormat = normalizeImageOutputFormat(input, 'png');
  const requestBody: Record<string, unknown> = {
    model: provider.model ?? 'gpt-image-2',
    prompt: input.negativePrompt ? `${input.prompt}\n\nAvoid: ${input.negativePrompt}` : input.prompt,
    n: Math.max(1, Math.min(input.count ?? 1, 4)),
    output_format: outputFormat
  };
  const size = imageSize(input);
  if (size) {
    requestBody.size = size;
  }
  if (input.outputSpec?.transparentBackground && provider.model !== 'gpt-image-2') {
    requestBody.background = 'transparent';
  }
  const response = await fetchWithTimeout(resolveOpenAiImageGenerationsUrl(provider.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });
  const json = await readJsonResponse<{ data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }>(response, 'OpenAI image generation');
  const data = json.data ?? [];
  if (data.length === 0) {
    throw new Error('OpenAI image generation returned no images.');
  }
  return data.map((item) => ({
    body: item.b64_json ? Buffer.from(item.b64_json, 'base64') : undefined,
    sourceUrl: item.url,
    name: input.title,
    mimeType: mimeForExtension(outputFormat === 'jpeg' ? 'jpg' : outputFormat),
    format: outputFormat === 'jpeg' ? 'jpg' : outputFormat,
    width: input.outputSpec?.width,
    height: input.outputSpec?.height,
    metadata: {
      adapter: provider.adapter,
      model: provider.model,
      revisedPrompt: item.revised_prompt
    }
  }));
}

async function generateStabilityImage(provider: ExecutableAssetGenerationProvider, input: AssetGenerationRequest): Promise<GeneratedAssetPayload[]> {
  if (!provider.apiKey) {
    throw new Error('Stability provider is missing STABILITY_API_KEY.');
  }
  const outputFormat = normalizeImageOutputFormat(input, 'png');
  const form = new FormData();
  form.set('prompt', input.prompt);
  if (input.negativePrompt) {
    form.set('negative_prompt', input.negativePrompt);
  }
  form.set('output_format', outputFormat === 'jpg' ? 'jpeg' : outputFormat);
  const response = await fetchWithTimeout(`${provider.baseUrl ?? 'https://api.stability.ai'}/v2beta/stable-image/generate/${provider.model ?? 'core'}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      Accept: 'image/*'
    },
    body: form
  });
  await assertOkResponse(response, 'Stability image generation');
  const mimeType = response.headers.get('content-type') ?? mimeForExtension(outputFormat === 'jpeg' ? 'jpg' : outputFormat);
  return [{
    body: Buffer.from(await response.arrayBuffer()),
    name: input.title,
    mimeType,
    format: extensionForMimeType(mimeType, outputFormat === 'jpeg' ? 'jpg' : outputFormat),
    width: input.outputSpec?.width,
    height: input.outputSpec?.height,
    metadata: {
      adapter: provider.adapter,
      model: provider.model
    }
  }];
}

function buildReplicateInput(input: AssetGenerationRequest): Record<string, unknown> {
  const replicateInput: Record<string, unknown> = {
    prompt: input.prompt
  };
  if (input.negativePrompt) {
    replicateInput.negative_prompt = input.negativePrompt;
  }
  if (input.outputSpec?.width) {
    replicateInput.width = input.outputSpec.width;
  }
  if (input.outputSpec?.height) {
    replicateInput.height = input.outputSpec.height;
  }
  if (input.outputSpec?.durationSeconds) {
    replicateInput.duration = input.outputSpec.durationSeconds;
    replicateInput.duration_seconds = input.outputSpec.durationSeconds;
  }
  if (input.count && input.count > 1) {
    replicateInput.num_outputs = input.count;
    replicateInput.num_images = input.count;
  }
  return replicateInput;
}

function collectUrls(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string' && isUrl(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, output);
    }
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectUrls(item, output);
    }
  }
  return output;
}

async function reportProviderProgress(
  context: AssetGenerationProviderContext | undefined,
  fraction: number,
  remoteJobId?: string
): Promise<void> {
  await context?.onProgress?.({
    fraction: clampProgress(fraction),
    remoteJobId
  });
}

function replicateStatusProgress(prediction: Record<string, unknown>, attempt: number): number | undefined {
  const remoteProgress = readRemoteProgressValue(prediction);
  if (remoteProgress !== undefined) {
    return remoteProgress;
  }
  const status = typeof prediction.status === 'string' ? prediction.status : '';
  if (status === 'starting') {
    return 0.08;
  }
  if (status === 'processing') {
    return Math.min(0.88, 0.18 + attempt * 0.012);
  }
  if (status === 'succeeded') {
    return 1;
  }
  return undefined;
}

async function waitForReplicatePrediction(
  prediction: Record<string, unknown>,
  apiKey: string,
  context?: AssetGenerationProviderContext
): Promise<Record<string, unknown>> {
  let current = prediction;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = typeof current.status === 'string' ? current.status : '';
    const remoteJobId = typeof current.id === 'string' ? current.id : undefined;
    const progress = replicateStatusProgress(current, attempt);
    if (progress !== undefined) {
      await reportProviderProgress(context, progress, remoteJobId);
    }
    if (status === 'succeeded') {
      return current;
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(`Replicate prediction ${status}: ${JSON.stringify(current.error ?? '')}`);
    }
    const urls = current.urls as Record<string, unknown> | undefined;
    const getUrl = typeof urls?.get === 'string' ? urls.get : undefined;
    if (!getUrl) {
      break;
    }
    await sleep(providerPollIntervalMs(2000));
    current = await readJsonResponse<Record<string, unknown>>(await fetchWithTimeout(getUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    }), 'Replicate prediction status');
  }
  throw new Error('Replicate prediction did not finish before the timeout.');
}

async function generateReplicateAsset(
  provider: ExecutableAssetGenerationProvider,
  input: AssetGenerationRequest,
  context?: AssetGenerationProviderContext
): Promise<GeneratedAssetPayload[]> {
  if (!provider.apiKey || !provider.model) {
    throw new Error('Replicate provider requires REPLICATE_API_TOKEN and FUNPLAY_REPLICATE_MODEL or FUNPLAY_REPLICATE_VERSION.');
  }
  const model = provider.model;
  const isModelSlug = model.includes('/') && !/^[a-f0-9]{32,}$/i.test(model);
  const endpoint = isModelSlug
    ? `${provider.baseUrl ?? 'https://api.replicate.com/v1'}/models/${model}/predictions`
    : `${provider.baseUrl ?? 'https://api.replicate.com/v1'}/predictions`;
  const body = isModelSlug
    ? { input: buildReplicateInput(input) }
    : { version: model, input: buildReplicateInput(input) };
  const prediction = await readJsonResponse<Record<string, unknown>>(await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60'
    },
    body: JSON.stringify(body)
  }, 75_000), 'Replicate prediction');
  const completed = await waitForReplicatePrediction(prediction, provider.apiKey, context);
  const urls = collectUrls(completed.output).slice(0, Math.max(1, input.count ?? 1));
  if (urls.length === 0) {
    throw new Error('Replicate prediction returned no downloadable outputs.');
  }
  return urls.map((url) => ({
    sourceUrl: url,
    name: input.title,
    width: input.outputSpec?.width,
    height: input.outputSpec?.height,
    durationSeconds: input.outputSpec?.durationSeconds,
    metadata: {
      adapter: provider.adapter,
      model: provider.model,
      predictionId: completed.id
    }
  }));
}

function applyComfyWorkflowTemplate(workflowJson: string, input: AssetGenerationRequest): Record<string, unknown> {
  const templated = workflowJson
    .replaceAll('{{prompt}}', input.prompt.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))
    .replaceAll('{{negativePrompt}}', (input.negativePrompt ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"'))
    .replaceAll('{{width}}', String(input.outputSpec?.width ?? 1024))
    .replaceAll('{{height}}', String(input.outputSpec?.height ?? 1024))
    .replaceAll('{{seed}}', String(Math.floor(Math.random() * 2_147_483_647)));
  const parsed = parseMaybeJson(templated);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ComfyUI workflow JSON is invalid.');
  }
  return parsed as Record<string, unknown>;
}

function extractComfyImages(history: Record<string, unknown>, promptId: string): Array<{ filename: string; subfolder?: string; type?: string }> {
  const entry = (history[promptId] ?? history) as Record<string, unknown>;
  const outputs = entry.outputs as Record<string, unknown> | undefined;
  const images: Array<{ filename: string; subfolder?: string; type?: string }> = [];
  for (const output of Object.values(outputs ?? {})) {
    const rawImages = (output as Record<string, unknown>).images;
    if (!Array.isArray(rawImages)) {
      continue;
    }
    for (const image of rawImages) {
      const item = image as Record<string, unknown>;
      if (typeof item.filename === 'string') {
        images.push({
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : undefined,
          type: typeof item.type === 'string' ? item.type : undefined
        });
      }
    }
  }
  return images;
}

function buildComfyWebSocketUrl(baseUrl: string, clientId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  url.search = '';
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

function comfyProgressFromMessage(value: unknown): AssetGenerationProviderProgress | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const message = parseMaybeJson(value);
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  const remoteJobId = typeof data.prompt_id === 'string' ? data.prompt_id : undefined;
  if (type === 'progress') {
    const value = typeof data.value === 'number' ? data.value : 0;
    const max = typeof data.max === 'number' && data.max > 0 ? data.max : 1;
    return {
      fraction: clampProgress(value / max),
      remoteJobId
    };
  }
  if (type === 'execution_start') {
    return {
      fraction: 0.05,
      remoteJobId
    };
  }
  if (type === 'execution_success') {
    return {
      fraction: 1,
      remoteJobId
    };
  }
  return undefined;
}

function openComfyProgressSocket(
  baseUrl: string,
  clientId: string,
  context?: AssetGenerationProviderContext
): { waitUntilReady: () => Promise<void>; close: () => void } | undefined {
  if (!context?.onProgress || typeof WebSocket === 'undefined') {
    return undefined;
  }
  let socket: WebSocket;
  let settleReady: (() => void) | undefined;
  const ready = new Promise<void>((resolveReady) => {
    settleReady = resolveReady;
  });
  const timer = setTimeout(() => settleReady?.(), 1500);
  try {
    socket = new WebSocket(buildComfyWebSocketUrl(baseUrl, clientId));
  } catch {
    clearTimeout(timer);
    settleReady?.();
    return undefined;
  }
  socket.addEventListener('open', () => {
    clearTimeout(timer);
    settleReady?.();
  });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    settleReady?.();
  });
  socket.addEventListener('message', (event) => {
    const progress = comfyProgressFromMessage(event.data);
    if (progress) {
      void reportProviderProgress(context, progress.fraction, progress.remoteJobId);
    }
  });
  return {
    waitUntilReady: () => ready,
    close: () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        return;
      }
    }
  };
}

async function generateComfyUiAsset(
  provider: ExecutableAssetGenerationProvider,
  input: AssetGenerationRequest,
  context?: AssetGenerationProviderContext
): Promise<GeneratedAssetPayload[]> {
  if (!provider.baseUrl || !provider.workflowJson) {
    throw new Error('ComfyUI provider requires FUNPLAY_COMFYUI_BASE_URL and workflow JSON.');
  }
  const clientId = randomUUID();
  const progressSocket = openComfyProgressSocket(provider.baseUrl, clientId, context);
  try {
    await progressSocket?.waitUntilReady();
    const queued = await readJsonResponse<{ prompt_id?: string }>(await fetchWithTimeout(`${provider.baseUrl}/prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: applyComfyWorkflowTemplate(provider.workflowJson, input),
        client_id: clientId
      })
    }, initialSubmitTimeoutMs), 'ComfyUI prompt queue');
    const promptId = queued.prompt_id;
    if (!promptId) {
      throw new Error('ComfyUI did not return a prompt_id.');
    }
    await reportProviderProgress(context, 0.04, promptId);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(providerPollIntervalMs(1500));
      const fallbackProgress = Math.min(0.92, 0.08 + attempt * 0.007);
      await reportProviderProgress(context, fallbackProgress, promptId);
      const history = await readJsonResponse<Record<string, unknown>>(await fetchWithTimeout(`${provider.baseUrl}/history/${promptId}`), 'ComfyUI history');
      const images = extractComfyImages(history, promptId);
      if (images.length > 0) {
        await reportProviderProgress(context, 1, promptId);
        return images.slice(0, Math.max(1, input.count ?? 1)).map((image) => {
          const params = new URLSearchParams({
            filename: image.filename,
            type: image.type ?? 'output'
          });
          if (image.subfolder) {
            params.set('subfolder', image.subfolder);
          }
          return {
            sourceUrl: `${provider.baseUrl}/view?${params.toString()}`,
            name: input.title,
            width: input.outputSpec?.width,
            height: input.outputSpec?.height,
            metadata: {
              adapter: provider.adapter,
              promptId
            }
          };
        });
      }
    }
    throw new Error('ComfyUI workflow did not finish before the timeout.');
  } finally {
    progressSocket?.close();
  }
}

async function waitForMeshyTask(provider: ExecutableAssetGenerationProvider, taskId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const task = await readJsonResponse<Record<string, unknown>>(await fetchWithTimeout(`${provider.baseUrl}/text-to-3d/${taskId}`, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`
      }
    }), 'Meshy task status');
    const status = typeof task.status === 'string' ? task.status : '';
    if (status === 'SUCCEEDED') {
      return task;
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      const taskError = task.task_error as Record<string, unknown> | undefined;
      throw new Error(`Meshy task ${status}: ${String(taskError?.message ?? '')}`);
    }
    await sleep(3000);
  }
  throw new Error('Meshy task did not finish before the timeout.');
}

async function generateMeshyModel(provider: ExecutableAssetGenerationProvider, input: AssetGenerationRequest): Promise<GeneratedAssetPayload[]> {
  if (!provider.apiKey) {
    throw new Error('Meshy provider is missing MESHY_API_KEY.');
  }
  const created = await readJsonResponse<{ result?: string }>(await fetchWithTimeout(`${provider.baseUrl ?? 'https://api.meshy.ai/openapi/v2'}/text-to-3d`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      mode: 'preview',
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      ai_model: provider.model,
      target_formats: ['glb']
    })
  }, initialSubmitTimeoutMs), 'Meshy text-to-3d');
  if (!created.result) {
    throw new Error('Meshy did not return a task id.');
  }
  const task = await waitForMeshyTask(provider, created.result);
  const modelUrls = task.model_urls as Record<string, unknown> | undefined;
  const modelUrl = typeof modelUrls?.glb === 'string'
    ? modelUrls.glb
    : collectUrls(modelUrls)[0];
  if (!modelUrl) {
    throw new Error('Meshy completed without a downloadable model URL.');
  }
  return [{
    sourceUrl: modelUrl,
    name: input.title,
    format: modelUrl.includes('.glb') ? 'glb' : undefined,
    mimeType: modelUrl.includes('.glb') ? 'model/gltf-binary' : undefined,
    metadata: {
      adapter: provider.adapter,
      model: provider.model,
      taskId: created.result,
      thumbnailUrl: task.thumbnail_url
    }
  }];
}

async function generateElevenLabsAudio(provider: ExecutableAssetGenerationProvider, input: AssetGenerationRequest): Promise<GeneratedAssetPayload[]> {
  if (!provider.apiKey) {
    throw new Error('ElevenLabs provider is missing ELEVENLABS_API_KEY.');
  }
  const outputFormat = env('FUNPLAY_ELEVENLABS_OUTPUT_FORMAT') ?? 'mp3_44100_128';
  const endpoint = input.kind === 'voice' && provider.voiceId
    ? `${provider.baseUrl}/text-to-speech/${provider.voiceId}?output_format=${encodeURIComponent(outputFormat)}`
    : `${provider.baseUrl}/sound-generation?output_format=${encodeURIComponent(outputFormat)}`;
  const body = input.kind === 'voice' && provider.voiceId
    ? {
        text: input.prompt,
        model_id: env('FUNPLAY_ELEVENLABS_TTS_MODEL') ?? 'eleven_multilingual_v2'
      }
    : {
        text: input.prompt,
        duration_seconds: input.outputSpec?.durationSeconds,
        loop: input.outputSpec?.loop ?? input.kind === 'audio_music',
        model_id: provider.model ?? 'eleven_text_to_sound_v2'
      };
  const response = await assertOkResponse(await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': provider.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }), 'ElevenLabs audio generation');
  const mimeType = response.headers.get('content-type') ?? 'audio/mpeg';
  return [{
    body: Buffer.from(await response.arrayBuffer()),
    name: input.title,
    mimeType,
    format: extensionForMimeType(mimeType, 'mp3'),
    durationSeconds: input.outputSpec?.durationSeconds,
    metadata: {
      adapter: provider.adapter,
      model: input.kind === 'voice' ? body.model_id : provider.model,
      characterCost: response.headers.get('character-cost') ?? undefined
    }
  }];
}

function mcpToolCandidates(kind: AssetGenerationKind): string[] {
  const byKind: Partial<Record<AssetGenerationKind, string[]>> = {
    image_2d: ['generate_image', 'generate_2d_image', 'create_image'],
    ui_2d: ['generate_ui', 'generate_ui_asset', 'generate_image'],
    texture_2d: ['generate_texture', 'generate_image'],
    animation_2d_frames: ['generate_sprite_sheet', 'generate_animation_frames', 'generate_asset'],
    animation_2d_rig: ['generate_2d_rig', 'generate_asset'],
    model_3d: ['generate_3d_model', 'generate_model', 'text_to_3d', 'generate_asset'],
    animation_3d: ['generate_3d_animation', 'generate_animation', 'generate_asset'],
    audio_sfx: ['generate_sound_effect', 'generate_sfx', 'generate_audio', 'generate_asset'],
    audio_music: ['generate_music', 'generate_audio', 'generate_asset'],
    voice: ['generate_voice', 'text_to_speech', 'generate_audio', 'generate_asset']
  };
  return ['generate_asset', ...(byKind[kind] ?? [])];
}

function payloadsFromMcpValue(project: Project, input: AssetGenerationRequest, value: unknown): GeneratedAssetPayload[] {
  if (!value) {
    return [];
  }
  if (typeof value === 'string') {
    if (isUrl(value)) {
      return [{ sourceUrl: value, name: input.title }];
    }
    const parsed = parseMaybeJson(value);
    if (parsed) {
      return payloadsFromMcpValue(project, input, parsed);
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => payloadsFromMcpValue(project, input, item));
  }
  if (typeof value !== 'object') {
    return [];
  }
  const item = value as Record<string, unknown>;
  const outputs = item.outputs ?? item.assets ?? item.files ?? item.result;
  if (outputs && outputs !== value) {
    const nested = payloadsFromMcpValue(project, input, outputs);
    if (nested.length > 0) {
      return nested;
    }
  }
  const mimeType = typeof item.mimeType === 'string'
    ? item.mimeType
    : typeof item.mime_type === 'string'
      ? item.mime_type
      : undefined;
  const format = typeof item.format === 'string' ? item.format : undefined;
  const name = typeof item.name === 'string' ? item.name : input.title;
  const url = typeof item.url === 'string' && isUrl(item.url)
    ? item.url
    : typeof item.downloadUrl === 'string' && isUrl(item.downloadUrl)
      ? item.downloadUrl
      : undefined;
  if (url) {
    return [{ sourceUrl: url, name, mimeType, format, metadata: { adapter: 'mcp' } }];
  }
  const base64 = typeof item.base64 === 'string'
    ? item.base64
    : typeof item.data === 'string'
      ? item.data
      : undefined;
  if (base64) {
    return [{ body: Buffer.from(base64, 'base64'), name, mimeType, format, metadata: { adapter: 'mcp' } }];
  }
  const path = typeof item.path === 'string'
    ? item.path
    : typeof item.filePath === 'string'
      ? item.filePath
      : undefined;
  if (path) {
    return [{ existingPath: path, name, mimeType, format, metadata: { adapter: 'mcp' } }];
  }
  return [];
}

async function generateMcpAsset(state: AppState, provider: ExecutableAssetGenerationProvider, project: Project, input: AssetGenerationRequest): Promise<GeneratedAssetPayload[]> {
  const pluginId = provider.id.replace(/^mcp:/, '');
  const plugin = state.mcpPlugins.find((item) => item.id === pluginId);
  if (!plugin) {
    throw new Error('MCP asset provider not found.');
  }
  const tools = await listUnityTools(plugin);
  const candidates = mcpToolCandidates(input.kind);
  const tool = tools.find((entry) => candidates.includes(entry.name)) ??
    tools.find((entry) => /asset|image|texture|model|audio|sound|music|voice/i.test(entry.name));
  if (!tool) {
    throw new Error(`MCP asset server "${plugin.name}" does not expose a recognizable generation tool.`);
  }
  const result = await callUnityTool(plugin, tool.name, {
    title: input.title,
    kind: input.kind,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    outputSpec: input.outputSpec ?? {},
    count: input.count ?? 1,
    targetEngine: input.targetEngine ?? project.engine?.platform,
    projectPath: resolveProjectRootPathForProject(project)
  });
  const imagePayloads = result.content
    .filter((part) => part.type === 'image' && part.data)
    .map((part): GeneratedAssetPayload => ({
      body: Buffer.from(part.data!, 'base64'),
      name: input.title,
      mimeType: part.mimeType ?? 'image/png',
      format: extensionForMimeType(part.mimeType, 'png'),
      metadata: { adapter: 'mcp', toolName: tool.name }
    }));
  const textPayloads = result.content
    .filter((part) => part.type === 'text' && part.text)
    .flatMap((part) => payloadsFromMcpValue(project, input, part.text));
  const rawPayloads = payloadsFromMcpValue(project, input, result.raw);
  const payloads = [...imagePayloads, ...textPayloads, ...rawPayloads];
  if (payloads.length === 0) {
    throw new Error(`MCP asset tool "${tool.name}" did not return a file, URL, path, or image content.`);
  }
  return payloads.slice(0, Math.max(1, input.count ?? 1));
}

async function generateProviderPayloads(
  state: AppState,
  project: Project,
  provider: ExecutableAssetGenerationProvider,
  input: AssetGenerationRequest,
  context?: AssetGenerationProviderContext
): Promise<GeneratedAssetPayload[]> {
  if (!provider.enabled) {
    throw new Error(`Asset provider "${provider.name}" is not enabled. ${provider.notes ?? ''}`.trim());
  }
  if (!provider.supportedKinds.includes(input.kind)) {
    throw new Error(`Asset provider "${provider.name}" does not support ${input.kind}.`);
  }
  if (provider.adapter === 'openai-image') return generateOpenAiImage(provider, input);
  if (provider.adapter === 'stability') return generateStabilityImage(provider, input);
  if (provider.adapter === 'replicate') return generateReplicateAsset(provider, input, context);
  if (provider.adapter === 'comfyui') return generateComfyUiAsset(provider, input, context);
  if (provider.adapter === 'meshy') return generateMeshyModel(provider, input);
  if (provider.adapter === 'elevenlabs') return generateElevenLabsAudio(provider, input);
  if (provider.adapter === 'mcp') return generateMcpAsset(state, provider, project, input);
  throw new Error(`Provider adapter "${provider.adapter}" is registered but not executable yet.`);
}

export async function generateAssetForProject(
  state: AppState,
  projectId: string,
  request: AssetGenerationRequest,
  options: AssetGenerationRunOptions = {}
): Promise<Project> {
  const projectIndex = state.projects.findIndex((project) => project.id === projectId);
  if (projectIndex < 0) {
    throw new Error('Project not found.');
  }
  const project = state.projects[projectIndex];
  const providers = buildExecutableAssetGenerationProviders(state);
  const provider = request.providerId
    ? providers.find((candidate) => candidate.id === request.providerId)
    : providers.find((candidate) => candidate.enabled && candidate.supportedKinds.includes(request.kind));
  if (!provider) {
    throw new Error(
      '没有就绪的素材生成 Provider。请在「素材 Provider」中确认 API Key、模型、地址等必填项已填写并启用。/ No ready asset generation provider is available. In "Asset Providers", confirm the API key, model, and endpoint are filled in and the provider is enabled.'
    );
  }
  if (!provider.enabled) {
    throw new Error(
      `素材 Provider「${provider.name}」未就绪或未启用。${provider.notes ?? ''} 请在「素材 Provider」中检查必填项并启用。/ Asset provider "${provider.name}" is not ready or not enabled. ${provider.notes ?? ''} Check its required fields in "Asset Providers" and enable it.`.trim()
    );
  }

  const timestamp = nowIso();
  const jobId = `asset_job_${randomUUID()}`;
  const normalizedRequest: AssetGenerationRequest = {
    ...request,
    title: request.title.trim() || labelForKind(request.kind),
    prompt: request.prompt.trim(),
    providerId: provider.id,
    providerAdapter: provider.adapter,
    count: Math.max(1, Math.min(Math.floor(request.count ?? 1), 4)),
    targetEngine: request.targetEngine ?? project.engine?.platform
  };
  const dimensionValidation = validateAssetGenerationRequestImageDimensions(normalizedRequest);
  if (dimensionValidation && !dimensionValidation.ok) {
    throw new Error(formatAssetGenerationImageDimensionValidation(dimensionValidation));
  }
  const providerDimensionError = checkProviderImageDimensionLimit(provider, normalizedRequest);
  if (providerDimensionError) {
    throw new Error(providerDimensionError);
  }
  const baseJob: AssetGenerationJob = {
    id: jobId,
    projectId,
    title: normalizedRequest.title,
    kind: normalizedRequest.kind,
    prompt: normalizedRequest.prompt,
    negativePrompt: normalizedRequest.negativePrompt?.trim() || undefined,
    providerId: provider.id,
    providerName: provider.name,
    providerAdapter: provider.adapter,
    stylePresetId: normalizedRequest.stylePresetId,
    references: normalizedRequest.references ?? [],
    targetEngine: normalizedRequest.targetEngine,
    outputSpec: normalizedRequest.outputSpec ?? {},
    status: 'queued',
    progress: 0.05,
    createdBy: normalizedRequest.createdBy ?? 'user',
    outputs: [],
    costEstimate: provider.requiresNetwork ? 'provider billing applies' : 'configured provider',
    createdAt: timestamp,
    updatedAt: timestamp
  };

  const latestProject = (): Project => {
    const latest = state.projects.find((candidate) => candidate.id === projectId);
    if (!latest) {
      throw new Error('Project not found.');
    }
    return latest;
  };

  const upsertJob = (jobs: AssetGenerationJob[] | undefined, job: AssetGenerationJob): AssetGenerationJob[] => {
    const current = jobs ?? [];
    return current.some((candidate) => candidate.id === job.id)
      ? current.map((candidate) => (candidate.id === job.id ? job : candidate))
      : [...current, job];
  };

  const replaceProject = async (updated: Project): Promise<Project> => {
    const index = state.projects.findIndex((candidate) => candidate.id === updated.id);
    if (index < 0) {
      throw new Error('Project not found.');
    }
    state.projects[index] = updated;
    await options.onProjectUpdate?.(updated);
    return updated;
  };

  const publishJob = async (job: AssetGenerationJob): Promise<Project> => {
    const latest = latestProject();
    return replaceProject({
      ...latest,
      assetGenerationJobs: upsertJob(latest.assetGenerationJobs, job),
      updatedAt: job.updatedAt
    });
  };

  const currentJob = (): AssetGenerationJob | undefined =>
    latestProject().assetGenerationJobs?.find((candidate) => candidate.id === jobId);
  const isCancelled = (): boolean => currentJob()?.status === 'cancelled';
  const publishProviderProgress = async (progress: AssetGenerationProviderProgress): Promise<void> => {
    if (isCancelled()) {
      return;
    }
    const previous = currentJob() ?? baseJob;
    const providerProgress = 0.22 + clampProgress(progress.fraction) * 0.58;
    await publishJob({
      ...previous,
      status: 'running',
      progress: Math.max(previous.progress, Math.min(0.8, providerProgress)),
      remoteJobId: progress.remoteJobId ?? previous.remoteJobId,
      updatedAt: nowIso()
    });
  };

  await publishJob(baseJob);

  try {
    const providerStartedAt = nowIso();
    // Emit an explicit "waiting for provider" state before the first provider call,
    // so the bar visibly advances instead of sitting flat while we wait on a network
    // round-trip that can take a while (or hang if the provider is unreachable).
    await publishJob({
      ...baseJob,
      status: 'running',
      progress: 0.15,
      costEstimate: '等待 Provider 响应… / Waiting for provider…',
      updatedAt: providerStartedAt
    });

    const payloads = await generateProviderPayloads(state, latestProject(), provider, normalizedRequest, {
      onProgress: publishProviderProgress
    });
    if (isCancelled()) {
      return latestProject();
    }

    const outputs: AssetGenerationOutput[] = [];
    const previousWritingJob = currentJob() ?? baseJob;
    await publishJob({
      ...previousWritingJob,
      status: 'running',
      progress: 0.82,
      outputs,
      updatedAt: nowIso()
    });

    for (const [index, payload] of payloads.entries()) {
      if (isCancelled()) {
        return latestProject();
      }
      outputs.push(await writeGeneratedPayload(latestProject(), normalizedRequest, payload, index + 1));
      const previousOutputJob = currentJob() ?? baseJob;
      await publishJob({
        ...previousOutputJob,
        status: 'running',
        progress: Math.min(0.96, 0.82 + (outputs.length / Math.max(payloads.length, 1)) * 0.14),
        outputs: [...outputs],
        updatedAt: nowIso()
      });
    }

    if (isCancelled()) {
      return latestProject();
    }

    const completedAt = nowIso();
    const previousCompletedJob = currentJob();
    const completedJob: AssetGenerationJob = {
      ...baseJob,
      status: 'completed',
      progress: 1,
      remoteJobId: previousCompletedJob?.remoteJobId,
      outputs,
      updatedAt: completedAt,
      completedAt
    };
    const latest = latestProject();
    const assetItem: Project['assets'][number] = {
      id: `asset_${randomUUID()}`,
      name: normalizedRequest.title,
      type: assetTypeForKind(normalizedRequest.kind),
      status: 'ready',
      prompt: normalizedRequest.prompt,
      notes: `${labelForKind(normalizedRequest.kind)} · ${provider.name}`,
      generationJobId: jobId,
      outputPaths: outputs.map((output) => output.path)
    };
    const updated: Project = {
      ...latest,
      assets: [assetItem, ...latest.assets.filter((asset) => asset.generationJobId !== jobId)],
      assetGenerationJobs: upsertJob(latest.assetGenerationJobs, completedJob),
      updatedAt: completedAt
    };
    return replaceProject(updated);
  } catch (error) {
    if (isCancelled()) {
      return latestProject();
    }
    const failedAt = nowIso();
    const previousFailedJob = currentJob();
    const failedJob: AssetGenerationJob = {
      ...baseJob,
      status: 'failed',
      progress: 1,
      remoteJobId: previousFailedJob?.remoteJobId,
      error: error instanceof Error ? error.message : 'Asset generation failed.',
      updatedAt: failedAt,
      completedAt: failedAt
    };
    return publishJob(failedJob);
  }
}

export function importGeneratedAsset(state: AppState, projectId: string, jobId: string): Project {
  const projectIndex = state.projects.findIndex((project) => project.id === projectId);
  if (projectIndex < 0) {
    throw new Error('Project not found.');
  }
  const project = state.projects[projectIndex];
  const timestamp = nowIso();
  const jobs = (project.assetGenerationJobs ?? []).map((job) => {
    if (job.id !== jobId) {
      return job;
    }
    return {
      ...job,
      outputs: job.outputs.map((output) => ({
        ...output,
        importedAt: output.importedAt ?? timestamp
      })),
      updatedAt: timestamp
    };
  });
  const updated = {
    ...project,
    assetGenerationJobs: jobs,
    updatedAt: timestamp
  };
  state.projects[projectIndex] = updated;
  return updated;
}

export function cancelAssetGenerationJob(state: AppState, projectId: string, jobId: string): Project {
  const projectIndex = state.projects.findIndex((project) => project.id === projectId);
  if (projectIndex < 0) {
    throw new Error('Project not found.');
  }
  const project = state.projects[projectIndex];
  const target = (project.assetGenerationJobs ?? []).find((job) => job.id === jobId);
  if (!target) {
    throw new Error('Asset generation job not found.');
  }
  if (target.status === 'completed' || target.status === 'failed' || target.status === 'cancelled') {
    return project;
  }
  const timestamp = nowIso();
  const updated: Project = {
    ...project,
    assetGenerationJobs: (project.assetGenerationJobs ?? []).map((job) =>
      job.id === jobId
        ? {
            ...job,
            status: 'cancelled',
            progress: 1,
            updatedAt: timestamp,
            completedAt: timestamp
          }
        : job
    ),
    updatedAt: timestamp
  };
  state.projects[projectIndex] = updated;
  return updated;
}
