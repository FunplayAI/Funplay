import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rendererEntry = resolve(repoRoot, 'out/renderer/index.html');
const reportDir = resolve(repoRoot, 'out/desktop-ui-electron-smoke');
const reportPath = resolve(reportDir, 'latest-report.md');
const artifactDir = resolve(reportDir, 'artifacts');
const realisticArtifactDir = resolve(artifactDir, 'realistic');
const preloadPath = join(tmpdir(), `funplay-ui-smoke-preload-${Date.now()}.cjs`);
const rendererMessages = [];

if (!existsSync(rendererEntry)) {
  console.error('Built renderer not found. Run `npm run build` before `npm run ui:electron-smoke`.');
  app.exit(1);
  process.exit(1);
}

// --- Stale-bundle guard ----------------------------------------------------
// ui:electron-smoke loads the prebuilt out/renderer via loadFile and does NOT
// build it. If any source under src/ or shared/ is newer than the bundle, the
// captured screenshots and DOM/layout/a11y assertions silently reflect OUTDATED
// UI (this exact trap cost real debugging time). Fail fast instead of testing
// a stale build by accident.
function newestMtimeUnder(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeUnder(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const bundleMtime = statSync(rendererEntry).mtimeMs;
let newestSrcMtime = 0;
for (const dirName of ['src', 'shared']) {
  const sourceDir = resolve(repoRoot, dirName);
  if (existsSync(sourceDir)) {
    newestSrcMtime = Math.max(newestSrcMtime, newestMtimeUnder(sourceDir));
  }
}
if (newestSrcMtime > bundleMtime) {
  const staleSeconds = Math.round((newestSrcMtime - bundleMtime) / 1000);
  console.error(
    `Renderer bundle is STALE: out/renderer is ${staleSeconds}s older than the newest file under src/ or shared/.\n` +
      'ui:electron-smoke loads the prebuilt bundle (loadFile) and does NOT build it — you would be testing outdated UI.\n' +
      'Run `npm run build` (or `npx electron-vite build`) first, then re-run `npm run ui:electron-smoke`.'
  );
  app.exit(1);
  process.exit(1);
}

const now = new Date().toISOString();
const richMarkdownFixture = [
  'UI smoke assistant message 02:',
  '',
  '# 一级标题 Heading 1',
  '这是一段正文,包含 **加粗**、*斜体*、`inline code` 和一个 [外部链接](https://example.com)。这一行后面是模型自己软换行的位置,',
  '下一行原本应该和上一行连成同一段,在容器边缘自然换行,而不是在模型折行处被硬断开。',
  '再补一句让段落更长一些,确认软换行折叠成空格、整段顺畅流动。',
  '',
  '```ts',
  'function greet(name: string): string {',
  "  const greeting = 'Hello, ' + name;",
  '  return greeting;',
  '}',
  '```',
  '',
  '> 这是一段引用块,用来检查引用样式与左侧强调边。',
  '',
  '| 列 A | 列 B | 列 C |',
  '| --- | --- | --- |',
  '| 1 | 一 | alpha |',
  '| 2 | 二 | beta |',
  '',
  '## 二级标题 Heading 2',
  '- 无序列表第一项',
  '- 第二项,带 `code`',
  '- 第三项,稍微长一点的文字看缩进对齐',
  '',
  '### 三级标题 Heading 3',
  '1. 有序第一步',
  '2. 有序第二步',
  '3. 有序第三步'
].join('\n');
const smokeChatMessages = Array.from({ length: 36 }, (_item, index) => {
  const ordinal = index + 1;
  const role = index % 2 === 0 ? 'user' : 'assistant';
  const baseContent = `${role === 'user' ? 'UI smoke user message' : 'UI smoke assistant message'} ${String(ordinal).padStart(2, '0')}: ${'This long transcript fixture verifies the chat scroll container keeps working after UI platform migrations. '.repeat(5)}`;
  return {
    id: `ui_smoke_message_${ordinal}`,
    role,
    content: role === 'assistant' && ordinal === 2 ? richMarkdownFixture : baseContent,
    createdAt: new Date(Date.now() - (36 - ordinal) * 60_000).toISOString(),
    ordinal
  };
});
const project = {
  id: 'ui_smoke_project',
  name: 'Rogue UI Smoke',
  templateId: 'generic-workspace',
  artStyle: 'test',
  pitch: 'UI regression fixture',
  status: 'active',
  engine: {
    platform: 'web',
    setupMode: 'import',
    projectPath: '/tmp/funplay-ui-smoke',
    dimension: 'unknown'
  },
  runtimeState: {
    checkedAt: now,
    projectExists: true,
    unityProjectValid: false,
    projectOpen: false,
    bridgeInstalled: false,
    bridgeHealth: {
      status: 'offline',
      message: 'UI smoke fixture'
    }
  },
  agentPolicy: {
    permissionMode: 'full-access',
    skills: []
  },
  mcpBindings: {},
  createdAt: now,
  updatedAt: now,
  blueprint: {
    premise: '',
    playerFantasy: '',
    targetAudience: '',
    artDirection: '',
    coreLoop: [],
    pillars: [],
    differentiators: []
  },
  tasks: [],
  assets: [],
  sessions: [{
    id: 'ui_smoke_session',
    title: '主会话',
    autoTitle: false,
    createdAt: now,
    updatedAt: now,
    runtimeOverrides: {
      runtimeId: 'native',
      providerId: 'provider_mimo',
      model: 'mimo-v2.5-pro',
      permissionMode: 'full-access',
      effort: 'auto'
    },
    chat: []
  }, {
    id: 'ui_smoke_empty_session',
    title: '空会话',
    autoTitle: false,
    createdAt: now,
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    runtimeOverrides: {
      runtimeId: 'native',
      providerId: 'provider_mimo',
      model: 'mimo-v2.5-pro',
      permissionMode: 'full-access',
      effort: 'auto'
    },
    chat: []
  }],
  activeSessionId: 'ui_smoke_session',
  chat: smokeChatMessages,
  activity: [],
  snapshots: [],
  memory: {
    designDirectives: [],
    artDirectives: [],
    technicalConstraints: [],
    openQuestions: [],
    updatedAt: now
  },
  contextSummary: {
    projectBrief: 'UI smoke fixture',
    currentGoal: 'Verify desktop UI routes',
    recentDecisions: [],
    activeTasks: [],
    recentActivity: [],
    compressedFrom: 0,
    updatedAt: now
  }
};

const provider = {
  id: 'provider_mimo',
  name: 'Xiaomi MiMo',
  protocol: 'openai-compatible',
  apiMode: 'chat',
  authStyle: 'api_key',
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  apiKey: '',
  hasStoredApiKey: true,
  model: 'mimo-v2.5-pro',
  enabled: true,
  isDefault: true,
  createdAt: now,
  updatedAt: now
};

const assetGenerationProviderConfig = {
  id: 'asset_provider_openai',
  name: 'OpenAI Images',
  adapter: 'openai-image',
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  hasStoredApiKey: true,
  model: 'gpt-image-2',
  notes: 'UI smoke fixture provider',
  createdAt: now,
  updatedAt: now
};

const assetGenerationProviderProfile = {
  id: assetGenerationProviderConfig.id,
  name: assetGenerationProviderConfig.name,
  adapter: assetGenerationProviderConfig.adapter,
  enabled: true,
  capabilities: ['image.generate', 'ui.generate', 'texture.generate'],
  supportedKinds: ['image_2d', 'ui_2d', 'texture_2d'],
  modelLabel: 'gpt-image-2',
  endpointLabel: 'api.openai.com',
  notes: 'UI smoke fixture provider',
  requiresNetwork: true,
  supportsAsyncJobs: false
};

const assetGenerationJob = {
  id: 'asset_job_smoke',
  projectId: project.id,
  title: 'Smoke sprite',
  kind: 'image_2d',
  prompt: 'A clean tiny game sprite for UI smoke.',
  providerId: assetGenerationProviderProfile.id,
  providerName: assetGenerationProviderProfile.name,
  providerAdapter: assetGenerationProviderProfile.adapter,
  references: [],
  outputSpec: { format: 'png', width: 1024, height: 1024 },
  status: 'running',
  progress: 0.42,
  createdBy: 'user',
  outputs: [],
  createdAt: now,
  updatedAt: now
};

project.assetGenerationJobs = [assetGenerationJob];

const mcpPlugin = {
  id: 'mcp_ui_smoke',
  name: 'UI Smoke MCP',
  kind: 'custom',
  transport: 'http',
  baseUrl: 'http://127.0.0.1:8765/',
  defaultToolPermission: 'ask',
  defaultToolRisk: 'write',
  enabled: true,
  isDefault: true,
  notes: 'UI smoke fixture MCP server',
  createdAt: now,
  updatedAt: now
};

const updateSnapshot = {
  status: 'idle',
  currentVersion: '0.0.0',
  canCheck: false,
  canDownload: false,
  canInstall: false,
  isPackaged: false,
  feedSource: 'none',
  autoDownload: false
};

const providerDoctorResult = {
  overallSeverity: 'ok',
  generatedAt: now,
  durationMs: 12,
  providerId: provider.id,
  runtimeId: 'native',
  repairs: [],
  probes: [{
    id: 'native-openai-compatible',
    title: 'Native OpenAI Compatible',
    severity: 'ok',
    durationMs: 12,
    findings: [{
      severity: 'ok',
      code: 'provider_config_ok',
      summary: 'Provider fixture is configured for UI smoke.'
    }]
  }]
};

const bootstrapPayload = {
  settings: {
    baseUrl: 'http://127.0.0.1:8765/',
    profile: 'core',
    lastStatus: 'idle',
    lastCreatedProjectDirectory: '/tmp',
    lastAssignedMcpPort: 8765
  },
  aiSettings: {
    defaultProviderId: provider.id,
    fallbackToLocalPlanner: false,
    webSearch: {
      provider: 'auto',
      cacheTtlMs: 300000,
      browserFallbackEnabled: true,
      telemetryEnabled: true
    }
  },
  agentSettings: {
    permissionMode: 'full-access',
    runtimeStrategy: 'native'
  },
  providers: [provider],
  assetGenerationProviders: [assetGenerationProviderConfig],
  mcpSettings: {
    baseUrl: 'http://127.0.0.1:8765/',
    profile: 'core',
    activePluginId: mcpPlugin.id
  },
  mcpPlugins: [mcpPlugin],
  projects: [project]
};

project.sessions[0].chat = smokeChatMessages;

const projectFiles = [
  {
    id: 'dir_assets',
    name: 'assets',
    path: 'assets',
    type: 'directory',
    size: 0,
    modifiedAt: now
  },
  {
    id: 'dir_images',
    name: 'images',
    path: 'assets/images',
    type: 'directory',
    size: 0,
    modifiedAt: now
  },
  {
    id: 'dir_audio',
    name: 'audio',
    path: 'assets/audio',
    type: 'directory',
    size: 0,
    modifiedAt: now
  },
  {
    id: 'file_player',
    name: 'player.png',
    path: 'assets/images/player.png',
    type: 'file',
    size: 68,
    modifiedAt: now
  },
  {
    id: 'file_smoke_audio',
    name: 'smoke.mp3',
    path: 'assets/audio/smoke.mp3',
    type: 'file',
    size: 8192,
    modifiedAt: now
  },
  {
    id: 'file_index',
    name: 'index.html',
    path: 'index.html',
    type: 'file',
    size: 128,
    modifiedAt: now
  }
];

function serializeForPreload(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function writePreload() {
  const preloadSource = `
    const { contextBridge } = require('electron');
    const bootstrapPayload = ${serializeForPreload(bootstrapPayload)};
    const project = ${serializeForPreload(project)};
    const projectFiles = ${serializeForPreload(projectFiles)};
    const updateSnapshot = ${serializeForPreload(updateSnapshot)};
    const success = async () => ({ success: true });
    const noSubscription = () => () => {};
    contextBridge.exposeInMainWorld('funplay', {
      bootstrap: async () => bootstrapPayload,
      openExternal: success,
      openLocalPath: success,
      revealLocalPath: success,
      diagnoseEnvironment: async () => ({ ready: false, checks: [] }),
      runEnvironmentAction: async () => ({ success: true, message: 'ok' }),
      listEnvironmentTasks: async () => [],
      listInstalledUnityEditors: async () => [],
      pickProjectFolder: async () => ({ canceled: true }),
      createProject: async () => project,
      deleteProject: async () => ({ deletedProjectId: project.id, remainingProjects: [], deletedSourceFiles: false }),
      listProjectFiles: async () => projectFiles,
      readProjectFile: async (_projectId, filePath) => {
        const name = filePath.split('/').pop() || filePath;
        if (filePath.endsWith('.png')) {
          return {
            id: filePath,
            name,
            path: filePath,
            size: 68,
            content: '',
            isBinary: true,
            truncated: false,
            mimeType: 'image/png',
            previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII='
          };
        }
        if (filePath.endsWith('.mp3')) {
          return {
            id: filePath,
            name,
            path: filePath,
            size: 8192,
            content: '',
            isBinary: true,
            truncated: false,
            mimeType: 'audio/mpeg',
            previewDataUrl: 'data:audio/mpeg;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADQgD///////////////////////////////////////////8AAAA8TEFNRTMuMTAwAQAAAAAAAAAAABSAJAJAQgAAgAAAA0JgYwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ=='
          };
        }
        return {
          id: filePath,
          name,
          path: filePath,
          size: 38,
          content: '<!doctype html><html><body>Smoke</body></html>',
          isBinary: false,
          truncated: false,
          mimeType: filePath.endsWith('.html') ? 'text/html' : 'text/plain'
        };
      },
      writeProjectFile: async (_projectId, filePath, content) => ({
        id: filePath,
        name: filePath.split('/').pop() || filePath,
        path: filePath,
        size: content.length,
        content,
        isBinary: false,
        truncated: false,
        mimeType: 'text/plain'
      }),
      openProjectFile: success,
      startProjectHtmlPreviewServer: async () => ({ success: true, url: 'http://127.0.0.1:4173/', sessionId: 'html_preview_smoke', command: 'npm run preview', scriptName: 'preview', reused: false }),
      stopProjectHtmlPreviewServer: async () => ({ success: true, stopped: true, sessionId: 'html_preview_smoke' }),
      revealProjectFile: success,
      refreshProjectRuntimeState: async () => project,
      createProjectSession: async () => project,
      renameProjectSession: async () => project,
      deleteProjectSession: async () => project,
      setActiveProjectSession: async (_projectId, sessionId) => {
        const session = project.sessions.find((item) => item.id === sessionId);
        if (session) {
          project.activeSessionId = sessionId;
          project.chat = [...session.chat];
        }
        return project;
      },
      updateProjectAgentPolicy: async () => project,
      listAgentSkillCatalog: async () => ({ skills: [], repositories: [] }),
      listProjectAgentSkillRegistry: async () => ({ skills: [], repositories: [] }),
      updateProjectSessionRuntime: async () => project,
      sendPrompt: async () => project,
      startPromptStream: async () => ({ streamId: 'ui_smoke_stream' }),
      cancelPromptStream: success,
      respondPromptPermission: success,
      respondPromptUserInput: success,
      onPromptStreamEvent: noSubscription,
      onProjectFileTreeChanged: noSubscription,
      onAppNotification: noSubscription,
      onAppUpdateStatus: noSubscription,
      drainAppNotifications: async () => [],
      getUpdateStatus: async () => updateSnapshot,
      checkForUpdates: async () => updateSnapshot,
      downloadUpdate: async () => updateSnapshot,
      installUpdate: async () => updateSnapshot,
      listNotificationTasks: async () => [],
      cancelNotificationTask: success,
      listProjectMemoryFiles: async () => [],
      readProjectMemoryFile: async () => ({ path: 'memory.md', title: 'memory.md', kind: 'note', memoryKinds: [], tags: [], excerpt: '', size: 0, lineCount: 0, updatedAt: new Date().toISOString(), content: '' }),
      saveProjectMemoryFile: async (_projectId, filePath, content) => ({ path: filePath, title: filePath, kind: 'note', memoryKinds: [], tags: [], excerpt: content.slice(0, 80), size: content.length, lineCount: content.split('\\n').length, updatedAt: new Date().toISOString(), content }),
      clearProjectMemory: async () => [],
      pickPromptAttachments: async () => [],
      listAgentRuntimeCapabilities: async () => [],
      getAgentRuntimeStatus: async () => [],
      interruptAgentRun: success,
      resumeAgentRun: async () => ({ streamId: 'ui_smoke_resume' }),
      exportAgentRunLog: async () => ({ run: null }),
      createSnapshot: async () => project,
      previewSessionCheckpoint: async () => ({ snapshotId: 'snapshot', sessionId: 'ui_smoke_session', checkpointNote: 'smoke', checkpointCreatedAt: new Date().toISOString(), currentMessageCount: 0, checkpointMessageCount: 0, addedMessages: 0, removedMessages: 0, fileChanges: [] }),
      restoreSessionCheckpoint: async () => project,
      executeProjectPlan: async () => project,
      updateSettings: async (settings) => ({ ...bootstrapPayload.settings, ...settings }),
      updateProvider: async () => undefined,
      createProvider: async () => undefined,
      deleteProvider: async () => undefined,
      testProvider: async (providerId) => ({ providerId, status: 'success', message: 'ok', testedAt: new Date().toISOString() }),
      setDefaultProvider: async () => undefined,
      runProviderDoctor: async () => (${serializeForPreload(providerDoctorResult)}),
      repairProviderDiagnostic: success,
      exportRuntimeDiagnostics: async () => JSON.stringify(${serializeForPreload(providerDoctorResult)}, null, 2),
      listAssetGenerationProviders: async () => ${serializeForPreload([assetGenerationProviderProfile])},
      createAssetGenerationProvider: async (input) => ({ id: 'asset_provider_created', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hasStoredApiKey: Boolean(input.apiKey), apiKey: '', ...input }),
      updateAssetGenerationProvider: async (providerId, input) => ({ id: providerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hasStoredApiKey: Boolean(input.apiKey), apiKey: '', ...input }),
      deleteAssetGenerationProvider: success,
      generateAsset: async (_projectId, input) => {
        const job = {
          id: 'asset_job_generated',
          projectId: project.id,
          title: input.title,
          kind: input.kind,
          prompt: input.prompt,
          providerId: input.providerId || 'asset_provider_openai',
          providerName: 'OpenAI Images',
          providerAdapter: 'openai-image',
          references: input.references || [],
          outputSpec: input.outputSpec || {},
          status: 'running',
          progress: 0.24,
          createdBy: input.createdBy || 'user',
          outputs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        project.assetGenerationJobs = [job, ...(project.assetGenerationJobs || [])];
        return project;
      },
      importGeneratedAsset: async () => project,
      cancelAssetGenerationJob: async (_projectId, jobId) => {
        project.assetGenerationJobs = (project.assetGenerationJobs || []).map((job) => job.id === jobId ? { ...job, status: 'cancelled', updatedAt: new Date().toISOString() } : job);
        return project;
      },
      onAssetGenerationProjectUpdated: noSubscription,
      updateAgentSettings: async (settings) => ({ ...bootstrapPayload.agentSettings, ...settings }),
      updateWebSearchSettings: async (settings) => ({ ...bootstrapPayload.aiSettings, webSearch: { ...bootstrapPayload.aiSettings.webSearch, ...settings } }),
      getWebResearchMetrics: async () => ({ generatedAt: new Date().toISOString(), queries: 0, cacheHits: 0, providerCalls: 0, browserFallbacks: 0, failures: 0 }),
      resetWebResearchMetrics: async () => ({ generatedAt: new Date().toISOString(), queries: 0, cacheHits: 0, providerCalls: 0, browserFallbacks: 0, failures: 0 }),
      runWebSearchQualityEval: async () => ({ generatedAt: new Date().toISOString(), cases: [], passed: 0, failed: 0 }),
      createMcpPlugin: async (input) => ({ id: 'mcp_fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input }),
      updateMcpPlugin: async (pluginId, input) => ({ id: pluginId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input }),
      deleteMcpPlugin: success,
      setActiveMcpPlugin: async () => bootstrapPayload.mcpSettings,
      getMcpConnectionStatus: async (pluginId) => ({ pluginId: pluginId || mcpPlugin.id, transport: 'http', status: 'online', initializeCount: 1 }),
      reconnectMcp: async () => ({ ok: true, status: 'online', message: 'UI smoke fixture' }),
      stopMcp: async (pluginId) => ({ pluginId: pluginId || mcpPlugin.id, transport: 'http', status: 'offline', initializeCount: 1 }),
      checkMcpHealth: async () => ({ ok: false, status: 'offline', message: 'UI smoke fixture' }),
      getMcpServerInfo: async () => ({ name: 'UI Smoke MCP', version: '0.0.0', capabilities: {} }),
      listMcpTools: async () => [],
      listMcpToolSnapshots: async () => [],
      listMcpRawAudits: async () => [],
      callMcpTool: async () => ({ content: [] }),
      sendRawMcpRequest: async (pluginId, method, params) => ({ pluginId, method, durationMs: 1, paramsSize: JSON.stringify(params || {}).length, responseSize: 2, truncated: false, result: {} }),
      listMcpResources: async () => [],
      listMcpPrompts: async () => [],
      listMcpResourceTemplates: async () => [],
      readMcpResource: async () => ({ content: [] }),
      checkUnityHealth: async () => ({ ok: false, status: 'offline', message: 'UI smoke fixture' }),
      getUnityServerInfo: async () => ({ name: 'UI Smoke Unity', version: '0.0.0', capabilities: {} }),
      listUnityTools: async () => [],
      callUnityTool: async () => ({ content: [] }),
      listUnityResources: async () => [],
      readUnityResource: async () => ({ content: [] }),
      updateProjectMcpConfig: async () => project,
      updateProjectMcpServers: async (_projectId, pluginIds) => {
        project.mcpBindings = { ...(project.mcpBindings || {}), servers: pluginIds };
        return project;
      }
    });
  `;
  await writeFile(preloadPath, preloadSource);
}

async function waitFor(webContents, predicateSource, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await webContents.executeJavaScript(`Boolean((${predicateSource})())`);
    if (result) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const debug = await webContents.executeJavaScript(`
    (() => ({
      url: window.location.href,
      readyState: document.readyState,
      section: document.querySelector('[data-workspace-section]')?.getAttribute('data-workspace-section') || '',
      text: document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 500),
      rootHtml: document.getElementById('root')?.innerHTML.slice(0, 500) || '',
      messages: ${JSON.stringify(rendererMessages.slice(-10))}
    }))()
  `).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(debug)}`);
}

async function clickByText(webContents, text) {
  const clicked = await webContents.executeJavaScript(`
    (() => {
      const candidates = [...document.querySelectorAll('button')];
      const target = candidates.find((button) => button.textContent && button.textContent.includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  assert.equal(clicked, true, `Expected button containing "${text}"`);
}

async function clickModalButtonByText(webContents, text) {
  // Accept one or more candidate labels so the click survives the UI language
  // (the app defaults to zh-CN, e.g. the provider tab reads "AI 服务商", not the
  // English "AI Provider").
  const texts = Array.isArray(text) ? text : [text];
  const clicked = await webContents.executeJavaScript(`
    (() => {
      const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!modal) return false;
      const wanted = ${JSON.stringify(texts)};
      const candidates = [...modal.querySelectorAll('button')];
      const target = candidates.find((button) => button.textContent && wanted.some((t) => button.textContent.includes(t)));
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  assert.equal(clicked, true, `Expected modal button containing one of ${JSON.stringify(texts)}`);
}

async function clickByAriaLabel(webContents, label) {
  const clicked = await webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
      if (!target) return false;
      target.click();
      return true;
    })()
  `);
  assert.equal(clicked, true, `Expected button with aria-label "${label}"`);
}

async function pressKey(webContents, keyCode) {
  webContents.sendInputEvent({ type: 'keyDown', keyCode });
  webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function pressCommandPaletteShortcut(webContents) {
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['meta'] });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function clickCommandPaletteItem(webContents, commandId) {
  const clicked = await webContents.executeJavaScript(`
    (() => {
      const target = document.querySelector(${JSON.stringify(`[data-command-id="${commandId}"]`)});
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return true;
    })()
  `);
  assert.equal(clicked, true, `Expected command palette item "${commandId}"`);
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function emulateAccessibilityMedia(webContents) {
  await withTimeout((async () => {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3');
    }
    await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'forced-colors', value: 'active' }
      ]
    });
  })(), 3000, 'Accessibility media emulation');
}

async function capture(window, name) {
  // Forced-colors screenshot (the smoke runs under forced-colors emulation):
  // useful for reviewing the high-contrast / accessibility rendering.
  const image = await window.webContents.capturePage();
  const path = resolve(artifactDir, `${name}.png`);
  await writeFile(path, image.toPNG());

  // Companion realistic-color screenshot for visual review. Forced-colors
  // emulation repaints the UI in the high-contrast system palette, making the
  // artifacts above useless for judging real product colors. Briefly drop
  // forced-colors (keep reduced-motion so frames stay stable), capture into
  // artifacts/realistic/, then restore forced-colors so the forced-colors a11y
  // assertions later in the run still see it.
  const dbg = window.webContents.debugger;
  if (dbg.isAttached()) {
    await dbg.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await new Promise((done) => setTimeout(done, 120));
    const realisticImage = await window.webContents.capturePage();
    await writeFile(resolve(realisticArtifactDir, `${name}.png`), realisticImage.toPNG());
    await dbg.sendCommand('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-motion', value: 'reduce' },
        { name: 'forced-colors', value: 'active' }
      ]
    });
  }

  return path;
}

async function setUiTheme(webContents, theme) {
  await webContents.executeJavaScript(`
    (() => {
      const preferences = { theme: ${JSON.stringify(theme)}, language: 'zh-CN', developerMode: false };
      window.localStorage.setItem('funplay.ui.preferences.v1', JSON.stringify(preferences));
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.documentElement.dataset.themePreference = ${JSON.stringify(theme)};
    })()
  `);
}

async function snapshot(webContents) {
  return webContents.executeJavaScript(`
    (() => {
      const main = document.querySelector('[data-workspace-section]');
      const activeWorkspaceNav = document.querySelector('.workspace-sidebar-nav-item[aria-current="page"]');
      const activeSettingsNav = document.querySelector('.project-settings-nav-item[aria-current="page"]');
      const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
      const commandPalette = document.querySelector('.command-palette-dialog');
      const commandPaletteStyle = commandPalette ? getComputedStyle(commandPalette) : null;
      const appSettingsLayout = document.querySelector('.app-settings-layout');
      const projectSettingsNav = document.querySelector('.project-settings-nav');
      return {
        theme: document.documentElement.dataset.theme || '',
        section: main?.getAttribute('data-workspace-section') || '',
        mainLabel: main?.getAttribute('aria-label') || '',
        activeWorkspaceNav: activeWorkspaceNav?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        activeSettingsNav: activeSettingsNav?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        modalOpen: Boolean(modal),
        activeElementInsideModal: modal ? modal.contains(document.activeElement) : false,
        commandPaletteOpen: Boolean(commandPalette),
        commandPaletteText: commandPalette?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 1600) || '',
        activeElementInsideCommandPalette: commandPalette ? commandPalette.contains(document.activeElement) : false,
        commandPaletteInputFocused: document.activeElement?.classList?.contains('command-palette-input') || false,
        reducedMotionMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedColorsMatches: window.matchMedia('(forced-colors: active)').matches,
        commandPaletteAnimationName: commandPaletteStyle?.animationName || '',
        commandPaletteTransitionDuration: commandPaletteStyle?.transitionDuration || '',
        commandPaletteBorderColor: commandPaletteStyle?.borderTopColor || '',
        commandPaletteBackgroundColor: commandPaletteStyle?.backgroundColor || '',
        activeElementLabel: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) || document.activeElement?.tagName || '',
        modalText: modal?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 2400) || '',
        appSettingsColumns: appSettingsLayout ? getComputedStyle(appSettingsLayout).gridTemplateColumns : '',
        activeProviderPreset: document.querySelector('.provider-preset-card.active strong')?.textContent?.trim() || '',
        providerEditorBaseUrl: [...document.querySelectorAll('.provider-advanced-section label')].find((label) => /基础 URL|Base URL/.test(label.textContent || ''))?.querySelector('input')?.value || '',
        providerEditorModel: [...document.querySelectorAll('.provider-advanced-section label')].find((label) => /默认模型|Default Model/.test(label.textContent || ''))?.querySelector('input')?.value || '',
        providerAdvancedOpen: Boolean(document.querySelector('.provider-advanced-section')?.hasAttribute('open')),
        inspectorPath: document.querySelector('.file-inspector-path')?.textContent?.trim() || '',
        inspectorText: document.querySelector('.file-inspector-panel')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 400) || '',
        assetCardCount: document.querySelectorAll('.asset-library-card').length,
        projectSettingsColumns: document.querySelector('.project-settings-page') ? getComputedStyle(document.querySelector('.project-settings-page')).gridTemplateColumns : '',
        projectSettingsNavOverflowX: projectSettingsNav ? getComputedStyle(projectSettingsNav).overflowX : '',
        composerVisible: Boolean(document.querySelector('.agent-composer-shell') && document.querySelector('.agent-composer-textarea')),
        composerBottomGapToShell: (() => {
          const shell = document.querySelector('.agent-chat-shell');
          const composer = document.querySelector('.agent-composer-shell');
          if (!shell || !composer) return -1;
          return Math.round(shell.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom);
        })(),
        composerViewportBottomGap: (() => {
          const composer = document.querySelector('.agent-composer-shell');
          if (!composer) return -1;
          return Math.round(window.innerHeight - composer.getBoundingClientRect().bottom);
        })(),
        composerTop: Math.round(document.querySelector('.agent-composer-shell')?.getBoundingClientRect().top || 0),
        composerHeight: Math.round(document.querySelector('.agent-composer-shell')?.getBoundingClientRect().height || 0),
        chatShellHeight: Math.round(document.querySelector('.agent-chat-shell')?.getBoundingClientRect().height || 0),
        sidebarSessionTitleText: document.querySelector('.sidebar-session-title')?.textContent?.trim() || '',
        sidebarSessionSummaryText: document.querySelector('.sidebar-session-summary')?.textContent?.trim() || '',
        sidebarSessionTitleWidth: Math.round(document.querySelector('.sidebar-session-title')?.getBoundingClientRect().width || 0),
        sidebarSessionMainWidth: Math.round(document.querySelector('.sidebar-session-main')?.getBoundingClientRect().width || 0),
        sidebarSessionLabelWidth: Math.round(document.querySelector('.sidebar-session-main .fp-button-label')?.getBoundingClientRect().width || 0),
        sidebarSessionBodyWidth: Math.round(document.querySelector('.sidebar-session-body')?.getBoundingClientRect().width || 0),
        sidebarSessionHeadWidth: Math.round(document.querySelector('.sidebar-session-head')?.getBoundingClientRect().width || 0),
        sidebarSessionTimeWidth: Math.round(document.querySelector('.sidebar-session-time')?.getBoundingClientRect().width || 0),
        sidebarSessionTitleColor: document.querySelector('.sidebar-session-title') ? getComputedStyle(document.querySelector('.sidebar-session-title')).color : '',
        composerClipped: (() => {
          const composer = document.querySelector('.agent-composer-shell');
          if (!composer) return true;
          const rect = composer.getBoundingClientRect();
          return rect.left < 0 || rect.right > window.innerWidth || rect.top < 0 || rect.bottom > window.innerHeight;
        })(),
        projectSettingsNavDisplay: projectSettingsNav ? getComputedStyle(projectSettingsNav).display : '',
        bodyText: document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 600)
      };
    })()
  `);
}

async function verifyAgentChatScroll(webContents) {
  const metrics = await webContents.executeJavaScript(`
    (() => {
      const node = document.querySelector('.agent-scroll-region');
      if (!node) {
        return { exists: false };
      }
      const before = node.scrollTop;
      node.scrollTop = 0;
      const topAfterReset = node.scrollTop;
      node.scrollTo({ top: 240, behavior: 'auto' });
      return {
        exists: true,
        before,
        topAfterReset,
        afterScroll: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        overflowY: getComputedStyle(node).overflowY,
        recentMessageVisible: Boolean([...node.querySelectorAll('.chat-transcript-row')].find((row) => /UI smoke assistant message 36/.test(row.textContent || '')))
      };
    })()
  `);
  assert.equal(metrics.exists, true, 'Expected chat scroll region to exist');
  assert.ok(metrics.scrollHeight > metrics.clientHeight + 120, `Expected long chat transcript to overflow: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.afterScroll > metrics.topAfterReset, `Expected chat scrollTop to change: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.overflowY, 'auto');
  assert.equal(metrics.recentMessageVisible, true);
  return metrics;
}

async function verifyComposerBottomAnchoring(webContents, state) {
  const metrics = await webContents.executeJavaScript(`
    (() => {
      const shell = document.querySelector('.agent-chat-shell');
      const composer = document.querySelector('.agent-composer-shell');
      const scrollLayer = document.querySelector('.agent-chat-scroll-layer');
      if (!shell || !composer || !scrollLayer) {
        return { exists: false };
      }
      const shellRect = shell.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const scrollLayerRect = scrollLayer.getBoundingClientRect();
      return {
        exists: true,
        shellTop: Math.round(shellRect.top),
        shellBottom: Math.round(shellRect.bottom),
        shellHeight: Math.round(shellRect.height),
        scrollLayerHeight: Math.round(scrollLayerRect.height),
        composerTop: Math.round(composerRect.top),
        composerBottom: Math.round(composerRect.bottom),
        composerHeight: Math.round(composerRect.height),
        composerBottomGapToShell: Math.round(shellRect.bottom - composerRect.bottom),
        viewportBottomGap: Math.round(window.innerHeight - composerRect.bottom),
        shellDisplay: getComputedStyle(shell).display,
        shellRows: getComputedStyle(shell).gridTemplateRows,
        paneOverflow: getComputedStyle(document.querySelector('.chat-primary-column')).overflow
      };
    })()
  `);
  assert.equal(metrics.exists, true, `Expected composer and chat shell to exist in ${state}`);
  assert.equal(metrics.shellDisplay, 'grid', `Expected deterministic chat shell grid in ${state}: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.shellHeight > metrics.composerHeight + 120, `Expected chat shell to reserve transcript space in ${state}: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.scrollLayerHeight > 120, `Expected scroll layer to occupy remaining chat height in ${state}: ${JSON.stringify(metrics)}`);
  assert.ok(
    metrics.composerBottomGapToShell >= 0 && metrics.composerBottomGapToShell <= 90,
    `Expected composer to stay anchored near chat bottom in ${state}: ${JSON.stringify(metrics)}`
  );
  return metrics;
}

async function collectAccessibilityIssues(webContents, state) {
  return webContents.executeJavaScript(`
    (() => {
      const state = ${JSON.stringify(state)};
      const controls = new Set();
      const selectors = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        '[role="button"]',
        '[role="checkbox"]',
        '[role="combobox"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[role="tab"]',
        '[role="textbox"]',
        '[tabindex]:not([tabindex="-1"])'
      ];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          controls.add(element);
        }
      }
      const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (element.closest('[hidden], [aria-hidden="true"]')) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const labelText = (element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent || '')
            .join(' ');
          if (normalizedText(text)) {
            return normalizedText(text);
          }
        }
        const directLabel = element.getAttribute('aria-label');
        if (normalizedText(directLabel)) {
          return normalizedText(directLabel);
        }
        const title = element.getAttribute('title');
        if (normalizedText(title)) {
          return normalizedText(title);
        }
        const closestLabel = element.closest('label');
        if (closestLabel && normalizedText(closestLabel.textContent)) {
          return normalizedText(closestLabel.textContent);
        }
        if ('labels' in element && element.labels?.length) {
          const text = [...element.labels].map((label) => label.textContent || '').join(' ');
          if (normalizedText(text)) {
            return normalizedText(text);
          }
        }
        const placeholder = element.getAttribute('placeholder');
        if (normalizedText(placeholder)) {
          return normalizedText(placeholder);
        }
        const text = normalizedText(element.textContent);
        if (text) {
          return text;
        }
        return '';
      };
      return [...controls]
        .filter((element) => isVisible(element))
        .map((element) => ({
          state,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          className: String(element.getAttribute('class') || ''),
          ariaLabel: element.getAttribute('aria-label') || '',
          text: normalizedText(element.textContent).slice(0, 80),
          name: labelText(element)
        }))
        .filter((entry) => !entry.name)
        .map((entry) => ({
          state: entry.state,
          selector: [entry.tag, entry.role ? '[role="' + entry.role + '"]' : '', entry.className ? '.' + entry.className.split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : ''].join(''),
          text: entry.text,
          ariaLabel: entry.ariaLabel
        }));
    })()
  `);
}

async function auditAccessibility(webContents, state, audits) {
  const issues = await collectAccessibilityIssues(webContents, state);
  audits.push({ state, issueCount: issues.length, issues });
  assert.deepEqual(issues, [], `Visible interactive controls without accessible names in ${state}`);
}

async function collectLayoutIssues(webContents, state) {
  return webContents.executeJavaScript(`
    (() => {
      const state = ${JSON.stringify(state)};
      const issues = [];
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const normalizedText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (element.closest('[hidden], [aria-hidden="true"]')) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const rootScrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      if (rootScrollWidth > viewportWidth + 2) {
        issues.push({
          state,
          type: 'page-horizontal-overflow',
          detail: rootScrollWidth + 'px > ' + viewportWidth + 'px'
        });
      }
      for (const selector of ['.command-palette-dialog', '[role="dialog"][aria-modal="true"]', '.agent-composer-shell']) {
        for (const element of document.querySelectorAll(selector)) {
          if (!isVisible(element)) {
            continue;
          }
          const rect = element.getBoundingClientRect();
          if (rect.left < -1 || rect.right > viewportWidth + 1 || rect.top < -1 || rect.bottom > viewportHeight + 1) {
            issues.push({
              state,
              type: 'critical-surface-clipped',
              selector,
              detail: JSON.stringify({
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                viewportWidth,
                viewportHeight
              })
            });
          }
        }
      }
      for (const label of document.querySelectorAll('button .fp-button-label')) {
        if (!isVisible(label)) {
          continue;
        }
        const button = label.closest('button');
        if (!button || !isVisible(button)) {
          continue;
        }
        const labelRect = label.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        if (labelRect.left < buttonRect.left - 1 || labelRect.right > buttonRect.right + 1 || labelRect.top < buttonRect.top - 1 || labelRect.bottom > buttonRect.bottom + 1) {
          issues.push({
            state,
            type: 'button-label-overflow',
            selector: button.getAttribute('aria-label') || normalizedText(button.textContent).slice(0, 80) || button.className,
            detail: JSON.stringify({
              labelRight: Math.round(labelRect.right),
              buttonRight: Math.round(buttonRect.right),
              labelBottom: Math.round(labelRect.bottom),
              buttonBottom: Math.round(buttonRect.bottom)
            })
          });
        }
      }
      for (const element of document.querySelectorAll('.fp-select-value, .config-list-row-copy strong, .config-list-row-copy span, .asset-category-copy strong, .asset-library-card-name, .markdown-body p, .markdown-body li')) {
        if (!isVisible(element)) {
          continue;
        }
        const text = normalizedText(element.textContent);
        if (text.length < 2) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize || '0') || 14;
        if (rect.width < Math.min(28, fontSize * 2.2) && rect.height > fontSize * 2.4) {
          issues.push({
            state,
            type: 'suspicious-vertical-text',
            selector: element.className || element.tagName.toLowerCase(),
            detail: JSON.stringify({
              text: text.slice(0, 80),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              fontSize: Math.round(fontSize)
            })
          });
        }
      }
      return issues;
    })()
  `);
}

async function auditLayout(webContents, state, audits) {
  const issues = await collectLayoutIssues(webContents, state);
  audits.push({ state, issueCount: issues.length, issues });
  assert.deepEqual(issues, [], `Visible desktop UI layout overflow in ${state}`);
}

function buildReport(rows, accessibilityAudits, layoutAudits) {
  const generatedAt = new Date().toISOString();
  return [
    '# Desktop UI Electron Smoke Report',
    '',
    `Generated: ${generatedAt}`,
    '',
    'This smoke uses a controlled preload API and app-scoped `BrowserWindow.capturePage()` screenshots only. It does not use whole-desktop screenshots.',
    '',
    'The Screenshot column below is captured under forced-colors emulation (accessibility rendering). Realistic-color companions for visual review are written to `artifacts/realistic/` with the same filenames.',
    '',
    '| State | Theme | Section | Modal | Screenshot |',
    '|---|---:|---:|---:|---|',
    ...rows.map((row) => `| ${row.state} | ${row.detail.theme || '-'} | ${row.detail.section || '-'} | ${row.detail.modalOpen ? 'open' : 'closed'} | ${row.screenshot} |`),
    '',
    '## Checked States',
    '',
    ...rows.map((row) => [
      `### ${row.state}`,
      '',
      `- Main label: ${row.detail.mainLabel || '-'}`,
      `- Theme: ${row.detail.theme || '-'}`,
      `- Active workspace nav: ${row.detail.activeWorkspaceNav || '-'}`,
      `- Active settings nav: ${row.detail.activeSettingsNav || '-'}`,
      `- App settings columns: ${row.detail.appSettingsColumns || '-'}`,
      `- Project settings nav display: ${row.detail.projectSettingsNavDisplay || '-'}`,
      `- Active element inside modal: ${row.detail.modalOpen ? String(row.detail.activeElementInsideModal) : '-'}`,
      `- Command palette open: ${row.detail.commandPaletteOpen ? 'true' : 'false'}`,
      `- Reduced motion emulated: ${row.detail.reducedMotionMatches ? 'true' : 'false'}`,
      `- Forced colors emulated: ${row.detail.forcedColorsMatches ? 'true' : 'false'}`,
      ''
    ].join('\n')),
    '## Accessibility Audit',
    '',
    ...accessibilityAudits.map((audit) => `- ${audit.state}: ${audit.issueCount} unnamed visible interactive controls`),
    '',
    '## Layout Stability Audit',
    '',
    ...layoutAudits.map((audit) => `- ${audit.state}: ${audit.issueCount} overflow or clipping issues`)
  ].join('\n');
}

async function main() {
  await writePreload();
  await mkdir(artifactDir, { recursive: true });
  await mkdir(realisticArtifactDir, { recursive: true });
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const rows = [];
  const accessibilityAudits = [];
  const layoutAudits = [];
  try {
    win.webContents.on('console-message', (details) => {
      const payload = typeof details === 'object' && details !== null
        ? {
            level: details.level,
            message: details.message,
            line: details.lineNumber,
            sourceId: details.sourceId
          }
        : {
            level: 'unknown',
            message: String(details),
            line: 0,
            sourceId: ''
          };
      rendererMessages.push(payload);
      if (rendererMessages.length > 40) {
        rendererMessages.shift();
      }
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      rendererMessages.push({ level: 'gone', message: details.reason, line: 0, sourceId: '' });
    });
    await win.loadFile(rendererEntry);
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"agent\"]') && /UI smoke assistant message 36/.test(document.body.textContent)", 'Agent workspace');
    await setUiTheme(win.webContents, 'light');
    await emulateAccessibilityMedia(win.webContents);
    await waitFor(win.webContents, "() => window.matchMedia('(prefers-reduced-motion: reduce)').matches", 'Reduced motion emulation');
    await waitFor(win.webContents, "() => window.matchMedia('(forced-colors: active)').matches", 'Forced colors emulation');
    const agent = await snapshot(win.webContents);
    assert.equal(agent.section, 'agent');
    assert.match(agent.bodyText, /UI smoke/);
    assert.equal(agent.sidebarSessionTitleText, '主会话');
    assert.match(agent.sidebarSessionSummaryText, /UI smoke assistant message 36/);
    assert.ok(agent.sidebarSessionTitleWidth > 40, `Expected visible sidebar session title width: ${JSON.stringify(agent)}`);
    assert.notEqual(agent.sidebarSessionTitleColor, 'rgba(0, 0, 0, 0)');
    const agentScrollMetrics = await verifyAgentChatScroll(win.webContents);
    const agentComposerMetrics = await verifyComposerBottomAnchoring(win.webContents, 'Agent');
    await auditAccessibility(win.webContents, 'Agent', accessibilityAudits);
    await auditLayout(win.webContents, 'Agent', layoutAudits);
    rows.push({ state: 'Agent', screenshot: await capture(win, 'agent'), detail: { ...agent, agentScrollMetrics, agentComposerMetrics } });

    await pressCommandPaletteShortcut(win.webContents);
    await waitFor(win.webContents, "() => document.querySelector('.command-palette-dialog')", 'Command palette shortcut');
    const commandPalette = await snapshot(win.webContents);
    assert.equal(commandPalette.commandPaletteOpen, true);
    assert.equal(commandPalette.activeElementInsideCommandPalette, true);
    assert.equal(commandPalette.commandPaletteInputFocused, true);
    assert.equal(commandPalette.reducedMotionMatches, true);
    assert.equal(commandPalette.forcedColorsMatches, true);
    assert.equal(commandPalette.commandPaletteAnimationName, 'none');
    assert.match(commandPalette.commandPaletteTransitionDuration, /^0(?:s|ms)|0\.001ms$/);
    assert.notEqual(commandPalette.commandPaletteBorderColor, '');
    assert.notEqual(commandPalette.commandPaletteBackgroundColor, '');
    assert.match(commandPalette.commandPaletteText, /Agent 工作区|Agent workspace/);
    assert.match(commandPalette.commandPaletteText, /项目设置|Project settings/);
    assert.match(commandPalette.commandPaletteText, /素材库|Assets/);
    await auditAccessibility(win.webContents, 'Command Palette', accessibilityAudits);
    await auditLayout(win.webContents, 'Command Palette', layoutAudits);
    rows.push({ state: 'Command Palette', screenshot: await capture(win, 'command-palette'), detail: commandPalette });
    await pressKey(win.webContents, 'Tab');
    const commandPaletteAfterTab = await snapshot(win.webContents);
    assert.equal(commandPaletteAfterTab.commandPaletteOpen, true);
    assert.equal(commandPaletteAfterTab.activeElementInsideCommandPalette, true);

    await clickCommandPaletteItem(win.webContents, 'open-assets');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"assets\"]') && !document.querySelector('.command-palette-dialog')", 'Command palette assets route');
    const commandAssets = await snapshot(win.webContents);
    assert.equal(commandAssets.section, 'assets');
    assert.equal(commandAssets.commandPaletteOpen, false);
    assert.match(commandAssets.bodyText, /player\.png|assets\/images\/player\.png/);
    await auditAccessibility(win.webContents, 'Command Palette Assets Route', accessibilityAudits);
    await auditLayout(win.webContents, 'Command Palette Assets Route', layoutAudits);
    rows.push({ state: 'Command Palette Assets Route', screenshot: await capture(win, 'command-palette-assets-route'), detail: commandAssets });

    await clickByText(win.webContents, '项目设置');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"settings\"]')", 'Project Settings route');
    const settings = await snapshot(win.webContents);
    assert.equal(settings.section, 'settings');
    assert.match(settings.activeWorkspaceNav, /项目设置|Project Settings/);
    assert.match(settings.bodyText, /引擎项目|Engine Project/);
    await auditAccessibility(win.webContents, 'Project Settings', accessibilityAudits);
    await auditLayout(win.webContents, 'Project Settings', layoutAudits);
    rows.push({ state: 'Project Settings', screenshot: await capture(win, 'project-settings'), detail: settings });

    await clickByText(win.webContents, '素材库');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"assets\"]')", 'Assets route');
    const assets = await snapshot(win.webContents);
    assert.equal(assets.section, 'assets');
    assert.match(assets.activeWorkspaceNav, /素材库|Assets/);
    assert.match(assets.bodyText, /player\.png|assets\/images\/player\.png/);
    assert.equal(assets.assetCardCount, 2);
    await auditAccessibility(win.webContents, 'Assets', accessibilityAudits);
    await auditLayout(win.webContents, 'Assets', layoutAudits);
    rows.push({ state: 'Assets', screenshot: await capture(win, 'assets'), detail: assets });

    await clickByText(win.webContents, '生成素材');
    await waitFor(win.webContents, "() => document.querySelector('.asset-generation-center') && /任务队列|Job Queue/.test(document.body.textContent)", 'Asset Generation Center');
    const assetGeneration = await snapshot(win.webContents);
    assert.equal(assetGeneration.section, 'assets');
    assert.match(assetGeneration.bodyText, /生成素材|Generate/);
    assert.match(assetGeneration.bodyText, /任务队列|Job Queue/);
    assert.match(assetGeneration.bodyText, /OpenAI Images/);
    await auditAccessibility(win.webContents, 'Asset Generation Center', accessibilityAudits);
    await auditLayout(win.webContents, 'Asset Generation Center', layoutAudits);
    rows.push({ state: 'Asset Generation Center', screenshot: await capture(win, 'asset-generation-center'), detail: assetGeneration });

    await clickByText(win.webContents, '全部');
    await waitFor(win.webContents, "() => document.querySelector('.asset-library-card')", 'Asset library after generation route');

    await clickByText(win.webContents, 'player.png');
    await waitFor(win.webContents, "() => document.querySelector('.file-inspector-path')?.textContent.includes('assets/images/player.png')", 'Asset inspector handoff');
    const assetInspector = await snapshot(win.webContents);
    assert.equal(assetInspector.inspectorPath, 'assets/images/player.png');
    assert.match(assetInspector.inspectorText, /Rogue UI Smoke/);
    assert.match(assetInspector.inspectorText, /只读|Read only|预览模式|Preview mode/);
    await auditAccessibility(win.webContents, 'Asset Inspector Handoff', accessibilityAudits);
    await auditLayout(win.webContents, 'Asset Inspector Handoff', layoutAudits);
    rows.push({ state: 'Asset Inspector Handoff', screenshot: await capture(win, 'asset-inspector-handoff'), detail: assetInspector });
    await clickByAriaLabel(win.webContents, '关闭文件面板');
    await waitFor(win.webContents, "() => !document.querySelector('.file-inspector-path')?.textContent.includes('assets/images/player.png')", 'File inspector close');

    await clickByAriaLabel(win.webContents, '打开应用设置');
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')", 'App Settings modal');
    await clickModalButtonByText(win.webContents, ['AI Provider', 'AI 服务商']);
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('Xiaomi MiMo')", 'Provider settings modal');
    const providerModal = await snapshot(win.webContents);
    assert.equal(providerModal.modalOpen, true);
    assert.equal(providerModal.activeElementInsideModal, true);
    assert.match(providerModal.modalText, /AI Provider/);
    assert.match(providerModal.modalText, /Xiaomi MiMo/);
    assert.match(providerModal.modalText, /默认：Xiaomi MiMo|Default: Xiaomi MiMo/);
    assert.match(providerModal.modalText, /搜索配置|Search configurations/);
    await auditAccessibility(win.webContents, 'App Settings Provider', accessibilityAudits);
    await auditLayout(win.webContents, 'App Settings Provider', layoutAudits);
    rows.push({ state: 'App Settings Provider', screenshot: await capture(win, 'app-settings-provider'), detail: providerModal });
    await pressKey(win.webContents, 'Tab');
    const providerModalAfterTab = await snapshot(win.webContents);
    assert.equal(providerModalAfterTab.modalOpen, true);
    assert.equal(providerModalAfterTab.activeElementInsideModal, true);

    await clickModalButtonByText(win.webContents, '素材 Provider');
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('OpenAI Images') && document.querySelector('.asset-provider-settings-page')", 'Asset provider settings modal');
    const assetProviderModal = await snapshot(win.webContents);
    assert.equal(assetProviderModal.modalOpen, true);
    assert.match(assetProviderModal.modalText, /素材 Provider|Asset Providers/);
    assert.match(assetProviderModal.modalText, /OpenAI Images/);
    assert.match(assetProviderModal.modalText, /添加素材 Provider|Add Asset Provider/);
    await auditAccessibility(win.webContents, 'App Settings Asset Provider', accessibilityAudits);
    await auditLayout(win.webContents, 'App Settings Asset Provider', layoutAudits);
    rows.push({ state: 'App Settings Asset Provider', screenshot: await capture(win, 'app-settings-asset-provider'), detail: assetProviderModal });

    await clickModalButtonByText(win.webContents, 'MCP');
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('UI Smoke MCP') && document.querySelector('.mcp-registry-settings')", 'MCP settings modal');
    const mcpModal = await snapshot(win.webContents);
    assert.equal(mcpModal.modalOpen, true);
    assert.match(mcpModal.modalText, /MCP Registry/);
    assert.match(mcpModal.modalText, /UI Smoke MCP/);
    assert.match(mcpModal.modalText, /添加 Server|Add server/);
    await auditAccessibility(win.webContents, 'App Settings MCP', accessibilityAudits);
    await auditLayout(win.webContents, 'App Settings MCP', layoutAudits);
    rows.push({ state: 'App Settings MCP', screenshot: await capture(win, 'app-settings-mcp'), detail: mcpModal });

    await clickModalButtonByText(win.webContents, ['AI Provider', 'AI 服务商']);
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('Xiaomi MiMo')", 'Provider settings modal restored');

    await clickByText(win.webContents, '添加 Provider');
    await waitFor(win.webContents, "() => document.querySelector('.app-settings-inline-editor')?.textContent.includes('服务商预设')", 'Provider editor');
    await clickByText(win.webContents, 'Xiaomi MiMo');
    await waitFor(win.webContents, "() => document.querySelector('.provider-preset-card.active strong')?.textContent.trim() === 'Xiaomi MiMo'", 'Xiaomi MiMo provider preset');
    const providerEditor = await snapshot(win.webContents);
    assert.equal(providerEditor.modalOpen, true);
    assert.equal(providerEditor.activeProviderPreset, 'Xiaomi MiMo');
    assert.equal(providerEditor.providerEditorBaseUrl, 'https://api.xiaomimimo.com/v1');
    assert.equal(providerEditor.providerEditorModel, 'mimo-v2.5-pro');
    assert.equal(providerEditor.providerAdvancedOpen, false);
    assert.match(providerEditor.modalText, /核心配置|Core Configuration/);
    assert.match(providerEditor.modalText, /高级设置|Advanced Settings/);
    await auditAccessibility(win.webContents, 'Provider Editor Preset', accessibilityAudits);
    await auditLayout(win.webContents, 'Provider Editor Preset', layoutAudits);
    rows.push({ state: 'Provider Editor Preset', screenshot: await capture(win, 'provider-editor-preset'), detail: providerEditor });

    win.setSize(840, 640);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const compact = await snapshot(win.webContents);
    assert.equal(compact.modalOpen, true);
    assert.equal(compact.activeElementInsideModal, true);
    assert.equal(compact.providerAdvancedOpen, false);
    assert.match(compact.appSettingsColumns, /^[0-9.]+px$/);
    await auditAccessibility(win.webContents, 'Compact App Settings', accessibilityAudits);
    await auditLayout(win.webContents, 'Compact App Settings', layoutAudits);
    rows.push({ state: 'Compact App Settings', screenshot: await capture(win, 'compact-app-settings-provider'), detail: compact });

    await pressKey(win.webContents, 'Escape');
    await waitFor(win.webContents, "() => !document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')", 'App Settings close');
    await clickByText(win.webContents, '项目设置');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"settings\"]')", 'Compact Project Settings route');
    const compactSettings = await snapshot(win.webContents);
    assert.equal(compactSettings.section, 'settings');
    assert.equal(compactSettings.projectSettingsNavDisplay, 'flex');
    assert.match(compactSettings.projectSettingsColumns, /^[0-9.]+px$/);
    assert.match(compactSettings.projectSettingsNavOverflowX, /auto|scroll/);
    await auditAccessibility(win.webContents, 'Compact Project Settings', accessibilityAudits);
    await auditLayout(win.webContents, 'Compact Project Settings', layoutAudits);
    rows.push({ state: 'Compact Project Settings', screenshot: await capture(win, 'compact-project-settings'), detail: compactSettings });

    await clickByText(win.webContents, '主会话');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"agent\"]') && document.querySelector('.agent-composer-textarea')", 'Compact Agent composer');
    const compactAgent = await snapshot(win.webContents);
    assert.equal(compactAgent.section, 'agent');
    assert.equal(compactAgent.composerVisible, true);
    assert.equal(compactAgent.composerClipped, false);
    const compactComposerMetrics = await verifyComposerBottomAnchoring(win.webContents, 'Compact Agent Composer');
    await auditAccessibility(win.webContents, 'Compact Agent Composer', accessibilityAudits);
    await auditLayout(win.webContents, 'Compact Agent Composer', layoutAudits);
    rows.push({ state: 'Compact Agent Composer', screenshot: await capture(win, 'compact-agent-composer'), detail: { ...compactAgent, compactComposerMetrics } });

    await clickByText(win.webContents, '空会话');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"agent\"]') && /开始一个新对话|Start a new conversation/.test(document.body.textContent)", 'Empty Agent composer');
    const emptyAgent = await snapshot(win.webContents);
    assert.equal(emptyAgent.section, 'agent');
    assert.equal(emptyAgent.composerVisible, true);
    assert.equal(emptyAgent.composerClipped, false);
    assert.match(emptyAgent.bodyText, /开始一个新对话|Start a new conversation/);
    const emptyComposerMetrics = await verifyComposerBottomAnchoring(win.webContents, 'Empty Agent Composer');
    await auditAccessibility(win.webContents, 'Empty Agent Composer', accessibilityAudits);
    await auditLayout(win.webContents, 'Empty Agent Composer', layoutAudits);
    rows.push({ state: 'Empty Agent Composer', screenshot: await capture(win, 'empty-agent-composer'), detail: { ...emptyAgent, emptyComposerMetrics } });

    win.setSize(1280, 820);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await setUiTheme(win.webContents, 'dark');

    await clickByText(win.webContents, '主会话');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"agent\"]') && document.documentElement.dataset.theme === 'dark'", 'Dark Agent workspace');
    const darkAgent = await snapshot(win.webContents);
    assert.equal(darkAgent.theme, 'dark');
    assert.equal(darkAgent.section, 'agent');
    await auditAccessibility(win.webContents, 'Dark Agent', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark Agent', layoutAudits);
    rows.push({ state: 'Dark Agent', screenshot: await capture(win, 'dark-agent'), detail: darkAgent });

    await clickByText(win.webContents, '素材库');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"assets\"]') && document.documentElement.dataset.theme === 'dark'", 'Dark Assets route');
    const darkAssets = await snapshot(win.webContents);
    assert.equal(darkAssets.theme, 'dark');
    assert.equal(darkAssets.section, 'assets');
    assert.match(darkAssets.bodyText, /player\.png|assets\/images\/player\.png/);
    await auditAccessibility(win.webContents, 'Dark Assets', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark Assets', layoutAudits);
    rows.push({ state: 'Dark Assets', screenshot: await capture(win, 'dark-assets'), detail: darkAssets });

    await clickByText(win.webContents, '生成素材');
    await waitFor(win.webContents, "() => document.querySelector('.asset-generation-center') && document.documentElement.dataset.theme === 'dark'", 'Dark Asset Generation Center');
    const darkAssetGeneration = await snapshot(win.webContents);
    assert.equal(darkAssetGeneration.theme, 'dark');
    assert.match(darkAssetGeneration.bodyText, /任务队列|Job Queue/);
    await auditAccessibility(win.webContents, 'Dark Asset Generation Center', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark Asset Generation Center', layoutAudits);
    rows.push({ state: 'Dark Asset Generation Center', screenshot: await capture(win, 'dark-asset-generation-center'), detail: darkAssetGeneration });

    await clickByText(win.webContents, '项目设置');
    await waitFor(win.webContents, "() => document.querySelector('[data-workspace-section=\"settings\"]') && document.documentElement.dataset.theme === 'dark'", 'Dark Project Settings');
    const darkSettings = await snapshot(win.webContents);
    assert.equal(darkSettings.theme, 'dark');
    assert.equal(darkSettings.section, 'settings');
    await auditAccessibility(win.webContents, 'Dark Project Settings', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark Project Settings', layoutAudits);
    rows.push({ state: 'Dark Project Settings', screenshot: await capture(win, 'dark-project-settings'), detail: darkSettings });

    await clickByAriaLabel(win.webContents, '打开应用设置');
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]') && document.documentElement.dataset.theme === 'dark'", 'Dark App Settings modal');
    await clickModalButtonByText(win.webContents, ['AI Provider', 'AI 服务商']);
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('Xiaomi MiMo')", 'Dark Provider settings modal');
    const darkProviderModal = await snapshot(win.webContents);
    assert.equal(darkProviderModal.theme, 'dark');
    assert.equal(darkProviderModal.modalOpen, true);
    assert.match(darkProviderModal.modalText, /AI Provider/);
    await auditAccessibility(win.webContents, 'Dark App Settings Provider', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark App Settings Provider', layoutAudits);
    rows.push({ state: 'Dark App Settings Provider', screenshot: await capture(win, 'dark-app-settings-provider'), detail: darkProviderModal });

    await clickModalButtonByText(win.webContents, '素材 Provider');
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('OpenAI Images')", 'Dark Asset Provider settings modal');
    const darkAssetProviderModal = await snapshot(win.webContents);
    assert.equal(darkAssetProviderModal.theme, 'dark');
    assert.match(darkAssetProviderModal.modalText, /素材 Provider|Asset Providers/);
    await auditAccessibility(win.webContents, 'Dark App Settings Asset Provider', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark App Settings Asset Provider', layoutAudits);
    rows.push({ state: 'Dark App Settings Asset Provider', screenshot: await capture(win, 'dark-app-settings-asset-provider'), detail: darkAssetProviderModal });

    await clickModalButtonByText(win.webContents, 'MCP');
    await waitFor(win.webContents, "() => document.querySelector('[role=\"dialog\"]')?.textContent.includes('UI Smoke MCP')", 'Dark MCP settings modal');
    const darkMcpModal = await snapshot(win.webContents);
    assert.equal(darkMcpModal.theme, 'dark');
    assert.match(darkMcpModal.modalText, /MCP Registry/);
    await auditAccessibility(win.webContents, 'Dark App Settings MCP', accessibilityAudits);
    await auditLayout(win.webContents, 'Dark App Settings MCP', layoutAudits);
    rows.push({ state: 'Dark App Settings MCP', screenshot: await capture(win, 'dark-app-settings-mcp'), detail: darkMcpModal });

    await pressKey(win.webContents, 'Escape');
    await waitFor(win.webContents, "() => !document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')", 'Dark App Settings close');

    await writeFile(reportPath, buildReport(rows, accessibilityAudits, layoutAudits));
    console.log(`Desktop UI Electron smoke passed: ${reportPath}`);
  } finally {
    if (win.webContents.debugger.isAttached()) {
      win.webContents.debugger.detach();
    }
    win.destroy();
    await rm(preloadPath, { force: true });
  }
}

main()
  .then(() => app.quit())
  .catch(async (error) => {
    console.error(error);
    await rm(preloadPath, { force: true }).catch(() => {});
    process.exitCode = 1;
    app.exit(1);
    process.exit(1);
  });
