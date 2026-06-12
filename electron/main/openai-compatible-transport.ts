import type { AiProvider, AiProviderApiMode } from '../../shared/types';
import type { OpenAiCompatibleError } from './openai-compatible-types';
import {
  createProviderRequestAbort,
  resolveProviderChunkTimeoutMs,
  type ProviderRequestAbort
} from './provider-runtime-options';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringifyBody(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildRequestHeaders(provider: AiProvider, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...(provider.headers ?? {}),
    'Content-Type': 'application/json',
    Accept: accept
  };
  const authStyle = provider.authStyle ?? 'api_key';
  const apiKey = provider.apiKey.trim();
  if ((authStyle === 'api_key' || authStyle === 'auth_token') && apiKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export const ANTHROPIC_MESSAGES_API_VERSION = '2023-06-01';

/**
 * Anthropic-dialect auth: api_key style sends x-api-key (the Anthropic convention third-party
 * Anthropic-compatible endpoints expect), auth_token keeps Authorization: Bearer; env_only /
 * custom_header rely entirely on provider.headers. anthropic-version is always present but a
 * provider-configured header wins.
 */
export function buildAnthropicMessagesRequestHeaders(provider: AiProvider, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...(provider.headers ?? {}),
    'Content-Type': 'application/json',
    Accept: accept
  };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'anthropic-version')) {
    headers['anthropic-version'] = ANTHROPIC_MESSAGES_API_VERSION;
  }
  const authStyle = provider.authStyle ?? 'api_key';
  const apiKey = provider.apiKey.trim();
  if (authStyle === 'api_key' && apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === 'x-api-key')) {
    headers['x-api-key'] = apiKey;
  }
  if (authStyle === 'auth_token' && apiKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

const FETCH_RETRY_DELAYS_MS = [0, 250];
const HTTP_MAX_RETRIES = 4;
const HTTP_RETRY_BASE_MS = 500;
const HTTP_RETRY_DELAY_CAP_MS = 20_000;
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Delay before an HTTP retry. A server-provided Retry-After (already capped in
 * readRetryAfterMs) always wins; otherwise standard exponential backoff with
 * equal jitter: base * 2^attempt, capped, then half-fixed + half-random so a
 * rate-limited provider isn't hammered by perfectly synchronized retries.
 */
export function computeHttpRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return retryAfterMs;
  }
  const exponential = Math.min(HTTP_RETRY_BASE_MS * 2 ** Math.max(0, attempt), HTTP_RETRY_DELAY_CAP_MS);
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export function createApiError(
  message: string,
  options?: {
    statusCode?: number;
    code?: string;
    apiMode?: AiProviderApiMode;
    requestUrl?: string;
    requestBody?: unknown;
    responseBody?: unknown;
    cause?: unknown;
  }
): OpenAiCompatibleError {
  const error = new Error(message) as OpenAiCompatibleError;
  error.cause = options?.cause;
  error.statusCode = options?.statusCode;
  error.code = options?.code;
  error.apiMode = options?.apiMode;
  error.requestUrl = options?.requestUrl;
  if (options?.requestBody !== undefined) {
    error.requestBody = stringifyBody(options.requestBody);
  }
  if (options?.responseBody !== undefined) {
    error.responseBody = stringifyBody(options.responseBody);
  }
  return error;
}

function readFetchErrorCode(value: unknown): string | undefined {
  const record = isRecord(value) ? value : undefined;
  const code = record?.code ?? record?.errorCode;
  return typeof code === 'string' ? code : undefined;
}

function collectErrorChain(value: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = value;
  for (let index = 0; index < 4 && current != null; index += 1) {
    chain.push(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function getFetchFailureCode(error: unknown): string | undefined {
  for (const item of collectErrorChain(error)) {
    const code = readFetchErrorCode(item);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function stringifyFetchFailure(error: unknown): string {
  return collectErrorChain(error)
    .map((item) => {
      if (item instanceof Error) {
        return [item.name, item.message, readFetchErrorCode(item)].filter(Boolean).join(' ');
      }
      if (isRecord(item)) {
        return [
          typeof item.name === 'string' ? item.name : undefined,
          typeof item.message === 'string' ? item.message : undefined,
          readFetchErrorCode(item)
        ]
          .filter(Boolean)
          .join(' ');
      }
      return String(item);
    })
    .filter(Boolean)
    .join(' ');
}

function isAbortFailure(error: unknown, abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError'));
}

function isRetryableFetchFailure(error: unknown, abortSignal?: AbortSignal): boolean {
  if (isAbortFailure(error, abortSignal)) {
    return false;
  }
  const code = getFetchFailureCode(error)?.toUpperCase();
  if (code) {
    return new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT'
    ]).has(code);
  }
  const message = stringifyFetchFailure(error).toLowerCase();
  return /fetch failed|network|socket|tls connection|other side closed|terminated/.test(message);
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function createProviderTimeoutApiError(
  label: string,
  abort: ProviderRequestAbort,
  context: {
    apiMode: AiProviderApiMode;
    requestUrl: string;
    requestBody: unknown;
    cause?: unknown;
  }
): OpenAiCompatibleError {
  const seconds = abort.timeoutMs === false ? 0 : Math.round(abort.timeoutMs / 1000);
  return createApiError(`${label} timed out after ${seconds}s.`, {
    code: 'PROVIDER_REQUEST_TIMEOUT',
    apiMode: context.apiMode,
    requestUrl: context.requestUrl,
    requestBody: context.requestBody,
    cause: context.cause
  });
}

function rethrowProviderRequestTimeout(
  error: unknown,
  abort: ProviderRequestAbort | undefined,
  context: {
    apiMode: AiProviderApiMode;
    requestUrl: string;
    requestBody: unknown;
  }
): never {
  if (abort?.timedOut()) {
    throw createProviderTimeoutApiError('OpenAI-compatible provider request', abort, {
      ...context,
      cause: error
    });
  }
  throw error;
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: {
    chunkTimeoutMs?: number;
    abortSignal?: AbortSignal;
    apiMode: AiProviderApiMode;
    requestUrl: string;
    requestBody: unknown;
  }
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!options.chunkTimeoutMs) {
    return reader.read();
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (options.abortSignal?.aborted) {
        reject(createAbortError());
        return;
      }
      const error = createApiError(`OpenAI-compatible SSE stream chunk timed out after ${options.chunkTimeoutMs}ms.`, {
        code: 'PROVIDER_CHUNK_TIMEOUT',
        apiMode: options.apiMode,
        requestUrl: options.requestUrl,
        requestBody: options.requestBody
      });
      void reader.cancel(error);
      reject(error);
    }, options.chunkTimeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function waitForRetry(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };
    const cleanup = (): void => {
      abortSignal?.removeEventListener('abort', onAbort);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchOpenAiCompatible(
  url: string,
  init: RequestInit,
  context: {
    apiMode: AiProviderApiMode;
    requestBody: unknown;
    abortSignal?: AbortSignal;
    requestAbort?: ProviderRequestAbort;
  }
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (context.requestAbort?.timedOut()) {
        throw createProviderTimeoutApiError('OpenAI-compatible provider request', context.requestAbort, {
          apiMode: context.apiMode,
          requestUrl: url,
          requestBody: context.requestBody,
          cause: error
        });
      }
      if (!isRetryableFetchFailure(error, context.abortSignal) || attempt >= FETCH_RETRY_DELAYS_MS.length) {
        const code = getFetchFailureCode(error) ?? 'FETCH_FAILED';
        throw createApiError(
          `OpenAI-compatible streaming request failed before receiving a response after ${attempt + 1} network attempt${attempt === 0 ? '' : 's'}: ${error instanceof Error ? error.message : String(error)}`,
          {
            code,
            apiMode: context.apiMode,
            requestUrl: url,
            requestBody: context.requestBody,
            cause: error
          }
        );
      }
      lastError = error;
      await waitForRetry(FETCH_RETRY_DELAYS_MS[attempt] ?? 0, context.abortSignal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function readRetryAfterMs(response: Response, body: unknown): number | undefined {
  const header = response.headers.get('retry-after');
  const bodyRetryAfter = isRecord(body) ? (body.retry_after ?? body.retryAfter) : undefined;
  const candidates = [header, bodyRetryAfter];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return Math.min(candidate * 1000, HTTP_RETRY_DELAY_CAP_MS);
    }
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.min(numeric * 1000, HTTP_RETRY_DELAY_CAP_MS);
    }
    const dateMs = Date.parse(candidate);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), HTTP_RETRY_DELAY_CAP_MS);
    }
  }
  return undefined;
}

function isRetryableHttpBody(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  return (
    body.retryable === true ||
    body.cloudflare_error === true ||
    body.error_name === 'origin_bad_gateway' ||
    body.error_name === 'origin_unavailable' ||
    body.error_name === 'origin_dns_error'
  );
}

function isNonRetryableProviderBody(body: unknown): boolean {
  const message = readErrorMessage(body)?.toLowerCase() ?? '';
  return message.includes("cannot read properties of undefined (reading 'map')");
}

function shouldRetryHttpResponse(status: number, body: unknown): boolean {
  if (isNonRetryableProviderBody(body)) {
    return false;
  }
  return RETRYABLE_HTTP_STATUS_CODES.has(status) || isRetryableHttpBody(body);
}

function createHttpResponseErrorMessage(prefix: string, status: number, body: unknown, attempt: number): string {
  const retryAfter = isRecord(body) && typeof body.retry_after === 'number' ? ` Retry after ${body.retry_after}s.` : '';
  const attempts = attempt > 0 ? ` after ${attempt + 1} HTTP attempts` : '';
  return `${readErrorMessage(body) ?? `${prefix} with HTTP ${status}.`}${attempts}.${retryAfter}`.trim();
}

export function readErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  if (typeof body.message === 'string') {
    return body.message;
  }
  if (typeof body.detail === 'string') {
    return body.detail;
  }
  return undefined;
}

export function readErrorCode(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (isRecord(body.error) && typeof body.error.code === 'string') {
    return body.error.code;
  }
  if (isRecord(body.error) && typeof body.error.type === 'string') {
    return body.error.type;
  }
  if (typeof body.error_name === 'string') {
    return body.error_name;
  }
  if (typeof body.error_code === 'string') {
    return body.error_code;
  }
  if (typeof body.error_code === 'number') {
    return String(body.error_code);
  }
  if (typeof body.code === 'string') {
    return body.code;
  }
  if (typeof body.type === 'string') {
    return body.type;
  }
  return undefined;
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return '';
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ResponsesSseParseResult {
  text: string;
  responseBody: unknown;
}

export interface ChatCompletionsSseParseResult {
  text: string;
  reasoningContent: string;
  responseBody: unknown;
}

type ResponsesSseOutputItem = Record<string, unknown>;

interface ResponsesSseState {
  events: Record<string, unknown>[];
  text: string;
  doneText: string;
  finalResponse?: Record<string, unknown>;
  outputItems: Map<number, ResponsesSseOutputItem>;
}

export function summarizeSseEvent(event: Record<string, unknown>): Record<string, unknown> {
  const item = isRecord(event.item) ? event.item : undefined;
  return {
    type: event.type,
    outputIndex: event.output_index,
    contentIndex: event.content_index,
    itemType: item?.type,
    delta: typeof event.delta === 'string' ? event.delta : undefined,
    text: typeof event.text === 'string' ? truncateText(event.text, 240) : undefined,
    responseStatus: isRecord(event.response) ? event.response.status : undefined
  };
}

function getResponsesOutputIndex(event: Record<string, unknown>): number | undefined {
  return typeof event.output_index === 'number' ? event.output_index : undefined;
}

function mergeResponsesOutputItem(
  state: Pick<ResponsesSseState, 'outputItems'>,
  outputIndex: number | undefined,
  item: Record<string, unknown>
): void {
  if (outputIndex === undefined) {
    return;
  }
  const current = state.outputItems.get(outputIndex) ?? {};
  state.outputItems.set(outputIndex, {
    ...current,
    ...item
  });
}

function consumeResponsesFunctionCallArgumentsDelta(state: ResponsesSseState, event: Record<string, unknown>): void {
  const outputIndex = getResponsesOutputIndex(event);
  if (outputIndex === undefined || typeof event.delta !== 'string') {
    return;
  }
  const current = state.outputItems.get(outputIndex) ?? { type: 'function_call' };
  state.outputItems.set(outputIndex, {
    ...current,
    type: 'function_call',
    id: typeof event.item_id === 'string' ? event.item_id : current.id,
    arguments: `${typeof current.arguments === 'string' ? current.arguments : ''}${event.delta}`
  });
}

function consumeResponsesFunctionCallArgumentsDone(state: ResponsesSseState, event: Record<string, unknown>): void {
  const outputIndex = getResponsesOutputIndex(event);
  if (outputIndex === undefined || typeof event.arguments !== 'string') {
    return;
  }
  const current = state.outputItems.get(outputIndex) ?? { type: 'function_call' };
  state.outputItems.set(outputIndex, {
    ...current,
    type: 'function_call',
    id: typeof event.item_id === 'string' ? event.item_id : current.id,
    arguments: event.arguments
  });
}

export function consumeSseEvent(
  eventName: string,
  dataLines: string[],
  state: ResponsesSseState,
  onDelta?: (delta: string, accumulated: string) => void
): void {
  if (!dataLines.length) {
    return;
  }
  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') {
    return;
  }
  try {
    const parsed = JSON.parse(data);
    if (!isRecord(parsed)) {
      return;
    }
    const event: Record<string, unknown> = {
      ...parsed,
      event: eventName || parsed.type
    };
    state.events.push(event);
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      state.text += event.delta;
      onDelta?.(event.delta, state.text);
    }
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      state.doneText = event.text;
    }
    if (
      (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') &&
      isRecord(event.item)
    ) {
      mergeResponsesOutputItem(state, getResponsesOutputIndex(event), event.item);
    }
    if (event.type === 'response.function_call_arguments.delta') {
      consumeResponsesFunctionCallArgumentsDelta(state, event);
    }
    if (event.type === 'response.function_call_arguments.done') {
      consumeResponsesFunctionCallArgumentsDone(state, event);
    }
    if (isRecord(event.response)) {
      state.finalResponse = event.response;
    }
  } catch {
    state.events.push({
      type: 'parse_error',
      event: eventName,
      dataPreview: truncateText(data, 240)
    });
  }
}

export function finalizeResponsesSseState(state: {
  events: Record<string, unknown>[];
  text: string;
  doneText: string;
  finalResponse?: Record<string, unknown>;
  outputItems: Map<number, ResponsesSseOutputItem>;
}): ResponsesSseParseResult {
  const outputText = state.text || state.doneText;
  const finalOutput = Array.isArray(state.finalResponse?.output) ? state.finalResponse.output : [];
  const synthesizedOutput = [...state.outputItems.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
  const output =
    finalOutput.length > 0
      ? [
          ...finalOutput,
          ...synthesizedOutput.filter((item) => {
            const itemId = typeof item.id === 'string' ? item.id : undefined;
            const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
            return !finalOutput.some((existing) => {
              if (!isRecord(existing)) {
                return false;
              }
              return (itemId && existing.id === itemId) || (callId && existing.call_id === callId);
            });
          })
        ]
      : synthesizedOutput;
  return {
    text: outputText,
    responseBody: {
      ...(state.finalResponse ?? {}),
      output,
      output_text: outputText,
      stream: {
        eventCount: state.events.length,
        events: state.events.map(summarizeSseEvent).slice(0, 80),
        finalResponse: state.finalResponse
      }
    }
  };
}

export function parseResponsesSseText(
  sseText: string,
  onDelta?: (delta: string, accumulated: string) => void
): ResponsesSseParseResult {
  const events: Record<string, unknown>[] = [];
  let eventName = '';
  let dataLines: string[] = [];
  const state = {
    events,
    text: '',
    doneText: '',
    finalResponse: undefined as Record<string, unknown> | undefined,
    outputItems: new Map<number, ResponsesSseOutputItem>()
  };

  for (const line of sseText.split(/\r?\n/)) {
    if (!line.trim()) {
      consumeSseEvent(eventName, dataLines, state, onDelta);
      dataLines = [];
      eventName = '';
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  consumeSseEvent(eventName, dataLines, state, onDelta);
  return finalizeResponsesSseState(state);
}

function extractTextFromContentPart(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }
  if (!isRecord(part)) {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (isRecord(part.text) && typeof part.text.value === 'string') {
    return part.text.value;
  }
  if (typeof part.value === 'string') {
    return part.value;
  }
  if (typeof part.content === 'string') {
    return part.content;
  }
  if (Array.isArray(part.content)) {
    return part.content.map(extractTextFromContentPart).join('');
  }
  return '';
}

const LEADING_THINK_PATTERN = /^\s*<think>([\s\S]*?)<\/think>\s*/;

/**
 * Reasoning models like MiniMax-M3 inline their chain-of-thought as a leading
 * <think>...</think> block in the message content (instead of a separate
 * reasoning_content field). Strip it so it doesn't leak into the visible reply;
 * the captured thought is returned separately to surface as reasoning.
 */
export function stripLeadingThinkBlock(content: string): { text: string; reasoning: string } {
  const match = content.match(LEADING_THINK_PATTERN);
  if (!match) {
    return { text: content, reasoning: '' };
  }
  return { text: content.slice(match[0].length), reasoning: match[1].trim() };
}

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

/**
 * Streaming counterpart to {@link stripLeadingThinkBlock}. Reasoning models such
 * as MiniMax-M3 inline their chain-of-thought as a leading <think>...</think>
 * block in the *content* stream. The tag can be split across SSE chunks (one
 * chunk ends "<thi", the next starts "nk>"), so a small state machine + buffer is
 * needed to keep the visible reply from ever flashing the think markup: text
 * inside the block is routed to reasoning, everything after </think> to text.
 */
export interface ThinkStreamSplitState {
  mode: 'pending' | 'in-think' | 'passthrough';
  buffer: string;
}

export function createThinkStreamSplitState(): ThinkStreamSplitState {
  return { mode: 'pending', buffer: '' };
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (0 if none). */
function trailingPartialTagLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (tag.startsWith(text.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Feed one streamed content delta through the splitter. Returns the portion of
 * this delta that is visible reply `text` and the portion that is `reasoning`;
 * either may be empty. Bytes that cannot yet be classified (a possible partial
 * tag straddling a chunk boundary) stay buffered until the next delta.
 */
export function pushThroughThinkStream(
  split: ThinkStreamSplitState,
  delta: string
): { text: string; reasoning: string } {
  split.buffer += delta;
  let text = '';
  let reasoning = '';

  for (;;) {
    if (split.mode === 'pending') {
      const leadingWs = split.buffer.match(/^\s*/)?.[0] ?? '';
      const rest = split.buffer.slice(leadingWs.length);
      if (rest.length === 0) {
        // Only whitespace so far — can't yet tell if <think> follows. Keep buffering.
        break;
      }
      if (rest.startsWith(THINK_OPEN_TAG)) {
        // Leading think block opens: drop the whitespace + tag, switch to in-think.
        split.buffer = rest.slice(THINK_OPEN_TAG.length);
        split.mode = 'in-think';
        continue;
      }
      if (THINK_OPEN_TAG.startsWith(rest)) {
        // `rest` is still a proper prefix of "<think>" — wait for the rest of the tag.
        break;
      }
      // No leading think block: flush everything (incl. whitespace) as visible text.
      text += split.buffer;
      split.buffer = '';
      split.mode = 'passthrough';
      break;
    }

    if (split.mode === 'in-think') {
      const closeIdx = split.buffer.indexOf(THINK_CLOSE_TAG);
      if (closeIdx === -1) {
        // No close tag yet: emit reasoning but hold back a possible partial </think>.
        const hold = trailingPartialTagLength(split.buffer, THINK_CLOSE_TAG);
        reasoning += split.buffer.slice(0, split.buffer.length - hold);
        split.buffer = hold ? split.buffer.slice(split.buffer.length - hold) : '';
        break;
      }
      reasoning += split.buffer.slice(0, closeIdx);
      split.buffer = split.buffer.slice(closeIdx + THINK_CLOSE_TAG.length);
      // Mirror the trailing \s* the non-streaming pattern consumes after </think>.
      split.buffer = split.buffer.replace(/^\s*/, '');
      split.mode = 'passthrough';
      continue;
    }

    // passthrough: everything is visible text from here on.
    text += split.buffer;
    split.buffer = '';
    break;
  }

  return { text, reasoning };
}

/**
 * Flush any buffered tail when the stream ends. A still-open think block (stream
 * truncated mid-thought) flushes as reasoning — consistent with what was already
 * streamed; anything else (a partial open tag / whitespace) flushes as text.
 */
export function flushThinkStream(split: ThinkStreamSplitState): { text: string; reasoning: string } {
  const tail = split.buffer;
  split.buffer = '';
  if (split.mode === 'in-think') {
    return { text: '', reasoning: tail };
  }
  return { text: tail, reasoning: '' };
}

export function extractTextFromChatChoices(body: unknown): string {
  if (!isRecord(body)) {
    return '';
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  return choices
    .map((choice) => {
      if (!isRecord(choice)) {
        return '';
      }
      const message = isRecord(choice.message) ? choice.message : undefined;
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      const content = message?.content ?? delta?.content ?? choice.text;
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(extractTextFromContentPart).join('')
            : '';
      return stripLeadingThinkBlock(raw).text;
    })
    .join('\n')
    .trim();
}

export function extractReasoningFromChatChoices(body: unknown): string {
  if (!isRecord(body)) {
    return '';
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  return choices
    .map((choice) => {
      if (!isRecord(choice)) {
        return '';
      }
      const message = isRecord(choice.message) ? choice.message : undefined;
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      const reasoningContent =
        message?.reasoning_content ??
        message?.reasoningContent ??
        message?.reasoning ??
        delta?.reasoning_content ??
        delta?.reasoningContent ??
        delta?.reasoning;
      if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
        return reasoningContent;
      }
      // Fallback: models like MiniMax-M3 inline reasoning as a leading <think>
      // block in content rather than a reasoning_content field.
      const content = message?.content ?? delta?.content ?? choice.text;
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(extractTextFromContentPart).join('')
            : '';
      return stripLeadingThinkBlock(raw).reasoning;
    })
    .join('\n')
    .trim();
}

export function extractTextFromResponsesOutput(output: unknown): string {
  if (!Array.isArray(output)) {
    return '';
  }

  return output
    .map((item) => {
      if (!isRecord(item)) {
        return '';
      }
      if (typeof item.text === 'string') {
        return item.text;
      }
      if (typeof item.content === 'string') {
        return item.content;
      }
      if (Array.isArray(item.content)) {
        return item.content.map(extractTextFromContentPart).join('');
      }
      return '';
    })
    .join('\n')
    .trim();
}

export function extractTextFromResponsesBody(body: unknown): string {
  if (!isRecord(body)) {
    return '';
  }
  if (typeof body.output_text === 'string') {
    return body.output_text.trim();
  }
  if (typeof body.text === 'string') {
    return body.text.trim();
  }
  if (isRecord(body.text) && typeof body.text.value === 'string') {
    return body.text.value.trim();
  }
  return extractTextFromResponsesOutput(body.output) || extractTextFromChatChoices(body);
}

export async function postResponsesStream(
  url: string,
  provider: AiProvider,
  body: unknown,
  abortSignal?: AbortSignal,
  onDelta?: (delta: string, accumulated: string) => void
): Promise<ResponsesSseParseResult> {
  const requestAbort = createProviderRequestAbort(abortSignal, provider);
  const requestSignal = requestAbort.signal;
  const chunkTimeoutMs = resolveProviderChunkTimeoutMs(provider);
  const requestInit = {
    method: 'POST',
    headers: buildRequestHeaders(provider, 'text/event-stream, application/json'),
    body: JSON.stringify(body),
    signal: requestSignal
  } satisfies RequestInit;
  try {
    for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetchOpenAiCompatible(url, requestInit, {
          apiMode: 'responses',
          requestBody: body,
          abortSignal: requestSignal,
          requestAbort
        });
      } catch (error) {
        rethrowProviderRequestTimeout(error, requestAbort, {
          apiMode: 'responses',
          requestUrl: url,
          requestBody: body
        });
      }
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && response.body) {
        if (!response.ok) {
          const responseText = await response.text();
          const responseBody = parseMaybeJson(responseText);
          if (shouldRetryHttpResponse(response.status, responseBody) && attempt < HTTP_MAX_RETRIES) {
            await waitForRetry(
              computeHttpRetryDelayMs(attempt, readRetryAfterMs(response, responseBody)),
              requestSignal
            );
            continue;
          }
          throw createApiError(
            createHttpResponseErrorMessage(
              'OpenAI-compatible streaming request failed',
              response.status,
              responseBody,
              attempt
            ),
            {
              statusCode: response.status,
              code: readErrorCode(responseBody),
              apiMode: 'responses',
              requestUrl: url,
              requestBody: body,
              responseBody
            }
          );
        }

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = '';
        let eventName = '';
        let dataLines: string[] = [];
        const state = {
          events: [] as Record<string, unknown>[],
          text: '',
          doneText: '',
          finalResponse: undefined as Record<string, unknown> | undefined,
          outputItems: new Map<number, ResponsesSseOutputItem>()
        };

        const flush = (): void => {
          consumeSseEvent(eventName, dataLines, state, onDelta);
          dataLines = [];
          eventName = '';
        };

        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await readSseChunk(reader, {
              chunkTimeoutMs,
              abortSignal: requestSignal,
              apiMode: 'responses',
              requestUrl: url,
              requestBody: body
            });
          } catch (error) {
            rethrowProviderRequestTimeout(error, requestAbort, {
              apiMode: 'responses',
              requestUrl: url,
              requestBody: body
            });
          }
          const { done, value } = chunk;
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

          let separatorIndex = buffer.search(/\r?\n\r?\n/);
          while (separatorIndex >= 0) {
            const chunk = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === '\r' ? 4 : 2));
            for (const line of chunk.split(/\r?\n/)) {
              if (line.startsWith('event:')) {
                eventName = line.slice('event:'.length).trim();
                continue;
              }
              if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trimStart());
              }
            }
            flush();
            separatorIndex = buffer.search(/\r?\n\r?\n/);
          }

          if (done) {
            break;
          }
        }

        if (buffer.trim() || dataLines.length) {
          for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith('event:')) {
              eventName = line.slice('event:'.length).trim();
              continue;
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice('data:'.length).trimStart());
            }
          }
          flush();
        }

        return finalizeResponsesSseState(state);
      }

      const responseText = await response.text();
      const responseBody = parseMaybeJson(responseText);

      if (!response.ok) {
        if (shouldRetryHttpResponse(response.status, responseBody) && attempt < HTTP_MAX_RETRIES) {
          await waitForRetry(computeHttpRetryDelayMs(attempt, readRetryAfterMs(response, responseBody)), requestSignal);
          continue;
        }
        throw createApiError(
          createHttpResponseErrorMessage(
            'OpenAI-compatible streaming request failed',
            response.status,
            responseBody,
            attempt
          ),
          {
            statusCode: response.status,
            code: readErrorCode(responseBody),
            apiMode: 'responses',
            requestUrl: url,
            requestBody: body,
            responseBody
          }
        );
      }

      if (
        contentType.includes('text/event-stream') ||
        responseText.includes('\nevent:') ||
        responseText.startsWith('event:')
      ) {
        return parseResponsesSseText(responseText, onDelta);
      }

      return {
        text: extractTextFromResponsesBody(responseBody),
        responseBody
      };
    }

    throw createApiError('OpenAI-compatible streaming request failed after retry attempts.', {
      apiMode: 'responses',
      requestUrl: url,
      requestBody: body
    });
  } finally {
    requestAbort.dispose();
  }
}

type ChatToolCallDeltaState = {
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
};

function getFirstChoiceDelta(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
  return isRecord(firstChoice?.delta) ? firstChoice.delta : undefined;
}

function getFirstChoiceFinishReason(value: Record<string, unknown>): string | undefined {
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : undefined;
  return typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined;
}

function consumeChatCompletionsSseEvent(
  dataLines: string[],
  state: {
    events: Record<string, unknown>[];
    text: string;
    reasoningContent: string;
    thinkSplit: ThinkStreamSplitState;
    toolCalls: Map<number, ChatToolCallDeltaState>;
    finishReason?: string;
    usage?: unknown;
    id?: string;
    model?: string;
    created?: unknown;
  },
  onDelta?: (delta: string, accumulated: string) => void,
  onReasoningDelta?: (delta: string, accumulated: string) => void
): void {
  if (!dataLines.length) {
    return;
  }
  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') {
    return;
  }
  try {
    const parsed = JSON.parse(data);
    if (!isRecord(parsed)) {
      return;
    }
    state.events.push(parsed);
    if (typeof parsed.id === 'string') {
      state.id = parsed.id;
    }
    if (typeof parsed.model === 'string') {
      state.model = parsed.model;
    }
    if (parsed.created != null) {
      state.created = parsed.created;
    }
    if (parsed.usage != null) {
      state.usage = parsed.usage;
    }
    const finishReason = getFirstChoiceFinishReason(parsed);
    if (finishReason) {
      state.finishReason = finishReason;
    }
    const delta = getFirstChoiceDelta(parsed);
    if (!delta) {
      return;
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const split = pushThroughThinkStream(state.thinkSplit, delta.content);
      if (split.text) {
        state.text += split.text;
        onDelta?.(split.text, state.text);
      }
      if (split.reasoning) {
        state.reasoningContent += split.reasoning;
        onReasoningDelta?.(split.reasoning, state.reasoningContent);
      }
    }
    const reasoningDelta = delta.reasoning_content ?? delta.reasoningContent ?? delta.reasoning;
    if (typeof reasoningDelta === 'string') {
      state.reasoningContent += reasoningDelta;
      onReasoningDelta?.(reasoningDelta, state.reasoningContent);
    }
    const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawToolCallDelta of toolCallDeltas) {
      if (!isRecord(rawToolCallDelta)) {
        continue;
      }
      const index = typeof rawToolCallDelta.index === 'number' ? rawToolCallDelta.index : state.toolCalls.size;
      const current = state.toolCalls.get(index) ?? { arguments: '' };
      if (typeof rawToolCallDelta.id === 'string') {
        current.id = rawToolCallDelta.id;
      }
      if (typeof rawToolCallDelta.type === 'string') {
        current.type = rawToolCallDelta.type;
      }
      const fn = isRecord(rawToolCallDelta.function) ? rawToolCallDelta.function : undefined;
      if (typeof fn?.name === 'string') {
        current.name = fn.name;
      }
      if (typeof fn?.arguments === 'string') {
        current.arguments += fn.arguments;
      }
      state.toolCalls.set(index, current);
    }
  } catch {
    state.events.push({
      type: 'parse_error',
      dataPreview: truncateText(data, 240)
    });
  }
}

function finalizeChatCompletionsSseState(state: {
  events: Record<string, unknown>[];
  text: string;
  reasoningContent: string;
  thinkSplit?: ThinkStreamSplitState;
  toolCalls: Map<number, ChatToolCallDeltaState>;
  finishReason?: string;
  usage?: unknown;
  id?: string;
  model?: string;
  created?: unknown;
}): ChatCompletionsSseParseResult {
  if (state.thinkSplit) {
    const tail = flushThinkStream(state.thinkSplit);
    if (tail.text) {
      state.text += tail.text;
    }
    if (tail.reasoning) {
      state.reasoningContent += tail.reasoning;
    }
  }
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => ({
      id: toolCall.id ?? `call_${index}`,
      type: 'function',
      function: {
        name: toolCall.name ?? '',
        arguments: toolCall.arguments
      }
    }))
    .filter((toolCall) => toolCall.function.name);

  return {
    text: state.text,
    reasoningContent: state.reasoningContent,
    responseBody: {
      id: state.id,
      model: state.model,
      created: state.created,
      choices: [
        {
          finish_reason: state.finishReason,
          message: {
            role: 'assistant',
            content: state.text || null,
            ...(state.reasoningContent ? { reasoning_content: state.reasoningContent } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {})
          }
        }
      ],
      usage: state.usage,
      stream: {
        eventCount: state.events.length,
        events: state.events
          .map((event) => ({
            id: event.id,
            model: event.model,
            usage: event.usage,
            finishReason: getFirstChoiceFinishReason(event),
            delta: (() => {
              const delta = getFirstChoiceDelta(event);
              return delta
                ? {
                    contentLength: typeof delta.content === 'string' ? delta.content.length : undefined,
                    reasoningLength:
                      typeof delta.reasoning_content === 'string' ? delta.reasoning_content.length : undefined,
                    toolCallCount: Array.isArray(delta.tool_calls) ? delta.tool_calls.length : undefined
                  }
                : undefined;
            })()
          }))
          .slice(0, 80)
      }
    }
  };
}

export function parseChatCompletionsSseText(
  sseText: string,
  onDelta?: (delta: string, accumulated: string) => void,
  onReasoningDelta?: (delta: string, accumulated: string) => void
): ChatCompletionsSseParseResult {
  let dataLines: string[] = [];
  const state = {
    events: [] as Record<string, unknown>[],
    text: '',
    reasoningContent: '',
    thinkSplit: createThinkStreamSplitState(),
    toolCalls: new Map<number, ChatToolCallDeltaState>(),
    finishReason: undefined as string | undefined,
    usage: undefined as unknown,
    id: undefined as string | undefined,
    model: undefined as string | undefined,
    created: undefined as unknown
  };

  for (const line of sseText.split(/\r?\n/)) {
    if (!line.trim()) {
      consumeChatCompletionsSseEvent(dataLines, state, onDelta, onReasoningDelta);
      dataLines = [];
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  consumeChatCompletionsSseEvent(dataLines, state, onDelta, onReasoningDelta);
  return finalizeChatCompletionsSseState(state);
}

export async function postChatCompletionsStream(
  url: string,
  provider: AiProvider,
  body: unknown,
  abortSignal?: AbortSignal,
  onDelta?: (delta: string, accumulated: string) => void,
  onReasoningDelta?: (delta: string, accumulated: string) => void
): Promise<ChatCompletionsSseParseResult> {
  const requestAbort = createProviderRequestAbort(abortSignal, provider);
  const requestSignal = requestAbort.signal;
  const chunkTimeoutMs = resolveProviderChunkTimeoutMs(provider);
  const requestInit = {
    method: 'POST',
    headers: buildRequestHeaders(provider, 'text/event-stream, application/json'),
    body: JSON.stringify(body),
    signal: requestSignal
  } satisfies RequestInit;
  try {
    for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetchOpenAiCompatible(url, requestInit, {
          apiMode: 'chat',
          requestBody: body,
          abortSignal: requestSignal,
          requestAbort
        });
      } catch (error) {
        rethrowProviderRequestTimeout(error, requestAbort, {
          apiMode: 'chat',
          requestUrl: url,
          requestBody: body
        });
      }
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && response.body) {
        if (!response.ok) {
          const responseText = await response.text();
          const responseBody = parseMaybeJson(responseText);
          if (shouldRetryHttpResponse(response.status, responseBody) && attempt < HTTP_MAX_RETRIES) {
            await waitForRetry(
              computeHttpRetryDelayMs(attempt, readRetryAfterMs(response, responseBody)),
              requestSignal
            );
            continue;
          }
          throw createApiError(
            createHttpResponseErrorMessage(
              'OpenAI-compatible chat streaming request failed',
              response.status,
              responseBody,
              attempt
            ),
            {
              statusCode: response.status,
              code: readErrorCode(responseBody),
              apiMode: 'chat',
              requestUrl: url,
              requestBody: body,
              responseBody
            }
          );
        }

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = '';
        let dataLines: string[] = [];
        const state = {
          events: [] as Record<string, unknown>[],
          text: '',
          reasoningContent: '',
          thinkSplit: createThinkStreamSplitState(),
          toolCalls: new Map<number, ChatToolCallDeltaState>(),
          finishReason: undefined as string | undefined,
          usage: undefined as unknown,
          id: undefined as string | undefined,
          model: undefined as string | undefined,
          created: undefined as unknown
        };

        const flush = (): void => {
          consumeChatCompletionsSseEvent(dataLines, state, onDelta, onReasoningDelta);
          dataLines = [];
        };

        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await readSseChunk(reader, {
              chunkTimeoutMs,
              abortSignal: requestSignal,
              apiMode: 'chat',
              requestUrl: url,
              requestBody: body
            });
          } catch (error) {
            rethrowProviderRequestTimeout(error, requestAbort, {
              apiMode: 'chat',
              requestUrl: url,
              requestBody: body
            });
          }
          const { done, value } = chunk;
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

          let separatorIndex = buffer.search(/\r?\n\r?\n/);
          while (separatorIndex >= 0) {
            const chunk = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === '\r' ? 4 : 2));
            for (const line of chunk.split(/\r?\n/)) {
              if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trimStart());
              }
            }
            flush();
            separatorIndex = buffer.search(/\r?\n\r?\n/);
          }

          if (done) {
            break;
          }
        }

        if (buffer.trim() || dataLines.length) {
          for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith('data:')) {
              dataLines.push(line.slice('data:'.length).trimStart());
            }
          }
          flush();
        }

        return finalizeChatCompletionsSseState(state);
      }

      const responseText = await response.text();
      const responseBody = parseMaybeJson(responseText);
      if (!response.ok) {
        if (shouldRetryHttpResponse(response.status, responseBody) && attempt < HTTP_MAX_RETRIES) {
          await waitForRetry(computeHttpRetryDelayMs(attempt, readRetryAfterMs(response, responseBody)), requestSignal);
          continue;
        }
        throw createApiError(
          createHttpResponseErrorMessage(
            'OpenAI-compatible chat streaming request failed',
            response.status,
            responseBody,
            attempt
          ),
          {
            statusCode: response.status,
            code: readErrorCode(responseBody),
            apiMode: 'chat',
            requestUrl: url,
            requestBody: body,
            responseBody
          }
        );
      }

      if (
        contentType.includes('text/event-stream') ||
        responseText.includes('\ndata:') ||
        responseText.startsWith('data:')
      ) {
        return parseChatCompletionsSseText(responseText, onDelta, onReasoningDelta);
      }

      return {
        text: extractTextFromChatChoices(responseBody),
        reasoningContent: extractReasoningFromChatChoices(responseBody),
        responseBody
      };
    }

    throw createApiError('OpenAI-compatible chat streaming request failed after retry attempts.', {
      apiMode: 'chat',
      requestUrl: url,
      requestBody: body
    });
  } finally {
    requestAbort.dispose();
  }
}

export interface AnthropicMessagesSseParseResult {
  text: string;
  reasoningContent: string;
  responseBody: unknown;
}

interface AnthropicContentBlockState {
  type: string;
  id?: string;
  name?: string;
  initialInput?: unknown;
  text: string;
  thinking: string;
  signature: string;
  partialJson: string;
}

interface AnthropicMessagesSseState {
  events: Record<string, unknown>[];
  text: string;
  reasoningContent: string;
  blocks: Map<number, AnthropicContentBlockState>;
  stopReason?: string;
  stopSequence?: string;
  usage?: Record<string, unknown>;
  id?: string;
  model?: string;
  error?: {
    type?: string;
    message: string;
  };
}

function createAnthropicMessagesSseState(): AnthropicMessagesSseState {
  return {
    events: [],
    text: '',
    reasoningContent: '',
    blocks: new Map()
  };
}

function summarizeAnthropicSseEvent(event: Record<string, unknown>): Record<string, unknown> {
  const contentBlock = isRecord(event.content_block) ? event.content_block : undefined;
  const delta = isRecord(event.delta) ? event.delta : undefined;
  return {
    type: event.type,
    index: event.index,
    blockType: contentBlock?.type,
    deltaType: delta?.type,
    textLength: typeof delta?.text === 'string' ? delta.text.length : undefined,
    thinkingLength: typeof delta?.thinking === 'string' ? delta.thinking.length : undefined,
    partialJsonLength: typeof delta?.partial_json === 'string' ? delta.partial_json.length : undefined,
    stopReason: delta?.stop_reason
  };
}

function getAnthropicBlockState(
  state: AnthropicMessagesSseState,
  index: unknown
): AnthropicContentBlockState | undefined {
  return typeof index === 'number' ? state.blocks.get(index) : undefined;
}

function consumeAnthropicMessagesSseEvent(
  eventName: string,
  dataLines: string[],
  state: AnthropicMessagesSseState,
  onDelta?: (delta: string, accumulated: string) => void,
  onReasoningDelta?: (delta: string, accumulated: string) => void
): void {
  if (!dataLines.length) {
    return;
  }
  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') {
    return;
  }
  try {
    const parsed = JSON.parse(data);
    if (!isRecord(parsed)) {
      return;
    }
    const type = typeof parsed.type === 'string' ? parsed.type : eventName;
    state.events.push({ ...parsed, event: eventName || type });
    if (type === 'message_start' && isRecord(parsed.message)) {
      if (typeof parsed.message.id === 'string') {
        state.id = parsed.message.id;
      }
      if (typeof parsed.message.model === 'string') {
        state.model = parsed.message.model;
      }
      if (isRecord(parsed.message.usage)) {
        state.usage = { ...(state.usage ?? {}), ...parsed.message.usage };
      }
      return;
    }
    if (type === 'content_block_start' && typeof parsed.index === 'number' && isRecord(parsed.content_block)) {
      state.blocks.set(parsed.index, {
        type: typeof parsed.content_block.type === 'string' ? parsed.content_block.type : 'text',
        id: typeof parsed.content_block.id === 'string' ? parsed.content_block.id : undefined,
        name: typeof parsed.content_block.name === 'string' ? parsed.content_block.name : undefined,
        initialInput: parsed.content_block.input,
        text: typeof parsed.content_block.text === 'string' ? parsed.content_block.text : '',
        thinking: typeof parsed.content_block.thinking === 'string' ? parsed.content_block.thinking : '',
        signature: '',
        partialJson: ''
      });
      return;
    }
    if (type === 'content_block_delta' && isRecord(parsed.delta)) {
      const block = getAnthropicBlockState(state, parsed.index);
      const delta = parsed.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        if (block) {
          block.text += delta.text;
        }
        state.text += delta.text;
        onDelta?.(delta.text, state.text);
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        if (block) {
          block.thinking += delta.thinking;
        }
        state.reasoningContent += delta.thinking;
        onReasoningDelta?.(delta.thinking, state.reasoningContent);
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && block) {
        block.partialJson += delta.partial_json;
      }
      if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && block) {
        block.signature += delta.signature;
      }
      return;
    }
    if (type === 'message_delta') {
      if (isRecord(parsed.delta)) {
        if (typeof parsed.delta.stop_reason === 'string') {
          state.stopReason = parsed.delta.stop_reason;
        }
        if (typeof parsed.delta.stop_sequence === 'string') {
          state.stopSequence = parsed.delta.stop_sequence;
        }
      }
      if (isRecord(parsed.usage)) {
        state.usage = { ...(state.usage ?? {}), ...parsed.usage };
      }
      return;
    }
    if (type === 'error') {
      const errorRecord = isRecord(parsed.error) ? parsed.error : undefined;
      state.error = {
        type: typeof errorRecord?.type === 'string' ? errorRecord.type : undefined,
        message:
          typeof errorRecord?.message === 'string'
            ? errorRecord.message
            : 'Anthropic-compatible stream reported an error.'
      };
    }
    // content_block_stop / message_stop / ping carry no state beyond the event log.
  } catch {
    state.events.push({
      type: 'parse_error',
      event: eventName,
      dataPreview: truncateText(data, 240)
    });
  }
}

function finalizeAnthropicToolUseInput(block: AnthropicContentBlockState): unknown {
  // Keep raw JSON strings when they don't parse — the adapter's lenient
  // argument repair gets a chance at them instead of silently dropping input.
  if (block.partialJson.trim()) {
    try {
      const parsed = JSON.parse(block.partialJson);
      return isRecord(parsed) ? parsed : block.partialJson;
    } catch {
      return block.partialJson;
    }
  }
  if (isRecord(block.initialInput) && Object.keys(block.initialInput).length > 0) {
    return block.initialInput;
  }
  return {};
}

/** Anthropic usage counts cached tokens separately; fold them back into the OpenAI-style prompt total. */
export function normalizeAnthropicMessagesUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const readCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const inputTokens = readCount(usage.input_tokens);
  const cacheReadTokens = readCount(usage.cache_read_input_tokens);
  const cacheCreationTokens = readCount(usage.cache_creation_input_tokens);
  const outputTokens = readCount(usage.output_tokens);
  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  if (promptTokens === 0 && outputTokens === 0) {
    return undefined;
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {})
  };
}

function finalizeAnthropicMessagesSseState(state: AnthropicMessagesSseState): AnthropicMessagesSseParseResult {
  const content = [...state.blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: finalizeAnthropicToolUseInput(block)
        };
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        return {
          type: 'thinking',
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {})
        };
      }
      return {
        type: 'text',
        text: block.text
      };
    })
    .filter((block) => block.type !== 'text' || (typeof block.text === 'string' && block.text.length > 0));

  return {
    text: state.text,
    reasoningContent: state.reasoningContent,
    responseBody: {
      id: state.id,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content,
      stop_reason: state.stopReason,
      stop_sequence: state.stopSequence,
      usage: state.usage,
      ...(state.error ? { error: { type: state.error.type, message: state.error.message } } : {}),
      stream: {
        eventCount: state.events.length,
        events: state.events.map(summarizeAnthropicSseEvent).slice(0, 80)
      }
    }
  };
}

export function parseAnthropicMessagesSseText(
  sseText: string,
  onDelta?: (delta: string, accumulated: string) => void,
  onReasoningDelta?: (delta: string, accumulated: string) => void
): AnthropicMessagesSseParseResult {
  let eventName = '';
  let dataLines: string[] = [];
  const state = createAnthropicMessagesSseState();

  for (const line of sseText.split(/\r?\n/)) {
    if (!line.trim()) {
      consumeAnthropicMessagesSseEvent(eventName, dataLines, state, onDelta, onReasoningDelta);
      dataLines = [];
      eventName = '';
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  consumeAnthropicMessagesSseEvent(eventName, dataLines, state, onDelta, onReasoningDelta);
  return finalizeAnthropicMessagesSseState(state);
}

function throwAnthropicMessagesStreamError(
  result: AnthropicMessagesSseParseResult,
  context: {
    requestUrl: string;
    requestBody: unknown;
  }
): void {
  const body = isRecord(result.responseBody) ? result.responseBody : undefined;
  const error = body && isRecord(body.error) ? body.error : undefined;
  if (!error) {
    return;
  }
  throw createApiError(
    typeof error.message === 'string' ? error.message : 'Anthropic-compatible stream reported an error.',
    {
      code: typeof error.type === 'string' ? error.type : undefined,
      apiMode: 'anthropic-messages',
      requestUrl: context.requestUrl,
      requestBody: context.requestBody,
      responseBody: result.responseBody
    }
  );
}

export async function postAnthropicMessagesStream(
  url: string,
  provider: AiProvider,
  body: unknown,
  abortSignal?: AbortSignal,
  onDelta?: (delta: string, accumulated: string) => void,
  onReasoningDelta?: (delta: string, accumulated: string) => void
): Promise<AnthropicMessagesSseParseResult> {
  const requestAbort = createProviderRequestAbort(abortSignal, provider);
  const requestSignal = requestAbort.signal;
  const chunkTimeoutMs = resolveProviderChunkTimeoutMs(provider);
  const requestInit = {
    method: 'POST',
    headers: buildAnthropicMessagesRequestHeaders(provider, 'text/event-stream, application/json'),
    body: JSON.stringify(body),
    signal: requestSignal
  } satisfies RequestInit;
  try {
    for (let attempt = 0; attempt <= HTTP_MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await fetchOpenAiCompatible(url, requestInit, {
          apiMode: 'anthropic-messages',
          requestBody: body,
          abortSignal: requestSignal,
          requestAbort
        });
      } catch (error) {
        rethrowProviderRequestTimeout(error, requestAbort, {
          apiMode: 'anthropic-messages',
          requestUrl: url,
          requestBody: body
        });
      }
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && response.body) {
        if (!response.ok) {
          const responseText = await response.text();
          const responseBody = parseMaybeJson(responseText);
          if (shouldRetryHttpResponse(response.status, responseBody) && attempt < HTTP_MAX_RETRIES) {
            await waitForRetry(
              computeHttpRetryDelayMs(attempt, readRetryAfterMs(response, responseBody)),
              requestSignal
            );
            continue;
          }
          throw createApiError(
            createHttpResponseErrorMessage(
              'Anthropic-compatible streaming request failed',
              response.status,
              responseBody,
              attempt
            ),
            {
              statusCode: response.status,
              code: readErrorCode(responseBody),
              apiMode: 'anthropic-messages',
              requestUrl: url,
              requestBody: body,
              responseBody
            }
          );
        }

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = '';
        let eventName = '';
        let dataLines: string[] = [];
        const state = createAnthropicMessagesSseState();

        const flush = (): void => {
          consumeAnthropicMessagesSseEvent(eventName, dataLines, state, onDelta, onReasoningDelta);
          dataLines = [];
          eventName = '';
        };

        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await readSseChunk(reader, {
              chunkTimeoutMs,
              abortSignal: requestSignal,
              apiMode: 'anthropic-messages',
              requestUrl: url,
              requestBody: body
            });
          } catch (error) {
            rethrowProviderRequestTimeout(error, requestAbort, {
              apiMode: 'anthropic-messages',
              requestUrl: url,
              requestBody: body
            });
          }
          const { done, value } = chunk;
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

          let separatorIndex = buffer.search(/\r?\n\r?\n/);
          while (separatorIndex >= 0) {
            const eventChunk = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === '\r' ? 4 : 2));
            for (const line of eventChunk.split(/\r?\n/)) {
              if (line.startsWith('event:')) {
                eventName = line.slice('event:'.length).trim();
                continue;
              }
              if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trimStart());
              }
            }
            flush();
            separatorIndex = buffer.search(/\r?\n\r?\n/);
          }

          if (done) {
            break;
          }
        }

        if (buffer.trim() || dataLines.length) {
          for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith('event:')) {
              eventName = line.slice('event:'.length).trim();
              continue;
            }
            if (line.startsWith('data:')) {
              dataLines.push(line.slice('data:'.length).trimStart());
            }
          }
          flush();
        }

        const result = finalizeAnthropicMessagesSseState(state);
        throwAnthropicMessagesStreamError(result, {
          requestUrl: url,
          requestBody: body
        });
        return result;
      }

      const responseText = await response.text();
      const responseBody = parseMaybeJson(responseText);
      if (!response.ok) {
        if (shouldRetryHttpResponse(response.status, responseBody) && attempt < HTTP_MAX_RETRIES) {
          await waitForRetry(computeHttpRetryDelayMs(attempt, readRetryAfterMs(response, responseBody)), requestSignal);
          continue;
        }
        throw createApiError(
          createHttpResponseErrorMessage(
            'Anthropic-compatible streaming request failed',
            response.status,
            responseBody,
            attempt
          ),
          {
            statusCode: response.status,
            code: readErrorCode(responseBody),
            apiMode: 'anthropic-messages',
            requestUrl: url,
            requestBody: body,
            responseBody
          }
        );
      }

      if (
        contentType.includes('text/event-stream') ||
        responseText.includes('\nevent:') ||
        responseText.startsWith('event:')
      ) {
        const result = parseAnthropicMessagesSseText(responseText, onDelta, onReasoningDelta);
        throwAnthropicMessagesStreamError(result, {
          requestUrl: url,
          requestBody: body
        });
        return result;
      }

      return {
        text: extractTextFromAnthropicMessageBody(responseBody),
        reasoningContent: extractReasoningFromAnthropicMessageBody(responseBody),
        responseBody
      };
    }

    throw createApiError('Anthropic-compatible streaming request failed after retry attempts.', {
      apiMode: 'anthropic-messages',
      requestUrl: url,
      requestBody: body
    });
  } finally {
    requestAbort.dispose();
  }
}

export function extractTextFromAnthropicMessageBody(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return '';
  }
  return body.content
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

export function extractReasoningFromAnthropicMessageBody(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return '';
  }
  return body.content
    .map((block) =>
      isRecord(block) &&
      (block.type === 'thinking' || block.type === 'redacted_thinking') &&
      typeof block.thinking === 'string'
        ? block.thinking
        : ''
    )
    .join('\n')
    .trim();
}
