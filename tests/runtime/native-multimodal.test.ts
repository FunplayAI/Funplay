import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectToolResultImageParts,
  loadImagePartFromMediaBlock,
  resolveModelVisionEnabled,
  MAX_IMAGE_PART_BYTES
} from '../../electron/main/agent-platform/native/multimodal.ts';
import {
  ChatCompletionsAdapter,
  ResponsesAdapter,
  AnthropicMessagesAdapter
} from '../../electron/main/openai-compatible-adapters.ts';
import type { AiProvider, ChatMediaBlock } from '../../shared/types/index.ts';
import type {
  OpenAiCompatibleToolStepRequest,
  OpenAiCompatibleToolMessage,
  OpenAiCompatibleImagePart
} from '../../electron/main/openai-compatible-types.ts';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'p1',
    name: 'Test',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    authStyle: 'api_key',
    ...overrides
  } as AiProvider;
}

function visionProvider(): AiProvider {
  return provider({
    model: 'vision-model',
    availableModels: [{ modelId: 'vision-model', displayName: 'Vision', capabilities: { vision: true } }]
  });
}

function imagePart(): OpenAiCompatibleImagePart {
  return { mimeType: 'image/png', dataBase64: PNG_BASE64 };
}

function stepRequest(
  messages: OpenAiCompatibleToolMessage[],
  p: AiProvider = provider()
): OpenAiCompatibleToolStepRequest {
  return { provider: p, model: p.model, system: 'sys', messages, tools: [], maxOutputTokens: 1024 };
}

test('resolveModelVisionEnabled reflects the catalog capability', () => {
  assert.equal(resolveModelVisionEnabled(visionProvider()), true);
  assert.equal(resolveModelVisionEnabled(provider()), false);
  assert.equal(resolveModelVisionEnabled(undefined), false);
});

test('loadImagePartFromMediaBlock decodes inline data and reads localPath', async () => {
  const inline = await loadImagePartFromMediaBlock({
    type: 'image',
    mimeType: 'image/png',
    data: `data:image/png;base64,${PNG_BASE64}`
  });
  assert.equal(inline?.mimeType, 'image/png');
  assert.equal(inline?.dataBase64, PNG_BASE64);

  const dir = await mkdtemp(join(tmpdir(), 'funplay-img-'));
  try {
    const file = join(dir, 'pixel.png');
    await writeFile(file, Buffer.from(PNG_BASE64, 'base64'));
    const fromDisk = await loadImagePartFromMediaBlock({ type: 'image', mimeType: 'image/png', localPath: file });
    assert.equal(fromDisk?.dataBase64, PNG_BASE64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadImagePartFromMediaBlock rejects non-images, unsupported mime, and oversized data', async () => {
  assert.equal(await loadImagePartFromMediaBlock({ type: 'audio', mimeType: 'audio/mp3', data: 'x' }), undefined);
  assert.equal(
    await loadImagePartFromMediaBlock({ type: 'image', mimeType: 'image/tiff', data: PNG_BASE64 }),
    undefined
  );
  const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_PART_BYTES + 1024) / 3) * 4);
  assert.equal(await loadImagePartFromMediaBlock({ type: 'image', mimeType: 'image/png', data: huge }), undefined);
  // image/jpg normalizes to image/jpeg
  const jpg = await loadImagePartFromMediaBlock({ type: 'image', mimeType: 'image/jpg', data: PNG_BASE64 });
  assert.equal(jpg?.mimeType, 'image/jpeg');
});

test('collectToolResultImageParts caps at two images and counts drops', async () => {
  const media: ChatMediaBlock[] = [
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    { type: 'image', mimeType: 'image/tiff', data: PNG_BASE64 }
  ];
  const { parts, droppedCount } = await collectToolResultImageParts(media);
  assert.equal(parts.length, 2);
  assert.equal(droppedCount, 2);
});

test('chat adapter serializes a user image into image_url content parts', () => {
  const body = new ChatCompletionsAdapter().serializeToolStepRequest(
    stepRequest([{ role: 'user', content: 'look', images: [imagePart()] }], visionProvider())
  ) as { messages: Array<{ role: string; content: unknown }> };
  const user = body.messages.find((m) => m.role === 'user');
  assert.ok(Array.isArray(user?.content));
  const parts = user?.content as Array<Record<string, unknown>>;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.match((parts[1].image_url as { url: string }).url, /^data:image\/png;base64,/);
});

test('responses adapter serializes a user image into input_image', () => {
  const body = new ResponsesAdapter().serializeToolStepRequest(
    stepRequest([{ role: 'user', content: 'look', images: [imagePart()] }], visionProvider())
  ) as { input: Array<{ role?: string; content?: Array<Record<string, unknown>> }> };
  const user = body.input.find((item) => item.role === 'user');
  const types = (user?.content ?? []).map((part) => part.type);
  assert.deepEqual(types, ['input_text', 'input_image']);
});

test('anthropic-messages adapter serializes a user image into a base64 image block', () => {
  const body = new AnthropicMessagesAdapter().serializeToolStepRequest(
    stepRequest([{ role: 'user', content: 'look', images: [imagePart()] }], visionProvider())
  ) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  const user = body.messages.find((m) => m.role === 'user');
  const image = user?.content.find((block) => block.type === 'image');
  assert.equal((image?.source as { type: string; media_type: string }).type, 'base64');
  assert.equal((image?.source as { media_type: string }).media_type, 'image/png');
});

test('messages without images serialize as plain string content (no regression)', () => {
  const body = new ChatCompletionsAdapter().serializeToolStepRequest(
    stepRequest([{ role: 'user', content: 'plain' }])
  ) as { messages: Array<{ role: string; content: unknown }> };
  const user = body.messages.find((m) => m.role === 'user');
  assert.equal(user?.content, 'plain');
});
