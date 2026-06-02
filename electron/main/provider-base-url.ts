/**
 * Provider base-URL normalization. Users often paste the full endpoint
 * (.../v1/messages for Anthropic, .../v1/chat/completions for OpenAI-compatible).
 * The SDK / protocol adapters append that path segment themselves, so a pasted
 * endpoint would double up (.../messages/messages,
 * .../chat/completions/chat/completions). These helpers strip the trailing
 * endpoint so either form works.
 */

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Normalize an Anthropic Messages base URL. @ai-sdk/anthropic appends
 * "/messages" itself, so the base URL must stop at /v1. Strips a pasted
 * /messages suffix and fills in /v1 for a bare host.
 */
export function normalizeAnthropicBaseUrl(url: string): string {
  let cleaned = trimTrailingSlashes(url.trim());
  if (!cleaned) {
    return 'https://api.anthropic.com/v1';
  }
  cleaned = trimTrailingSlashes(cleaned.replace(/\/messages$/i, ''));
  if (cleaned.endsWith('/v1')) {
    return cleaned;
  }
  try {
    const parsed = new URL(cleaned);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return `${cleaned}/v1`;
    }
  } catch {
    return cleaned;
  }
  return cleaned;
}

/**
 * Strip a pasted OpenAI endpoint suffix. The protocol adapters append
 * "/chat/completions" or "/responses" themselves, so the base URL must stop
 * before it.
 */
export function stripOpenAiCompatibleEndpointSuffix(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl).replace(/\/(chat\/completions|responses)$/i, '');
}
