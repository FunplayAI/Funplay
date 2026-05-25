import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAssetGenerationProvider,
  deleteAssetGenerationProvider,
  generateAssetForProject,
  importGeneratedAsset,
  listAssetGenerationProviders,
  updateAssetGenerationProvider
} from '../../electron/main/asset-generation-service.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { buildProject, buildState } from './test-helpers.ts';

test('asset generation service creates project files and updates the project ledger', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { b64_json: Buffer.from('fake-png-a').toString('base64') },
      { b64_json: Buffer.from('fake-png-b').toString('base64') }
    ]
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json'
    }
  })) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-asset-gen-'));
  const project = buildProject(root);
  const state = buildState(project);
  const providers = listAssetGenerationProviders(state);

  assert.equal(providers.find((provider) => provider.id === 'openai-image')?.enabled, true);

  const updated = await generateAssetForProject(state, project.id, {
    title: 'Bird Rescue Sprite',
    kind: 'image_2d',
    prompt: 'Cute yellow bird sprite for a rescue puzzle game',
    providerId: 'openai-image',
    outputSpec: {
      width: 1024,
      height: 1024,
      transparentBackground: true
    },
    count: 2,
    createdBy: 'user'
  });

  const job = updated.assetGenerationJobs?.[0];
  assert.equal(job?.status, 'completed');
  assert.equal(job.outputs.length, 2);
  assert.equal(updated.assets[0].generationJobId, job.id);
  assert.deepEqual(updated.assets[0].outputPaths, job.outputs.map((output) => output.path));

  const firstOutput = job.outputs[0];
  assert.match(firstOutput.path, /^assets\/generated\/images\//);
  assert.doesNotMatch(firstOutput.path, /-asset_jo\./);
  assert.match(firstOutput.path, /bird-rescue-sprite\.png$/);
  assert.match(job.outputs[1].path, /bird-rescue-sprite_1\.png$/);
  assert.equal(firstOutput.mimeType, 'image/png');
  assert.equal(firstOutput.width, 1024);
  assert.equal(firstOutput.height, 1024);
  const body = await readFile(join(root, firstOutput.path), 'utf8');
  assert.equal(body, 'fake-png-a');

  const imported = importGeneratedAsset(state, project.id, job.id);
  assert.ok(imported.assetGenerationJobs?.[0]?.outputs.every((output) => Boolean(output.importedAt)));
});

test('asset generation service publishes progress snapshots during generation', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { b64_json: Buffer.from('fake-progress-png').toString('base64') }
    ]
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json'
    }
  })) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-asset-progress-'));
  const project = buildProject(root);
  const state = buildState(project);
  const snapshots: Array<{ status: string; progress: number; outputs: number }> = [];

  const updated = await generateAssetForProject(state, project.id, {
    title: 'Progress Bird',
    kind: 'image_2d',
    prompt: 'Cute bird progress sprite',
    providerId: 'openai-image',
    createdBy: 'user'
  }, {
    onProjectUpdate: (projectSnapshot) => {
      const job = projectSnapshot.assetGenerationJobs?.at(-1);
      if (job) {
        snapshots.push({
          status: job.status,
          progress: job.progress,
          outputs: job.outputs.length
        });
      }
    }
  });

  assert.equal(updated.assetGenerationJobs?.[0]?.status, 'completed');
  assert.ok(snapshots.some((snapshot) => snapshot.status === 'queued' && snapshot.progress < 0.1));
  assert.ok(snapshots.some((snapshot) => snapshot.status === 'running' && snapshot.progress >= 0.2 && snapshot.progress < 1));
  assert.ok(snapshots.some((snapshot) => snapshot.status === 'completed' && snapshot.progress === 1));
  assert.ok(snapshots.some((snapshot) => snapshot.outputs === 1));
});

test('asset generation service keeps concurrent jobs and output names isolated', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  let callCount = 0;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = (async () => {
    callCount += 1;
    const callIndex = callCount;
    await new Promise((resolve) => setTimeout(resolve, callIndex === 1 ? 15 : 0));
    return new Response(JSON.stringify({
      data: [
        { b64_json: Buffer.from(`fake-concurrent-png-${callIndex}`).toString('base64') }
      ]
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-asset-concurrent-'));
  const project = buildProject(root);
  const state = buildState(project);

  await Promise.all([
    generateAssetForProject(state, project.id, {
      title: 'Shared Bird',
      kind: 'image_2d',
      prompt: 'Cute bird sprite A',
      providerId: 'openai-image',
      createdBy: 'user'
    }),
    generateAssetForProject(state, project.id, {
      title: 'Shared Bird',
      kind: 'image_2d',
      prompt: 'Cute bird sprite B',
      providerId: 'openai-image',
      createdBy: 'user'
    })
  ]);

  const latest = state.projects[0];
  const jobs = latest.assetGenerationJobs ?? [];
  const paths = jobs.flatMap((job) => job.outputs.map((output) => output.path)).sort();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.every((job) => job.status === 'completed'), true);
  assert.equal(latest.assets.length, 2);
  assert.deepEqual(paths.map((path) => path.split('/').at(-1)), ['shared-bird.png', 'shared-bird_1.png']);
});

test('Replicate generation reports remote prediction progress while polling', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.REPLICATE_API_TOKEN;
  const originalModel = process.env.FUNPLAY_REPLICATE_MODEL;
  const originalPollInterval = process.env.FUNPLAY_ASSET_GENERATION_POLL_INTERVAL_MS;
  let statusPolls = 0;

  process.env.REPLICATE_API_TOKEN = 'test-replicate-token';
  process.env.FUNPLAY_REPLICATE_MODEL = 'owner/model';
  process.env.FUNPLAY_ASSET_GENERATION_POLL_INTERVAL_MS = '1';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/models/owner/model/predictions')) {
      return new Response(JSON.stringify({
        id: 'pred_1',
        status: 'starting',
        urls: {
          get: 'https://replicate.test/predictions/pred_1'
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }
    if (url === 'https://replicate.test/predictions/pred_1') {
      statusPolls += 1;
      return new Response(JSON.stringify(statusPolls === 1 ? {
        id: 'pred_1',
        status: 'processing',
        progress: 0.5,
        urls: {
          get: 'https://replicate.test/predictions/pred_1'
        }
      } : {
        id: 'pred_1',
        status: 'succeeded',
        output: ['https://replicate.test/output.png']
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }
    if (url === 'https://replicate.test/output.png') {
      return new Response(Buffer.from('replicate-png'), {
        status: 200,
        headers: {
          'content-type': 'image/png'
        }
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.REPLICATE_API_TOKEN;
    } else {
      process.env.REPLICATE_API_TOKEN = originalToken;
    }
    if (originalModel === undefined) {
      delete process.env.FUNPLAY_REPLICATE_MODEL;
    } else {
      process.env.FUNPLAY_REPLICATE_MODEL = originalModel;
    }
    if (originalPollInterval === undefined) {
      delete process.env.FUNPLAY_ASSET_GENERATION_POLL_INTERVAL_MS;
    } else {
      process.env.FUNPLAY_ASSET_GENERATION_POLL_INTERVAL_MS = originalPollInterval;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-replicate-progress-'));
  const project = buildProject(root);
  const state = buildState(project);
  const snapshots: Array<{ progress: number; remoteJobId?: string }> = [];

  const updated = await generateAssetForProject(state, project.id, {
    title: 'Replicate Bird',
    kind: 'image_2d',
    prompt: 'Replicate bird sprite',
    providerId: 'replicate-asset',
    createdBy: 'user'
  }, {
    onProjectUpdate: (projectSnapshot) => {
      const job = projectSnapshot.assetGenerationJobs?.at(-1);
      if (job) {
        snapshots.push({
          progress: job.progress,
          remoteJobId: job.remoteJobId
        });
      }
    }
  });

  const job = updated.assetGenerationJobs?.[0];
  assert.equal(job?.status, 'completed');
  assert.equal(job?.remoteJobId, 'pred_1');
  assert.ok(snapshots.some((snapshot) => snapshot.remoteJobId === 'pred_1' && snapshot.progress >= 0.5 && snapshot.progress < 0.82));
  assert.equal(await readFile(join(root, job!.outputs[0].path), 'utf8'), 'replicate-png');
});

test('generate_asset native tool persists through the shared asset generation pipeline', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
  globalThis.fetch = (async () => new Response(Buffer.from('fake-mp3-tool'), {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg'
    }
  })) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-asset-tool-'));
  const project = buildProject(root);
  const state = buildState(project);
  let persisted = false;
  const result = await executeAgentToolAction(project, {
    type: 'generate_asset',
    title: 'Nest Repair SFX',
    kind: 'audio_sfx',
    prompt: 'Short cheerful wooden nest repair tap sound',
    providerId: 'elevenlabs-audio',
    durationSeconds: 0.5
  }, {
    appState: state,
    persistAppState: async () => {
      persisted = true;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(persisted, true);
  assert.match(result.summary, /Asset generation: completed/);
  assert.equal(result.changedFiles?.length, 1);
  const outputPath = result.changedFiles?.[0]?.path;
  assert.ok(outputPath);
  assert.match(outputPath, /^assets\/generated\/audio\//);
  const fileStat = await stat(join(root, outputPath));
  assert.ok(fileStat.size > 0);
});

test('asset generation service calls OpenAI image provider when configured', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiModel = process.env.FUNPLAY_OPENAI_IMAGE_MODEL;
  const requests: Array<{ url: string; body: unknown }> = [];

  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.FUNPLAY_OPENAI_IMAGE_MODEL = 'gpt-image-2';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return new Response(JSON.stringify({
      data: [{
        b64_json: Buffer.from('fake-png').toString('base64'),
        revised_prompt: 'revised'
      }]
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalOpenAiModel === undefined) {
      delete process.env.FUNPLAY_OPENAI_IMAGE_MODEL;
    } else {
      process.env.FUNPLAY_OPENAI_IMAGE_MODEL = originalOpenAiModel;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-openai-asset-'));
  const project = buildProject(root);
  const state = buildState(project);
  const providers = listAssetGenerationProviders(state);
  assert.equal(providers.find((provider) => provider.id === 'openai-image')?.enabled, true);

  const updated = await generateAssetForProject(state, project.id, {
    title: 'Generated Bird UI',
    kind: 'ui_2d',
    prompt: 'Cute game UI button with bird nest motif',
    providerId: 'openai-image',
    outputSpec: {
      width: 1024,
      height: 1024,
      format: 'png'
    },
    createdBy: 'user'
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal((requests[0].body as Record<string, unknown>).model, 'gpt-image-2');
  const output = updated.assetGenerationJobs?.[0]?.outputs[0];
  assert.equal(output?.format, 'png');
  assert.equal(output?.mimeType, 'image/png');
  assert.equal(await readFile(join(root, output!.path), 'utf8'), 'fake-png');
});

test('configured asset providers are persisted in state and drive generation', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const requests: Array<{ url: string; authorization?: string; body: unknown }> = [];

  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: init?.headers instanceof Headers
        ? init.headers.get('authorization') ?? undefined
        : (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return new Response(JSON.stringify({
      data: [{
        b64_json: Buffer.from('configured-provider-png').toString('base64')
      }]
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-configured-openai-'));
  const project = buildProject(root);
  const state = buildState(project);
  const created = await createAssetGenerationProvider(state, {
    name: 'Configured OpenAI Images',
    adapter: 'openai-image',
    enabled: true,
    baseUrl: 'https://images.example.test/v1',
    apiKey: 'configured-key',
    model: 'gpt-image-2',
    notes: 'configured in app settings'
  });

  const providers = listAssetGenerationProviders(state);
  const profile = providers.find((provider) => provider.id === created.id);
  assert.equal(profile?.enabled, true);
  assert.equal(profile?.endpointLabel, 'https://images.example.test/v1');
  assert.equal(JSON.stringify(profile).includes('configured-key'), false);

  const updated = await generateAssetForProject(state, project.id, {
    title: 'Configured Bird',
    kind: 'image_2d',
    prompt: 'Bird generated from configured provider',
    providerId: created.id,
    createdBy: 'user'
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://images.example.test/v1/images/generations');
  assert.equal(requests[0].authorization, 'Bearer configured-key');
  assert.equal((requests[0].body as Record<string, unknown>).model, 'gpt-image-2');
  const output = updated.assetGenerationJobs?.[0]?.outputs[0];
  assert.equal(await readFile(join(root, output!.path), 'utf8'), 'configured-provider-png');

  const disabled = await updateAssetGenerationProvider(state, created.id, {
    name: created.name,
    adapter: created.adapter,
    enabled: false,
    baseUrl: created.baseUrl,
    apiKey: '',
    model: created.model,
    notes: created.notes
  });
  assert.equal(disabled.apiKey, 'configured-key');
  assert.equal(listAssetGenerationProviders(state).find((provider) => provider.id === created.id)?.enabled, false);

  await deleteAssetGenerationProvider(state, created.id);
  assert.equal(state.assetGenerationProviders.length, 0);
});

test('OpenAI-compatible image providers accept root, v1, and full endpoint base URLs', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const requests: string[] = [];

  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      data: [{
        b64_json: Buffer.from(`configured-provider-png-${requests.length}`).toString('base64')
      }]
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-openai-compatible-'));
  const project = buildProject(root);
  const state = buildState(project);
  const cases = [
    ['Packy Root', 'https://www.packyapi.com'],
    ['Packy V1', 'https://www.packyapi.com/v1'],
    ['Packy Full Endpoint', 'https://www.packyapi.com/v1/images/generations']
  ] as const;

  for (const [name, baseUrl] of cases) {
    const created = await createAssetGenerationProvider(state, {
      name,
      adapter: 'openai-image',
      enabled: true,
      baseUrl,
      apiKey: 'configured-key',
      model: 'gpt-image-2'
    });

    await generateAssetForProject(state, project.id, {
      title: name,
      kind: 'image_2d',
      prompt: `Bird generated from ${name}`,
      providerId: created.id,
      createdBy: 'user'
    });
  }

  assert.deepEqual(requests, [
    'https://www.packyapi.com/v1/images/generations',
    'https://www.packyapi.com/v1/images/generations',
    'https://www.packyapi.com/v1/images/generations'
  ]);
});

test('asset image generation rejects invalid dimensions before provider request', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  let fetchCount = 0;

  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({
      data: [{
        b64_json: Buffer.from('should-not-run').toString('base64')
      }]
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-invalid-dimensions-'));
  const project = buildProject(root);
  const state = buildState(project);

  await assert.rejects(
    () => generateAssetForProject(state, project.id, {
      title: 'Invalid Bird',
      kind: 'image_2d',
      prompt: 'Cute bird asset',
      providerId: 'openai-image',
      outputSpec: {
        width: 513,
        height: 1024
      },
      createdBy: 'user'
    }),
    /16px 的倍数/
  );
  assert.equal(fetchCount, 0);
  assert.equal(state.projects[0].assetGenerationJobs?.length ?? 0, 0);
});

test('OpenAI-compatible image provider gateway HTML errors are compacted for the job log', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = (async () => new Response(`<!DOCTYPE html>
<html lang="en-US">
  <head><title>packyapi.com | 504: Gateway time-out</title></head>
  <body>
    <h1>Gateway time-out</h1>
    <span class="code-label">Error code 504</span>
    <p>Cloudflare could not reach the origin.</p>
  </body>
</html>`, {
    status: 504,
    statusText: 'Gateway time-out',
    headers: {
      'content-type': 'text/html; charset=UTF-8'
    }
  })) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-openai-gateway-'));
  const project = buildProject(root);
  const state = buildState(project);
  const created = await createAssetGenerationProvider(state, {
    name: 'Packy Images',
    adapter: 'openai-image',
    enabled: true,
    baseUrl: 'https://www.packyapi.com/v1',
    apiKey: 'configured-key',
    model: 'gpt-image-2'
  });

  const updated = await generateAssetForProject(state, project.id, {
    title: 'Gateway Timeout Bird',
    kind: 'image_2d',
    prompt: 'Cute bird asset',
    providerId: created.id,
    createdBy: 'user'
  });

  const job = updated.assetGenerationJobs?.[0];
  assert.equal(job?.status, 'failed');
  assert.match(job?.error ?? '', /OpenAI image generation failed \(504 Gateway time-out\)/);
  assert.match(job?.error ?? '', /Provider gateway timed out/);
  assert.doesNotMatch(job?.error ?? '', /<!DOCTYPE html|<html|cf-wrapper|Cloudflare could not reach/i);
  assert.ok((job?.error ?? '').length < 260);
});

test('asset generation service calls ElevenLabs sound provider when configured', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  const requests: Array<{ url: string; body: unknown }> = [];

  process.env.ELEVENLABS_API_KEY = 'test-elevenlabs-key';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return new Response(Buffer.from('fake-mp3'), {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'character-cost': '12'
      }
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = originalKey;
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'funplay-elevenlabs-asset-'));
  const project = buildProject(root);
  const state = buildState(project);
  const updated = await generateAssetForProject(state, project.id, {
    title: 'Nest Repair Tap',
    kind: 'audio_sfx',
    prompt: 'A short wooden nest repair tap',
    providerId: 'elevenlabs-audio',
    outputSpec: {
      durationSeconds: 1
    },
    createdBy: 'user'
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /https:\/\/api\.elevenlabs\.io\/v1\/sound-generation/);
  assert.equal((requests[0].body as Record<string, unknown>).text, 'A short wooden nest repair tap');
  const output = updated.assetGenerationJobs?.[0]?.outputs[0];
  assert.equal(output?.format, 'mp3');
  assert.equal(output?.mimeType, 'audio/mpeg');
  assert.equal(await readFile(join(root, output!.path), 'utf8'), 'fake-mp3');
});
