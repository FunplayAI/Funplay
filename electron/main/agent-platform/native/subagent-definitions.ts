import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AiProvider, AiProviderModel } from '../../../../shared/types';
import type { NativeToolPoolMode } from './tool-pool';

export type NativeSubagentMode = 'investigator' | 'worker';
export type NativeSubagentToolFamily = 'read' | 'write' | 'command' | 'web' | 'mcp';

export interface NativeSubagentDefinition {
  /** Definition name from frontmatter, falling back to the file basename. */
  name: string;
  description?: string;
  /** Tool families the definition allows; empty means "use the mode default". */
  tools: NativeSubagentToolFamily[];
  /** Optional model id resolved against the parent provider's model list. */
  model?: string;
  /** Markdown body: appended to the subagent system prompt. */
  systemPrompt: string;
  sourcePath: string;
  source: 'claude' | 'funplay';
}

export interface NativeSubagentModelResolution {
  model: string;
  upstreamModel?: string;
  source: 'parent' | 'requested' | 'fallback';
  requestedModel?: string;
  /** zh note recorded in the subagent transcript when the requested model fell back. */
  fallbackNote?: string;
}

const NATIVE_SUBAGENT_DEFINITION_DIRS: ReadonlyArray<{
  source: NativeSubagentDefinition['source'];
  segments: [string, string];
}> = [
  { source: 'claude', segments: ['.claude', 'agents'] },
  { source: 'funplay', segments: ['.funplay', 'agents'] }
];
const NATIVE_SUBAGENT_DEFINITION_CACHE_LIMIT = 16;
const NATIVE_SUBAGENT_DEFINITION_MAX_FILES_PER_DIR = 64;
const NATIVE_SUBAGENT_DEFINITION_MAX_BYTES = 64_000;
const NATIVE_SUBAGENT_TOOL_FAMILIES = new Set<NativeSubagentToolFamily>(['read', 'write', 'command', 'web', 'mcp']);
// Subagents must never start nested subagents or talk to the user directly.
const NATIVE_SUBAGENT_BASE_EXCLUDED_TOOLS: NativeToolPoolMode['excludeTools'] = [
  'ask_user',
  'run_subagent',
  'run_subagents',
  'subagent_start',
  'subagent_status'
];

interface NativeSubagentDefinitionCacheEntry {
  signature: string;
  definitions: NativeSubagentDefinition[];
}

const definitionCacheByRoot = new Map<string, NativeSubagentDefinitionCacheEntry>();

// Minimal frontmatter parsing, mirroring the pattern used by skill-registry.ts.
function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  if (!content.startsWith('---')) {
    return {
      frontmatter: '',
      body: content
    };
  }
  const closingIndex = content.indexOf('\n---', 3);
  if (closingIndex < 0) {
    return {
      frontmatter: '',
      body: content
    };
  }
  return {
    frontmatter: content.slice(3, closingIndex).trim(),
    body: content.slice(closingIndex + 4).replace(/^\s*\n/, '')
  };
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseScalar(value: string): string | string[] {
  const trimmed = cleanScalar(value);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(cleanScalar).filter(Boolean);
  }
  return trimmed;
}

function parseFrontmatter(value: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  let currentListKey = '';

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/g, '');
    const listMatch = line.match(/^\s*-\s*(.+)$/);
    if (listMatch && currentListKey) {
      const existing = result[currentListKey];
      const list = Array.isArray(existing) ? existing : [];
      result[currentListKey] = [...list, cleanScalar(listMatch[1])];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1];
    const scalar = keyMatch[2] ?? '';
    if (scalar.trim()) {
      result[key] = parseScalar(scalar);
      currentListKey = '';
      continue;
    }

    result[key] = [];
    currentListKey = key;
  }

  return result;
}

function getFrontmatterString(frontmatter: Record<string, string | string[]>, key: string): string | undefined {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getFrontmatterList(frontmatter: Record<string, string | string[]>, key: string): string[] {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\s*,\s*/)
      .map(cleanScalar)
      .filter(Boolean);
  }
  return [];
}

function normalizeSubagentName(value: string): string {
  return value.trim().toLowerCase();
}

export function parseSubagentDefinitionContent(input: {
  content: string;
  sourcePath: string;
  source: NativeSubagentDefinition['source'];
}): NativeSubagentDefinition | undefined {
  const parsed = splitFrontmatter(input.content);
  const frontmatter = parseFrontmatter(parsed.frontmatter);
  const fallbackName = basename(input.sourcePath).replace(/\.md$/i, '');
  const name = getFrontmatterString(frontmatter, 'name') ?? fallbackName;
  if (!name.trim()) {
    return undefined;
  }
  const tools = getFrontmatterList(frontmatter, 'tools')
    .map((family) => family.trim().toLowerCase())
    .filter((family): family is NativeSubagentToolFamily =>
      NATIVE_SUBAGENT_TOOL_FAMILIES.has(family as NativeSubagentToolFamily)
    );
  return {
    name: name.trim(),
    description: getFrontmatterString(frontmatter, 'description'),
    tools: [...new Set(tools)],
    model: getFrontmatterString(frontmatter, 'model'),
    systemPrompt: parsed.body.trim(),
    sourcePath: input.sourcePath,
    source: input.source
  };
}

function safeListDefinitionFiles(directory: string): Array<{ path: string; mtimeMs: number; size: number }> {
  try {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      return [];
    }
    return readdirSync(directory)
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .sort()
      .slice(0, NATIVE_SUBAGENT_DEFINITION_MAX_FILES_PER_DIR)
      .map((entry) => {
        const path = join(directory, entry);
        const stat = statSync(path);
        return stat.isFile() ? { path, mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
      })
      .filter((entry): entry is { path: string; mtimeMs: number; size: number } => Boolean(entry));
  } catch {
    return [];
  }
}

function rememberDefinitionCache(rootKey: string, entry: NativeSubagentDefinitionCacheEntry): void {
  if (!definitionCacheByRoot.has(rootKey) && definitionCacheByRoot.size >= NATIVE_SUBAGENT_DEFINITION_CACHE_LIMIT) {
    const oldest = definitionCacheByRoot.keys().next().value;
    if (oldest !== undefined) {
      definitionCacheByRoot.delete(oldest);
    }
  }
  definitionCacheByRoot.set(rootKey, entry);
}

export function resetSubagentDefinitionCache(): void {
  definitionCacheByRoot.clear();
}

/**
 * Loads subagent definitions from <projectRoot>/.claude/agents/*.md and
 * <projectRoot>/.funplay/agents/*.md. Results are cached per project root and
 * invalidated when any definition file's mtime/size (or the file set) changes.
 * On name conflicts the .funplay definition wins (read last).
 */
export function listSubagentDefinitions(projectRoot: string | undefined): NativeSubagentDefinition[] {
  if (!projectRoot?.trim()) {
    return [];
  }
  const rootKey = resolve(projectRoot);
  const sources = NATIVE_SUBAGENT_DEFINITION_DIRS.map((dir) => ({
    source: dir.source,
    files: safeListDefinitionFiles(join(rootKey, ...dir.segments))
  }));
  const signature = JSON.stringify(
    sources.map((entry) => entry.files.map((file) => `${file.path}:${file.mtimeMs}:${file.size}`))
  );
  const cached = definitionCacheByRoot.get(rootKey);
  if (cached && cached.signature === signature) {
    return cached.definitions;
  }

  const byName = new Map<string, NativeSubagentDefinition>();
  for (const entry of sources) {
    for (const file of entry.files) {
      if (file.size > NATIVE_SUBAGENT_DEFINITION_MAX_BYTES) {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(file.path, 'utf8');
      } catch {
        continue;
      }
      const definition = parseSubagentDefinitionContent({
        content,
        sourcePath: file.path,
        source: entry.source
      });
      if (definition) {
        byName.set(normalizeSubagentName(definition.name), definition);
      }
    }
  }
  const definitions = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  rememberDefinitionCache(rootKey, { signature, definitions });
  return definitions;
}

export function findSubagentDefinition(
  projectRoot: string | undefined,
  name: string | undefined
): NativeSubagentDefinition | undefined {
  if (!name?.trim()) {
    return undefined;
  }
  const normalized = normalizeSubagentName(name);
  return listSubagentDefinitions(projectRoot).find(
    (definition) => normalizeSubagentName(definition.name) === normalized
  );
}

/**
 * Resolves a requested subagent model against the parent provider's model list
 * (populated by provider-model-service fetches / catalog presets). Unknown
 * models fall back to the parent model with a transcript note.
 */
export function resolveNativeSubagentModel(
  provider: Pick<AiProvider, 'model' | 'upstreamModel' | 'availableModels'>,
  requestedModel: string | undefined
): NativeSubagentModelResolution {
  const requested = requestedModel?.trim();
  if (!requested) {
    return {
      model: provider.model,
      upstreamModel: provider.upstreamModel,
      source: 'parent'
    };
  }
  if (requested === provider.model) {
    return {
      model: provider.model,
      upstreamModel: provider.upstreamModel,
      source: 'requested',
      requestedModel: requested
    };
  }
  const models: AiProviderModel[] = provider.availableModels ?? [];
  const matched =
    models.find((entry) => entry.modelId === requested) ??
    models.find((entry) => entry.upstreamModelId === requested) ??
    models.find((entry) => entry.modelId.toLowerCase() === requested.toLowerCase());
  if (matched) {
    return {
      model: matched.modelId,
      upstreamModel: matched.upstreamModelId,
      source: 'requested',
      requestedModel: requested
    };
  }
  return {
    model: provider.model,
    upstreamModel: provider.upstreamModel,
    source: 'fallback',
    requestedModel: requested,
    fallbackNote: `请求的子任务模型 "${requested}" 不在当前 Provider 的模型列表中，已回退到父模型 "${provider.model}"。`
  };
}

/**
 * Maps a subagent mode + definition tool families to the native tool pool mode.
 * Investigator stays read-only regardless of the definition; worker enables the
 * write/command/mcp buckets per the definition's families (all but mcp when no
 * definition restricts them). The web family removes web tools when omitted.
 */
export function resolveNativeSubagentToolPoolMode(input: {
  mode: NativeSubagentMode;
  definition?: NativeSubagentDefinition;
}): NativeToolPoolMode {
  const families = input.definition?.tools ?? [];
  const restricted = families.length > 0;
  const allows = (family: NativeSubagentToolFamily, fallback: boolean): boolean =>
    restricted ? families.includes(family) : fallback;
  const excludeTools: NativeToolPoolMode['excludeTools'] = [...(NATIVE_SUBAGENT_BASE_EXCLUDED_TOOLS ?? [])];
  if (restricted && !families.includes('web')) {
    excludeTools.push('web_search', 'web_fetch');
  }

  if (input.mode !== 'worker') {
    // Investigator: read-only, matching the pre-worker subagent behavior.
    return {
      includeWriteTools: false,
      includeMcpToolCalls: false,
      includeCommandTools: false,
      excludeTools
    };
  }

  // A worker rolling back the shared run checkpoint would clobber parent-loop writes.
  excludeTools.push('checkpoint_rollback');
  return {
    includeWriteTools: allows('write', true),
    includeMcpToolCalls: allows('mcp', false),
    includeCommandTools: allows('command', true),
    excludeTools
  };
}
