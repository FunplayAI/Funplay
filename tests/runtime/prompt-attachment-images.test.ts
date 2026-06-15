import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelMessagesFromChat } from '../../electron/main/agent-platform/model-message-builder.ts';
import { convertModelMessagesToOpenAiCompatible } from '../../electron/main/agent-platform/native/tool-loop-message-adapter.ts';
import type { ChatMessage } from '../../shared/types.ts';

/**
 * D — submit-time image attachments are inlined into native model context for
 * vision-capable models (AI-SDK image parts + the OpenAI-compatible `images`
 * field), and left as a text-only listing otherwise.
 */

function userWithImage(): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'look at this',
    metadata: {
      promptAttachments: [
        {
          id: 'a1',
          name: 'shot.png',
          path: '/tmp/shot.png',
          mimeType: 'image/png',
          kind: 'image',
          size: 3,
          previewDataUrl: 'data:image/png;base64,AAAA'
        }
      ]
    }
  } as unknown as ChatMessage;
}

function imagePartsOf(content: unknown): Array<{ image: unknown; mediaType: unknown }> {
  return Array.isArray(content)
    ? (content.filter(
        (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'image'
      ) as Array<{ image: unknown; mediaType: unknown }>)
    : [];
}

test('vision model: an image attachment is inlined as an image part', async () => {
  const messages = await buildModelMessagesFromChat([userWithImage()], { visionEnabled: true });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  const images = imagePartsOf(messages[0].content);
  assert.equal(images.length, 1);
  assert.equal(images[0].image, 'AAAA'); // base64 stripped from the data URL
  assert.equal(images[0].mediaType, 'image/png');
  // the text (prompt + attachment listing) is preserved alongside the image
  const text = Array.isArray(messages[0].content)
    ? messages[0].content.find((part) => (part as { type?: string }).type === 'text')
    : undefined;
  assert.match((text as { text: string }).text, /look at this/);
});

test('non-vision model: the image is left as a text listing only (no image part)', async () => {
  const messages = await buildModelMessagesFromChat([userWithImage()], { visionEnabled: false });
  assert.equal(messages.length, 1);
  assert.equal(typeof messages[0].content, 'string');
  assert.match(messages[0].content as string, /shot\.png/);
});

test('OpenAI-compatible converter surfaces the inlined image in the images field', async () => {
  const messages = await buildModelMessagesFromChat([userWithImage()], { visionEnabled: true });
  const converted = convertModelMessagesToOpenAiCompatible(messages);
  const userMessage = converted.find((message) => message.role === 'user') as
    | { content: string; images?: Array<{ mimeType: string; dataBase64: string }> }
    | undefined;
  assert.ok(userMessage);
  assert.equal(userMessage?.images?.length, 1);
  assert.equal(userMessage?.images?.[0].mimeType, 'image/png');
  assert.equal(userMessage?.images?.[0].dataBase64, 'AAAA');
});

test('non-image attachments are never inlined as image parts', async () => {
  const fileMessage = {
    id: 'm2',
    role: 'user',
    content: 'a doc',
    metadata: {
      promptAttachments: [
        { id: 'a2', name: 'notes.txt', path: '/tmp/notes.txt', mimeType: 'text/plain', kind: 'file', size: 5 }
      ]
    }
  } as unknown as ChatMessage;
  const messages = await buildModelMessagesFromChat([fileMessage], { visionEnabled: true });
  assert.equal(typeof messages[0].content, 'string'); // no image part → stays text
});
