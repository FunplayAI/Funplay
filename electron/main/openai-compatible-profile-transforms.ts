import type { AiProvider, AiProviderApiMode, OpenAiCompatibleSchemaTransform } from '../../shared/types';
import { resolveOpenAiCompatibleProviderProfile } from '../../shared/provider-catalog';
import type {
  OpenAiCompatibleRequest,
  OpenAiCompatibleToolCall,
  OpenAiCompatibleToolDefinition,
  OpenAiCompatibleToolStepRequest
} from './openai-compatible-types';
import { isRecord } from './openai-compatible-transport';
import { makeId } from '../../shared/utils';

type TransformContext = {
  provider: Pick<AiProvider, 'name' | 'protocol' | 'baseUrl' | 'apiMode'>;
  model: string;
  apiMode: AiProviderApiMode;
};

type OpenAiCompatibleUpstreamFamily =
  | 'deepseek'
  | 'gemini'
  | 'moonshot'
  | 'qwen'
  | 'zhipu'
  | 'mimo'
  | 'unknown';

function getProviderModelMarker(context: {
  provider: Pick<AiProvider, 'name' | 'baseUrl'>;
  model: string;
}): string {
  return `${context.provider.name} ${context.provider.baseUrl} ${context.model}`.toLowerCase();
}

function inferUpstreamFamily(context: TransformContext): OpenAiCompatibleUpstreamFamily {
  const marker = getProviderModelMarker(context);
  if (marker.includes('deepseek')) {
    return 'deepseek';
  }
  if (marker.includes('gemini') || marker.includes('google/')) {
    return 'gemini';
  }
  if (marker.includes('moonshot') || marker.includes('kimi')) {
    return 'moonshot';
  }
  if (marker.includes('qwen') || marker.includes('qwq') || marker.includes('dashscope')) {
    return 'qwen';
  }
  if (marker.includes('zhipu') || marker.includes('bigmodel') || marker.includes('glm-') || marker.includes('/glm')) {
    return 'zhipu';
  }
  if (marker.includes('mimo')) {
    return 'mimo';
  }
  return 'unknown';
}

function familyUsesReasoningContent(family: OpenAiCompatibleUpstreamFamily): boolean {
  return family === 'deepseek' || family === 'moonshot' || family === 'qwen' || family === 'zhipu' || family === 'mimo';
}

function normalizeSchemaMap(schemas: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schemas).map(([key, value]) => [key, normalizeBaseSchema(value)]));
}

function normalizeBaseSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = { ...schema };
  const objectLike = normalized.type === 'object' || isRecord(normalized.properties);
  if (objectLike) {
    normalized.properties = isRecord(normalized.properties) ? normalizeSchemaMap(normalized.properties) : {};
    normalized.required = Array.isArray(normalized.required) ? normalized.required : [];
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(normalized[key])) {
      normalized[key] = normalized[key].map(normalizeBaseSchema);
    }
  }

  if (isRecord(normalized.items)) {
    normalized.items = normalizeBaseSchema(normalized.items);
  } else if (Array.isArray(normalized.items)) {
    normalized.items = normalized.items.map(normalizeBaseSchema);
  }

  for (const key of ['$defs', 'definitions']) {
    if (isRecord(normalized[key])) {
      normalized[key] = normalizeSchemaMap(normalized[key]);
    }
  }

  return normalized;
}

function sanitizeMoonshotSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return Array.isArray(schema) ? schema.map(sanitizeMoonshotSchema) : schema;
  }
  if (typeof schema.$ref === 'string') {
    return { $ref: schema.$ref };
  }
  const sanitized = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, sanitizeMoonshotSchema(value)])
  );
  if (Array.isArray(sanitized.items)) {
    sanitized.items = sanitized.items[0] ?? {};
  }
  return sanitized;
}

function hasCombiner(schema: unknown): boolean {
  return isRecord(schema) && (
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.allOf)
  );
}

function hasSchemaIntent(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if (hasCombiner(schema)) {
    return true;
  }
  return [
    'type',
    'properties',
    'items',
    'prefixItems',
    'enum',
    'const',
    '$ref',
    'additionalProperties',
    'patternProperties',
    'required',
    'not',
    'if',
    'then',
    'else'
  ].some((key) => key in schema);
}

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return Array.isArray(schema) ? schema.map(sanitizeGeminiSchema) : schema;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = sanitizeGeminiSchema(value);
  }

  if (Array.isArray(result.enum)) {
    result.enum = result.enum.map((value) => String(value));
    if (result.type === 'integer' || result.type === 'number') {
      result.type = 'string';
    }
  }

  const properties = isRecord(result.properties) ? result.properties : undefined;
  if (result.type === 'object' && properties && Array.isArray(result.required)) {
    result.required = result.required.filter((field) => typeof field === 'string' && field in properties);
  }

  if (result.type === 'array' && !hasCombiner(result)) {
    if (result.items == null) {
      result.items = {};
    }
    if (isRecord(result.items) && !hasSchemaIntent(result.items)) {
      result.items = {
        ...result.items,
        type: 'string'
      };
    }
  }

  if (typeof result.type === 'string' && result.type !== 'object' && !hasCombiner(result)) {
    delete result.properties;
    delete result.required;
  }

  return result;
}

function inferSchemaTransform(context: TransformContext): OpenAiCompatibleSchemaTransform {
  const profile = resolveOpenAiCompatibleProviderProfile(context.provider);
  if (profile.schemaTransform !== 'default') {
    return profile.schemaTransform;
  }
  switch (inferUpstreamFamily(context)) {
    case 'moonshot':
      return 'moonshot';
    case 'gemini':
      return 'gemini';
    case 'deepseek':
    case 'qwen':
    case 'zhipu':
    case 'mimo':
    case 'unknown':
      return 'default';
  }
}

function shouldOmitEmptyParameters(schema: Record<string, unknown>, context: TransformContext): boolean {
  if (inferUpstreamFamily(context) === 'mimo') {
    return false;
  }
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  return schema.type === 'object' && properties !== undefined && Object.keys(properties).length === 0;
}

function shouldEnableDashScopeThinking(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.includes('qwen3') ||
    normalized.includes('qwq') ||
    normalized.includes('deepseek-r1') ||
    normalized.includes('deepseek-reasoner') ||
    normalized.includes('kimi-k2.5') ||
    normalized.includes('kimi-k2p') ||
    normalized.includes('thinking')
  );
}

export function normalizeOpenAiCompatibleToolParameters(
  parameters: Record<string, unknown> | undefined,
  context: TransformContext
): Record<string, unknown> | undefined {
  if (!parameters) {
    return undefined;
  }

  const base = normalizeBaseSchema(parameters);
  const transformed = (() => {
    switch (inferSchemaTransform(context)) {
      case 'moonshot':
        return sanitizeMoonshotSchema(base);
      case 'gemini':
        return sanitizeGeminiSchema(base);
      case 'default':
        return base;
    }
  })();

  if (!isRecord(transformed)) {
    return undefined;
  }
  if (shouldOmitEmptyParameters(transformed, context)) {
    return undefined;
  }
  return transformed;
}

export function applyOpenAiCompatibleRequestBodyTransforms(
  body: unknown,
  request: OpenAiCompatibleRequest | OpenAiCompatibleToolStepRequest,
  apiMode: AiProviderApiMode
): unknown {
  if (!isRecord(body)) {
    return body;
  }

  const profile = resolveOpenAiCompatibleProviderProfile({
    name: request.provider.name,
    protocol: request.provider.protocol,
    baseUrl: request.provider.baseUrl,
    apiMode: request.provider.apiMode
  });
  const next: Record<string, unknown> = { ...body };
  if (apiMode === 'chat' && profile.reasoningRequestStyle === 'dashscope-enable-thinking' && shouldEnableDashScopeThinking(request.model)) {
    next.enable_thinking = true;
  }
  if (apiMode === 'chat' && profile.reasoningRequestStyle === 'zhipu-thinking') {
    next.thinking = {
      type: 'enabled',
      clear_thinking: false
    };
  }
  return next;
}

export function getOpenAiCompatibleAssistantReasoningFields(
  reasoningContent: string | undefined,
  request: OpenAiCompatibleToolStepRequest
): Record<string, unknown> {
  const profile = resolveOpenAiCompatibleProviderProfile({
    name: request.provider.name,
    protocol: request.provider.protocol,
    baseUrl: request.provider.baseUrl,
    apiMode: request.provider.apiMode
  });
  const inferredFamily = inferUpstreamFamily({
    provider: request.provider,
    model: request.model,
    apiMode: 'chat'
  });
  const field = profile.interleavedReasoningField ??
    (profile.reasoningContent || familyUsesReasoningContent(inferredFamily) ? 'reasoning_content' : undefined);
  return field ? { [field]: reasoningContent ?? '' } : {};
}

function normalizeToolNameForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function repairOpenAiCompatibleToolCalls(
  toolCalls: Array<{ name: string }>,
  toolDefinitions: OpenAiCompatibleToolDefinition[]
): void {
  const exactNames = new Set(toolDefinitions.map((tool) => tool.name));
  const lowerNames = new Map(toolDefinitions.map((tool) => [tool.name.toLowerCase(), tool.name]));
  // Normalized index (strip non-alphanumerics) matches hyphen/underscore and
  // separator variants. A null value marks an ambiguous key we must not auto-repair.
  const normalizedNames = new Map<string, string | null>();
  for (const tool of toolDefinitions) {
    const normalized = normalizeToolNameForMatch(tool.name);
    normalizedNames.set(normalized, normalizedNames.has(normalized) ? null : tool.name);
  }
  const resolveName = (candidate: string): string | undefined => {
    if (exactNames.has(candidate)) {
      return candidate;
    }
    const lower = lowerNames.get(candidate.toLowerCase());
    if (lower) {
      return lower;
    }
    return normalizedNames.get(normalizeToolNameForMatch(candidate)) ?? undefined;
  };
  for (const toolCall of toolCalls) {
    if (exactNames.has(toolCall.name)) {
      continue;
    }
    // Try the raw name, then the last segment after a namespace separator
    // (e.g. "functions.write_file" / "tools/write_file" -> "write_file").
    const lastSegment = toolCall.name.split(/[./]/).pop() ?? toolCall.name;
    const repaired = resolveName(toolCall.name) ?? resolveName(lastSegment);
    if (repaired) {
      toolCall.name = repaired;
    }
  }
}

function normalizeRawJsonStringNewlines(value: string): string {
  let normalized = '';
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      normalized += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      normalized += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      normalized += char;
      inString = !inString;
      continue;
    }
    if (inString && char === '\n') {
      normalized += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      continue;
    }
    if (inString && char === '\t') {
      normalized += '\\t';
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function stripJsonCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function stripJsonTrailingCommas(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }
    if (!inString && char === ',') {
      let lookahead = index + 1;
      while (lookahead < value.length && /\s/.test(value[lookahead])) {
        lookahead += 1;
      }
      if (value[lookahead] === '}' || value[lookahead] === ']') {
        continue;
      }
    }
    result += char;
  }
  return result;
}

function replacePythonJsonLiterals(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (escaped) {
      result += char;
      escaped = false;
      index += 1;
      continue;
    }
    if (char === '\\' && inString) {
      result += char;
      escaped = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      result += char;
      inString = !inString;
      index += 1;
      continue;
    }
    if (!inString) {
      const prevChar = index > 0 ? value[index - 1] : '';
      const match = /[A-Za-z0-9_]/.test(prevChar) ? null : /^(None|True|False)\b/.exec(value.slice(index));
      if (match) {
        result += match[1] === 'None' ? 'null' : match[1] === 'True' ? 'true' : 'false';
        index += match[1].length;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return result;
}

export function parseToolCallArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    try {
      const parsed = JSON.parse(normalizeRawJsonStringNewlines(value));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      // Third-level lenient repair for weak models: strip markdown code fences
      // and JSON5-style trailing commas, then retry. Many non-frontier models
      // wrap tool arguments in ```json fences or leave trailing commas, which
      // the two strict passes above reject.
      try {
        const lenient = normalizeRawJsonStringNewlines(replacePythonJsonLiterals(stripJsonTrailingCommas(stripJsonCodeFence(value))));
        const parsed = JSON.parse(lenient);
        return isRecord(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
  }
}

function extractBalancedJsonObject(value: string, startIndex: number): {
  raw: string;
  endIndex: number;
} | undefined {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          raw: value.slice(startIndex, index + 1),
          endIndex: index + 1
        };
      }
    }
  }
  return undefined;
}

export function repairTextualOpenAiCompatibleToolCalls(
  text: string,
  toolDefinitions: OpenAiCompatibleToolDefinition[]
): {
  text: string;
  toolCalls: OpenAiCompatibleToolCall[];
} {
  const availableToolNames = new Set(toolDefinitions.map((tool) => tool.name));
  const toolCalls: OpenAiCompatibleToolCall[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /(^|\n)\s*\[Tool\]\s+([A-Za-z_][A-Za-z0-9_]*)\s*/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const toolName = match[2];
    if (!availableToolNames.has(toolName)) {
      continue;
    }
    const jsonStart = text.indexOf('{', pattern.lastIndex);
    if (jsonStart < 0) {
      continue;
    }
    if (!/^\s*$/.test(text.slice(pattern.lastIndex, jsonStart))) {
      continue;
    }
    const extracted = extractBalancedJsonObject(text, jsonStart);
    if (!extracted) {
      continue;
    }
    const parsedArguments = parseToolCallArguments(extracted.raw);
    if (!parsedArguments) {
      continue;
    }
    const start = match.index + (match[1] === '\n' ? 1 : 0);
    toolCalls.push({
      id: makeId('text_tool'),
      name: toolName,
      arguments: parsedArguments,
      rawArguments: extracted.raw
    });
    ranges.push({
      start,
      end: extracted.endIndex
    });
    pattern.lastIndex = extracted.endIndex;
  }

  if (ranges.length === 0) {
    return {
      text,
      toolCalls
    };
  }

  let cleanedText = '';
  let cursor = 0;
  for (const range of ranges) {
    cleanedText += text.slice(cursor, range.start);
    cursor = range.end;
  }
  cleanedText += text.slice(cursor);

  return {
    text: cleanedText
      .split(/\n{3,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n'),
    toolCalls
  };
}
