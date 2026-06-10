import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type {
  ChatMessage,
  EnvironmentDiagnostics,
  McpPlugin,
  Project,
  ProjectSession,
  PromptAttachment,
  RuntimeDoctorResult,
  SessionCheckpointPreview,
  WebSearchSettings
} from '../../shared/types.ts';
import { ChatComposer } from '../../src/components/chat/ChatComposer.tsx';
import {
  ChatTranscriptMessage,
  StreamingTranscriptMessage,
  getMessagePlainText
} from '../../src/components/chat/ConversationMessage.tsx';
import { AgentChatView } from '../../src/components/chat/AgentChatView.tsx';
import { EngineStatusDialog } from '../../src/components/chat/agent/EngineStatusDialog.tsx';
import { MessageList } from '../../src/components/chat/MessageList.tsx';
import {
  buildCompletedMessageProcessTools,
  pairStreamingToolExecutions,
  summarizeToolResult
} from '../../src/components/chat/tool-activity.tsx';
import { buildTranscriptViewItems } from '../../src/components/chat/transcript/transcript-view-model.ts';
import { AgentWorkbench } from '../../src/components/layout/AgentWorkbench.tsx';
import { FileInspectorPanel, SidebarPanel } from '../../src/components/layout/WorkspacePanels.tsx';
import { AppSettingsModal } from '../../src/components/modals/AppSettingsModal.tsx';
import { DeleteProjectModal } from '../../src/components/modals/DeleteProjectModal.tsx';
import { SessionChangesPanel } from '../../src/components/modals/SessionChangesPanel.tsx';
import { SessionManagementPanel } from '../../src/components/layout/SessionManagementPanel.tsx';
import { NotificationToastStack } from '../../src/components/shared/NotificationToastStack.tsx';
import { AssetsPage } from '../../src/components/pages/AssetsPage.tsx';
import { SkillsPage } from '../../src/components/pages/SkillsPage.tsx';
import { WelcomeScreen } from '../../src/components/pages/WelcomeScreen.tsx';
import { OnboardingScreen } from '../../src/components/pages/OnboardingScreen.tsx';
import { WebSearchSettingsPage } from '../../src/components/pages/WebSearchSettingsPage.tsx';
import { ProviderSettingsPage, RuntimeDoctorDialog } from '../../src/components/pages/ProviderSettingsPage.tsx';
import { AssetProviderSettingsPage } from '../../src/components/pages/AssetProviderSettingsPage.tsx';
import { ProjectSettingsPage } from '../../src/components/pages/ProjectSettingsPage.tsx';
import { ProjectAgentRunsSettings } from '../../src/components/pages/project-settings/ProjectAgentRunsSettings.tsx';
import { ProjectAgentSettings } from '../../src/components/pages/project-settings/ProjectAgentSettings.tsx';
import { ProjectTokenUsageSettings } from '../../src/components/pages/project-settings/ProjectTokenUsageSettings.tsx';
import {
  McpManagementPage,
  McpRawAuditCard,
  McpRawDiagnosticsCard,
  McpToolSnapshotCard,
  PluginListCard,
  ServerListRow
} from '../../src/components/pages/McpManagementPage.tsx';
import { McpRegistrySettingsPage } from '../../src/components/pages/McpRegistrySettingsPage.tsx';
import { ProviderEditor } from '../../src/components/modals/ProviderEditor.tsx';
import { McpPluginModal } from '../../src/components/settings-modals.tsx';
import {
  contextUsage,
  createUpdateSnapshot,
  noop,
  noopAsync,
  provider,
  renderAppShell,
  renderComposer,
  renderZh,
  secondaryProvider
} from './agent-ui-render-helpers.tsx';
import { buildProject } from './test-helpers.ts';

test('titlebar shows update button before current run changes when an update is available', () => {
  const html = renderAppShell(createUpdateSnapshot('available'));
  const updateIndex = html.indexOf('titlebar-update-toggle');
  const changesIndex = html.indexOf('titlebar-changes-toggle');

  assert.ok(updateIndex >= 0);
  assert.ok(changesIndex > updateIndex);
  assert.match(html, /查看软件更新 0\.2\.0/);
  assert.match(html, /fp-app-shell/);
  assert.match(html, /fp-button[^"]*titlebar-update-toggle/);
  assert.match(html, /fp-icon-button titlebar-icon-button file-tree-toggle/);
  assert.match(html, /lucide-panel-left-open/);
  assert.match(html, /fp-icon-button titlebar-icon-button titlebar-changes-toggle/);
  assert.match(html, /fp-icon-button titlebar-icon-button app-settings-toggle/);
  assert.match(html, /fp-button[^"]*project-tab active/);
  assert.match(html, /fp-icon-button project-tab-close/);
  assert.match(html, /fp-button[^"]*project-tab add/);
  assert.equal(html.includes('prototype-shell'), false);
  assert.doesNotMatch(html, /<button[^>]*class="titlebar-icon-button/);
  assert.doesNotMatch(html, /<button[^>]*class="project-tab(?:\s|")/);
  assert.doesNotMatch(html, /<button[^>]*class="project-tab-close/);
});

test('titlebar left sidebar toggle uses a clear close icon while sidebar is open', () => {
  const html = renderAppShell(null, { leftCollapsed: false });

  assert.match(html, /fp-icon-button titlebar-icon-button file-tree-toggle active/);
  assert.match(html, /lucide-panel-left-close/);
});

test('titlebar hides update button when no update is available', () => {
  const html = renderAppShell(createUpdateSnapshot('not_available'));

  assert.equal(html.includes('titlebar-update-toggle'), false);
  assert.match(html, /titlebar-changes-toggle/);
});

test('app shell exposes a global keyboard command palette', () => {
  const html = renderAppShell(createUpdateSnapshot('not_available'), {
    defaultCommandPaletteOpen: true,
    onOpenAgentWorkspace: noop,
    onOpenProjectSettings: noop,
    onOpenAssets: noop
  });

  assert.match(html, /command-palette-toggle/);
  assert.match(html, /aria-keyshortcuts="Meta\+K Control\+K"/);
  assert.match(html, /data-command-palette-state="open"/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="命令面板"[^>]*tabindex="-1"/);
  assert.match(html, /command-palette-input/);
  assert.match(html, /data-command-id="open-agent"/);
  assert.match(html, /data-command-id="open-project-settings"/);
  assert.match(html, /data-command-id="open-assets"/);
  assert.match(html, /data-command-id="open-app-settings"/);
  assert.match(html, /data-command-id="switch-project-project_1"/);
});

test('welcome and onboarding actions render through shared buttons', () => {
  const project = {
    id: 'project_welcome',
    name: 'Bird',
    updatedAt: new Date().toISOString(),
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const welcomeHtml = renderZh(
    createElement(WelcomeScreen, {
      projects: [project],
      mcpPlugins: [],
      onCreate: noop,
      onOpen: noop,
      onOpenExisting: noop
    })
  );
  const baseOnboardingProps: Parameters<typeof OnboardingScreen>[0] = {
    step: 1,
    view: 'setup',
    mode: 'create',
    platform: 'web',
    dimension: 'unknown',
    projectName: 'Bird',
    projectPath: '/tmp/bird',
    unityEditors: [],
    selectedUnityEditorVersion: '',
    diagnostics: null,
    tasks: [],
    detectionMessage: '',
    detectionOk: true,
    actionMessage: '',
    isChecking: false,
    isCreatingProject: false,
    onModeChange: noop,
    onPlatformChange: noop,
    onDimensionChange: noop,
    onProjectNameChange: noop,
    onPathChange: noop,
    onUnityEditorVersionChange: noop,
    onBrowsePath: noop,
    onDetect: noop,
    onRunAction: noop,
    onBackToSetup: noop,
    onSkip: noop,
    onNext: noop,
    onEnter: noop
  };
  const setupHtml = renderZh(createElement(OnboardingScreen, baseOnboardingProps));
  const cocosSetupHtml = renderZh(
    createElement(OnboardingScreen, {
      ...baseOnboardingProps,
      platform: 'cocos',
      dimension: '3d'
    })
  );
  const environmentHtml = renderZh(
    createElement(OnboardingScreen, {
      ...baseOnboardingProps,
      view: 'environment',
      platform: 'unity',
      dimension: '2d',
      diagnostics: {
        platform: 'unity',
        mode: 'create',
        dimension: '2d',
        checkedAt: new Date().toISOString(),
        projectPath: '/tmp/bird',
        checks: [
          {
            id: 'engine-project',
            title: 'Unity Project',
            description: 'Create project',
            status: 'pending',
            detail: 'Waiting',
            actions: [
              {
                id: 'open_unity_project',
                label: 'Open Unity',
                description: 'Open project',
                primary: true
              }
            ]
          }
        ],
        ready: false
      }
    })
  );
  const completeHtml = renderZh(
    createElement(OnboardingScreen, {
      ...baseOnboardingProps,
      step: 3
    })
  );
  const combinedHtml = [welcomeHtml, setupHtml, environmentHtml, completeHtml].join('\n');

  assert.match(welcomeHtml, /新建项目/);
  assert.match(welcomeHtml, /fp-button[^"]*welcome-project/);
  assert.match(setupHtml, /进入工作台/);
  assert.match(environmentHtml, /Open Unity/);
  assert.match(completeHtml, /返回调整/);
  assert.match(combinedHtml, /fp-button-primary/);
  assert.match(combinedHtml, /fp-button-secondary/);
  assert.match(combinedHtml, /fp-field/);
  assert.match(combinedHtml, /fp-input/);
  assert.match(environmentHtml, /fp-select-trigger/);
  assert.match(setupHtml, /fp-button[^"]*setup-mode-card selected/);
  assert.match(setupHtml, /fp-button[^"]*platform-card selected/);
  assert.match(cocosSetupHtml, /支持 2D \/ 3D/);
  assert.match(cocosSetupHtml, /fp-button[^"]*setup-mode-card selected[\s\S]*3D 项目/);
  assert.equal(cocosSetupHtml.includes('disabled-card'), false);
  assert.doesNotMatch(cocosSetupHtml, /当前引擎暂不支持 3D/);
  assert.match(setupHtml, /onboarding-path-field/);
  assert.match(environmentHtml, /fp-button[^"]*wizard-step active/);
  assert.equal(combinedHtml.includes('prototype-primary'), false);
  assert.equal(combinedHtml.includes('prototype-secondary'), false);
  assert.equal(combinedHtml.includes('prototype-ghost'), false);
  assert.equal(combinedHtml.includes('class="field'), false);
  assert.doesNotMatch(setupHtml, /<button[^>]*class="setup-mode-card/);
  assert.doesNotMatch(setupHtml, /<button[^>]*class="platform-card/);
  assert.doesNotMatch(environmentHtml, /<button[^>]*class="wizard-step/);
  assert.doesNotMatch(welcomeHtml, /<button[^>]*class="welcome-project/);
});

test('chat composer exposes provider and Build/Plan controls without inline model/runtime selectors', () => {
  const buildHtml = renderComposer('full-access');
  const planHtml = renderComposer('read-only');
  const richHtml = renderComposer('full-access', undefined, {
    draft: '/',
    attachments: [
      {
        id: 'attachment_1',
        name: 'notes.md',
        path: '/tmp/notes.md',
        kind: 'file',
        size: 32
      }
    ] as PromptAttachment[]
  });

  assert.match(buildHtml, /Xiaomi MiMo/);
  assert.match(buildHtml, /Provider/);
  assert.match(buildHtml, /Build/);
  assert.match(planHtml, /Plan/);
  assert.match(buildHtml, /fp-icon-button agent-composer-icon-button/);
  assert.match(buildHtml, /agent-permission-trigger full-access/);
  assert.match(buildHtml, /agent-combo-trigger/);
  assert.match(buildHtml, /agent-send-button/);
  assert.match(buildHtml, /data-composer-state="idle"/);
  assert.match(richHtml, /data-composer-state="drafting"/);
  assert.match(buildHtml, /fp-textarea agent-composer-textarea/);
  assert.doesNotMatch(buildHtml, /<textarea[^>]*class="agent-composer-textarea/);
  assert.equal(buildHtml.includes('prototype-primary'), false);
  assert.equal(buildHtml.includes('prototype-secondary'), false);
  assert.equal(buildHtml.includes('>!<'), false);
  assert.equal(planHtml.includes('>!<'), false);
  assert.equal(buildHtml.includes('Runtime'), false);
  assert.equal(buildHtml.includes('模型、Runtime、模式'), false);
  assert.match(richHtml, /fp-button[^"]*agent-file-chip file/);
  assert.match(richHtml, /agent-command-popover/);
  assert.match(richHtml, /fp-button[^"]*fp-button-ghost/);
  assert.doesNotMatch(richHtml, /<button[^>]*class="agent-file-chip/);
  assert.doesNotMatch(richHtml, /<button[^>]*><strong>\/files/);
});

test('chat composer shows engine connection indicator only when an engine project provides status', () => {
  const genericHtml = renderComposer('full-access');
  const engineHtml = renderComposer('full-access', {
    platform: 'unity',
    status: 'connected',
    label: 'Unity 已连接'
  });

  assert.equal(genericHtml.includes('agent-engine-connection-indicator'), false);
  assert.match(engineHtml, /agent-engine-connection-indicator unity connected/);
  assert.match(engineHtml, /agent-engine-logo unity/);
  assert.match(engineHtml, /agent-engine-connection-dot connected/);
  assert.match(engineHtml, /Unity 已连接/);
});

test('failed write-like tool summaries keep the real error instead of saying updated', () => {
  const summary = summarizeToolResult(
    {
      id: 'tool_edit_failed',
      name: 'edit_file',
      status: 'failed',
      input: {
        path: 'js/crafting.js'
      },
      result: {
        content: '没有在 js/crafting.js 中找到 oldText。',
        isError: true,
        edit: {
          strategy: 'search_replace',
          patchFirst: false,
          preflight: 'failed',
          failureKind: 'unknown'
        }
      }
    },
    'zh-CN'
  );

  assert.match(summary.preview, /没有在 js\/crafting\.js 中找到 oldText/);
  assert.doesNotMatch(summary.preview, /已更新/);
});

test('assistant structured tool-only message does not render pseudo tool text as body fallback', () => {
  const message: ChatMessage = {
    id: 'msg_tool_only',
    role: 'assistant',
    content: '[Previous tool call] inspect_workspace_context input={"projectName":"Rogue"}',
    createdAt: new Date().toISOString(),
    metadata: {
      agentCoreParts: [
        {
          id: 'part_history_call',
          kind: 'tool_call',
          sequence: 0,
          createdAt: '2026-05-20T00:00:00.000Z',
          toolUseId: 'tool_history',
          name: 'inspect_workspace_context',
          input: {
            projectName: 'Rogue'
          },
          status: 'completed'
        },
        {
          id: 'part_history_result',
          kind: 'tool_result',
          sequence: 1,
          createdAt: '2026-05-20T00:00:01.000Z',
          toolUseId: 'tool_history',
          toolName: 'inspect_workspace_context',
          content: 'Workspace context inspected.'
        }
      ]
    }
  };

  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.equal(html.includes('[Previous tool call]'), false);
  assert.equal(html.includes('input={'), false);
  assert.match(html, /inspect_workspace_context/);
  assert.match(html, /Workspace context inspected/);
});

test('assistant Agent Core parts do not fall back to pseudo tool message content', () => {
  const message: ChatMessage = {
    id: 'msg_agent_core_no_pseudo_fallback',
    role: 'assistant',
    content: '[Tool] write_file { "path": "index.html", "content": "<!doctype html>" }',
    createdAt: new Date().toISOString(),
    metadata: {
      agentCoreParts: [
        {
          id: 'part_text_done',
          kind: 'assistant_text',
          createdAt: '2026-05-15T00:00:00.000Z',
          sequence: 0,
          text: '文件已经写入完成。'
        }
      ]
    }
  };

  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /文件已经写入完成/);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('write_file'), false);
  assert.equal(getMessagePlainText(message, false), '文件已经写入完成。');
});

test('completed message process summary prefers Agent Core parts over operation log', () => {
  const tools = buildCompletedMessageProcessTools({
    metadata: {
      operationLog: [
        {
          id: 'legacy_tool',
          type: 'tool_call',
          target: 'legacy_tool',
          title: 'Legacy tool',
          status: 'completed',
          createdAt: '2026-05-15T00:00:00.000Z'
        }
      ],
      agentCoreParts: [
        {
          id: 'part_tool',
          kind: 'tool_call',
          createdAt: '2026-05-15T00:00:00.000Z',
          sequence: 0,
          toolUseId: 'tool_core',
          name: 'read_file',
          input: {
            path: 'README.md'
          },
          status: 'completed'
        },
        {
          id: 'part_result',
          kind: 'tool_result',
          createdAt: '2026-05-15T00:00:01.000Z',
          sequence: 1,
          toolUseId: 'tool_core',
          toolName: 'read_file',
          content: 'README content'
        }
      ]
    }
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'read_file');
  assert.equal(tools[0]?.result?.content, 'README content');
});

test('completed message process summary treats Agent Core parts as authoritative', () => {
  const tools = buildCompletedMessageProcessTools({
    metadata: {
      operationLog: [
        {
          id: 'legacy_tool',
          type: 'tool_call',
          target: 'legacy_tool',
          title: 'Legacy tool',
          status: 'completed',
          createdAt: '2026-05-15T00:00:00.000Z'
        }
      ],
      agentCoreParts: [
        {
          id: 'part_text_only',
          kind: 'assistant_text',
          createdAt: '2026-05-15T00:00:00.000Z',
          sequence: 0,
          text: '只保留 canonical Agent Core 正文。'
        }
      ]
    }
  });

  assert.equal(tools.length, 0);
});

test('completed message process summary ignores operation log without Agent Core parts', () => {
  const tools = buildCompletedMessageProcessTools({
    metadata: {
      operationLog: [
        {
          id: 'tool_write',
          type: 'tool_call',
          target: 'write_file',
          title: 'write_file',
          status: 'completed',
          summary: '写入完成',
          transaction: {
            id: 'tool_txn:tool_write',
            toolUseId: 'tool_write',
            toolName: 'write_file',
            toolClass: 'workspace',
            phase: 'completed',
            status: 'completed',
            eventCount: 4,
            startedAt: '2026-05-15T00:00:00.000Z',
            updatedAt: '2026-05-15T00:00:02.000Z'
          }
        }
      ]
    }
  });

  assert.equal(tools.length, 0);
});

test('transcript view model groups Agent Core tool parts before final answer', () => {
  const items = buildTranscriptViewItems([
    {
      id: 'tool_call',
      kind: 'tool_call',
      createdAt: '2026-05-20T00:00:00.000Z',
      sequence: 0,
      toolUseId: 'tool_read',
      name: 'read_file',
      input: {
        path: 'README.md'
      },
      status: 'completed'
    },
    {
      id: 'tool_result',
      kind: 'tool_result',
      createdAt: '2026-05-20T00:00:01.000Z',
      sequence: 1,
      toolUseId: 'tool_read',
      toolName: 'read_file',
      content: 'README content'
    },
    {
      id: 'final_text',
      kind: 'assistant_text',
      createdAt: '2026-05-20T00:00:02.000Z',
      sequence: 2,
      text: '完成。'
    }
  ]);

  assert.equal(items.length, 2);
  const first = items[0];
  const second = items[1];
  assert.equal(first?.kind, 'tool_group');
  assert.equal(second?.kind, 'assistant_text');
  if (first?.kind !== 'tool_group' || second?.kind !== 'assistant_text') {
    throw new Error('Unexpected transcript view item types.');
  }
  assert.equal(first.status, 'completed');
  assert.equal(first.role, 'tool');
  assert.equal(first.displayKind, 'tool');
  assert.equal(first.detailView, 'overlay');
  assert.equal(first.stepKind, 'explore');
  assert.match(first.stepSummary.zhCN, /已探索 1 个文件/);
  assert.match(first.stepSummary.enUS, /Explored 1 file/);
  assert.equal(first.failureCount, 0);
  assert.equal(first.runningCount, 0);
  assert.equal(first.collapseBeforeAssistantText, true);
  assert.equal(first.tools[0]?.result?.content, 'README content');
  assert.equal(second.role, 'assistant');
  assert.equal(second.displayKind, 'text');
  assert.equal(second.detailView, 'none');
  assert.equal(second.copyText, '完成。');
});

test('transcript view model keeps tool steps interleaved with assistant narrative', () => {
  const items = buildTranscriptViewItems([
    {
      id: 'tool_read_call',
      kind: 'tool_call',
      createdAt: '2026-05-20T00:00:00.000Z',
      sequence: 0,
      toolUseId: 'tool_read',
      name: 'read_file',
      input: {
        path: 'README.md'
      },
      status: 'completed'
    },
    {
      id: 'tool_read_result',
      kind: 'tool_result',
      createdAt: '2026-05-20T00:00:01.000Z',
      sequence: 1,
      toolUseId: 'tool_read',
      toolName: 'read_file',
      content: 'README content'
    },
    {
      id: 'middle_text',
      kind: 'assistant_text',
      createdAt: '2026-05-20T00:00:02.000Z',
      sequence: 2,
      text: '我先确认了入口，现在改代码。'
    },
    {
      id: 'tool_edit_call',
      kind: 'tool_call',
      createdAt: '2026-05-20T00:00:03.000Z',
      sequence: 3,
      toolUseId: 'tool_edit',
      name: 'apply_patch',
      input: {
        file: 'src/App.tsx'
      },
      status: 'completed'
    },
    {
      id: 'tool_edit_result',
      kind: 'tool_result',
      createdAt: '2026-05-20T00:00:04.000Z',
      sequence: 4,
      toolUseId: 'tool_edit',
      toolName: 'apply_patch',
      content: 'Patch applied'
    }
  ]);

  assert.deepEqual(
    items.map((item) => item.kind),
    ['tool_group', 'assistant_text', 'tool_group']
  );
  const first = items[0];
  const third = items[2];
  if (first?.kind !== 'tool_group' || third?.kind !== 'tool_group') {
    throw new Error('Expected tool groups around assistant text.');
  }
  assert.equal(first.stepKind, 'explore');
  assert.equal(third.stepKind, 'edit');
  assert.match(third.stepSummary.zhCN, /已编辑 1 个文件/);
});

test('user transcript renders attachments above a compact right-side bubble', () => {
  const message: ChatMessage = {
    id: 'msg_user_attachment',
    role: 'user',
    content: '帮我参考这张图调整 UI。',
    createdAt: new Date().toISOString(),
    metadata: {
      promptAttachments: [
        {
          id: 'attachment_image',
          name: 'image.png',
          path: '/tmp/image.png',
          kind: 'image',
          mimeType: 'image/png',
          size: 128,
          previewDataUrl: 'data:image/png;base64,ZmFrZQ=='
        }
      ]
    }
  };

  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /chat-transcript-row user/);
  assert.match(html, /chat-transcript-bubble user/);
  assert.match(html, /chat-user-attachments/);
  assert.match(html, /chat-user-attachment-chip image/);
  assert.match(html, /image\.png/);
  assert.match(html, /帮我参考这张图调整 UI/);
  assert.doesNotMatch(html, /Attached files staged for this message/);
});

test('completed message process summary preserves Agent Core transactions', () => {
  const tools = buildCompletedMessageProcessTools({
    metadata: {
      agentCoreParts: [
        {
          id: 'part_read',
          kind: 'tool_call',
          createdAt: '2026-05-15T00:00:00.000Z',
          sequence: 0,
          toolUseId: 'tool_read',
          name: 'read_file',
          input: {
            path: 'README.md'
          },
          status: 'completed'
        },
        {
          id: 'part_read_result',
          kind: 'tool_result',
          createdAt: '2026-05-15T00:00:01.000Z',
          sequence: 1,
          toolUseId: 'tool_read',
          toolName: 'read_file',
          content: 'README content',
          transaction: {
            id: 'tool_txn:tool_read',
            toolUseId: 'tool_read',
            toolName: 'read_file',
            toolClass: 'workspace',
            phase: 'completed',
            status: 'completed',
            eventCount: 3,
            startedAt: '2026-05-15T00:00:00.000Z',
            updatedAt: '2026-05-15T00:00:01.000Z'
          }
        }
      ]
    }
  });

  assert.equal(tools[0]?.result?.transaction?.toolName, 'read_file');
});

test('assistant pseudo tool-only raw content is not rendered or searchable as final text', () => {
  const message: ChatMessage = {
    id: 'msg_raw_pseudo_tool_only',
    role: 'assistant',
    content: '[Previous tool call] inspect_workspace_context (tool_p1xqlj4e) input={"projectName":"Rogue"}',
    createdAt: new Date().toISOString()
  };

  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.equal(html.includes('[Previous tool call]'), false);
  assert.equal(html.includes('inspect_workspace_context'), false);
  assert.equal(getMessagePlainText(message, false), '');
});

test('completed assistant transcript keeps token usage in developer mode only', () => {
  const message: ChatMessage = {
    id: 'msg_token_usage',
    role: 'assistant',
    content: '已完成。',
    createdAt: '2026-05-12T00:00:02.000Z',
    metadata: {
      agentStartedAt: '2026-05-12T00:00:00.000Z',
      agentFinishedAt: '2026-05-12T00:00:02.000Z',
      tokenUsage: {
        turns: 2,
        inputTokens: 1200,
        outputTokens: 340,
        cacheCreationTokens: 20,
        cacheReadTokens: 80,
        totalTokens: 1640
      }
    }
  };

  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /已处理 2s/);
  assert.doesNotMatch(html, /Token 1\.6k/);
  assert.doesNotMatch(html, /输入 1\.2k/);

  const developerHtml = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: true,
      onOpenPath: noop
    })
  );

  assert.match(developerHtml, /Token 1\.6k/);
  assert.match(developerHtml, /输入 1\.2k/);
  assert.match(developerHtml, /输出 340/);
  assert.match(developerHtml, /缓存 100/);
  assert.match(developerHtml, /2 次/);
});

test('completed assistant transcript ignores legacy operation log in ordinary chat rendering', () => {
  const message: ChatMessage = {
    id: 'msg_legacy_operation_log',
    role: 'assistant',
    content: '最终答复只显示正文。',
    createdAt: new Date().toISOString(),
    metadata: {
      operationLog: [
        {
          id: 'legacy_tool',
          type: 'tool_call',
          target: 'legacy_tool',
          title: 'Legacy tool',
          status: 'completed',
          createdAt: '2026-05-15T00:00:00.000Z'
        }
      ]
    }
  };

  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /最终答复只显示正文/);
  assert.doesNotMatch(html, /Legacy tool/);
  assert.doesNotMatch(html, /legacy_tool/);
});

test('streaming transcript shows unified thinking status and structured tool activity', () => {
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '读取 notes.md',
      startedAt: new Date(Date.now() - 74000).toISOString(),
      content: '',
      thinkingContent: '',
      toolUses: [
        {
          toolUseId: 'tool_read',
          name: 'read_file',
          input: {
            path: 'notes.md'
          },
          status: 'completed'
        }
      ],
      toolResults: [
        {
          toolUseId: 'tool_read',
          content: 'mimo-live-tool-fixture-748219',
          changedFiles: [
            {
              path: 'src/app.ts',
              operation: 'patched',
              hunkCount: 2
            }
          ],
          edit: {
            strategy: 'unified_patch',
            patchFirst: true,
            preflight: 'passed',
            hunkCount: 2
          },
          browser: {
            sessionId: 'browser_fixture',
            title: 'Fixture Page',
            consoleMessageCount: 0
          },
          mcp: {
            pluginId: 'plugin_unity',
            operation: 'call_tool',
            target: 'unity.echo',
            exposedName: 'mcp__unity__unity_echo',
            policySummary: 'MCP policy inferred: permission=ask, risk=write',
            timeoutMs: 30000,
            schemaGuard: 'passed'
          },
          artifacts: [
            {
              type: 'browser_screenshot',
              path: '/tmp/funplay-browser.png',
              title: 'Browser screenshot'
            }
          ]
        }
      ],
      stages: [],
      activityItems: [
        {
          id: 'activity_tool_read',
          type: 'tool',
          offset: 0,
          status: 'completed',
          title: 'tool_completed',
          summary: 'read_file completed',
          toolUseIds: ['tool_read'],
          createdAt: new Date().toISOString()
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  assert.match(html, /chat-transcript-elapsed/);
  assert.match(html, /1m/);
  assert.match(html, /正在思考中/);
  assert.equal(html.includes('chat-run-status-panel'), false);
  assert.equal(html.includes('有新的输出、工具结果或任务状态时会持续更新'), false);
  assert.match(html, /notes\.md/);
  assert.match(html, /fp-button[^"]*chat-tool-activity-summary/);
  assert.match(html, /mimo-live-tool-fixture-748219/);
  assert.match(html, /src\/app\.ts/);
  assert.match(html, /tool-detail-change-line/);
  assert.match(html, /fp-button[^"]*fp-button-ghost/);
  assert.doesNotMatch(html, /chat-tool-result-file-list/);
  assert.doesNotMatch(html, /funplay-browser\.png/);
  assert.match(html, /tool-detail-disclosure/);
  assert.match(html, /tool-detail-trigger/);
  assert.equal(html.includes('正在执行兼容工具调用'), false);
  assert.equal(html.includes('正在执行工具调用'), false);
  assert.equal(html.includes('查看细节'), false);
  assert.equal(html.includes('View details'), false);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('Previous tool call'), false);
});

test('agent chat view forwards stream start time to the live transcript timer', () => {
  const session: ProjectSession = {
    id: 'session_live_timer',
    title: 'Live timer',
    autoTitle: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chat: []
  };
  const project = {
    id: 'project_live_timer',
    name: 'Bird',
    activeSessionId: session.id,
    updatedAt: new Date().toISOString(),
    sessions: [session],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;

  const html = renderZh(
    createElement(AgentChatView, {
      project,
      provider,
      providers: [provider],
      permissionMode: 'full-access',
      openablePaths: [],
      sessionEffort: 'auto',
      composerDraft: '',
      composerAttachments: [],
      activePromptStream: {
        streamId: 'stream_live_timer',
        projectId: project.id,
        sessionId: session.id,
        prompt: '让游戏精品一点',
        attachments: [
          {
            id: 'attachment_icon',
            name: 'icon.png',
            path: '/tmp/icon.png',
            kind: 'image',
            size: 128,
            mimeType: 'image/png'
          }
        ],
        content: '',
        thinkingContent: '',
        toolUses: [],
        toolResults: [],
        stages: [],
        activityItems: [],
        agentCoreParts: [],
        phase: 'streaming',
        statusMessage: '正在实时生成回复...',
        startedAt: new Date(Date.now() - 74000).toISOString()
      },
      developerMode: false,
      composerError: '',
      queuedPrompts: [],
      isSending: true,
      onComposerChange: noop,
      onPickAttachments: noop,
      onImportAttachments: noop,
      onRemoveAttachment: noop,
      onSubmit: noop,
      onQueuePrompt: noop,
      onRemoveQueuedPrompt: noop,
      onCancelStream: noop,
      onRespondPermission: noop,
      onRespondUserInput: noop,
      onUpdateSessionRuntime: noop,
      onUpdatePermissionMode: noop,
      onOpenAppSettings: noop,
      onOpenProjectAgentSettings: noop,
      onDiagnoseEnvironment: async () => ({
        platform: 'web',
        mode: 'import',
        dimension: 'unknown',
        checkedAt: new Date().toISOString(),
        checks: [],
        ready: true
      }),
      onRunEnvironmentAction: async () => ({
        action: 'refresh_engine_runtime_state',
        status: 'completed',
        message: 'ok'
      }),
      onRefreshProjectRuntimeState: async () => project,
      onOpenFilePath: noop,
      onRestoreCheckpoint: noop
    })
  );

  assert.match(html, /正在处理/);
  assert.match(html, /正在实时生成回复/);
  assert.match(html, /chat-transcript-elapsed/);
  assert.match(html, /1m/);
  assert.match(html, /icon\.png/);
});

test('completed transcript inline controls render through shared buttons', () => {
  const message: ChatMessage = {
    id: 'msg_inline_controls',
    role: 'assistant',
    content: [
      'Open `src/App.tsx`, visit https://example.com, and inspect [local](/tmp/funplay-note.md).',
      '',
      '```ts',
      'const ok = true;',
      '```'
    ].join('\n'),
    createdAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: ['src/App.tsx'],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /fp-button[^"]*chat-inline-path/);
  assert.match(html, /fp-button[^"]*chat-inline-link/);
  assert.match(html, /fp-button[^"]*chat-inline-file/);
  assert.match(html, /fp-button[^"]*chat-transcript-copy/);
  assert.match(html, /fp-button[^"]*chat-code-copy/);
  assert.doesNotMatch(html, /<button[^>]*class="chat-inline-path/);
  assert.doesNotMatch(html, /<button[^>]*class="chat-inline-link/);
  assert.doesNotMatch(html, /<button[^>]*class="chat-inline-file/);
  assert.doesNotMatch(html, /<button[^>]*class="chat-code-copy/);
});

test('plain text fenced blocks render without a labeled code chrome', () => {
  const message: ChatMessage = {
    id: 'msg_plain_text_fence',
    role: 'assistant',
    content: ['已修改文件', '', '```text', 'index.html', 'style.css', 'game.js', '```'].join('\n'),
    createdAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /chat-plain-text-block/);
  assert.match(html, /index\.html/);
  assert.doesNotMatch(html, /chat-code-language/);
  assert.doesNotMatch(html, /chat-code-copy/);
});

test('unlabeled prose fences render as plain text instead of code cards', () => {
  const message: ChatMessage = {
    id: 'msg_unlabeled_prose_fence',
    role: 'assistant',
    content: [
      '1. 描述要具体明确',
      '',
      '```',
      '差的提示："帮我做一个贪吃蛇游戏"',
      '好的提示："用 HTML5 Canvas 做一个贪吃蛇游戏，支持方向键控制"',
      '```',
      '',
      '```code',
      '推荐提示中明确指定：',
      '- 使用纯 HTML + CSS + JavaScript',
      '- 使用 Canvas 2D 绘图',
      '```'
    ].join('\n'),
    createdAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /chat-plain-text-block/);
  assert.match(html, /差的提示/);
  assert.match(html, /推荐提示中明确指定/);
  assert.doesNotMatch(html, /chat-code-card/);
  assert.doesNotMatch(html, /chat-code-language/);
});

test('unlabeled source fences still render as code cards', () => {
  const message: ChatMessage = {
    id: 'msg_unlabeled_source_fence',
    role: 'assistant',
    content: [
      '入口代码：',
      '',
      '```',
      'const canvas = document.getElementById("game");',
      'const ctx = canvas.getContext("2d");',
      'function draw() {',
      '  ctx.fillRect(0, 0, 16, 16);',
      '}',
      '```'
    ].join('\n'),
    createdAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /chat-code-card/);
  assert.match(html, /chat-code-language/);
  assert.match(html, /const canvas/);
});

test('standalone markdown thematic breaks render as visible separators', () => {
  const message: ChatMessage = {
    id: 'msg_markdown_dividers',
    role: 'assistant',
    content: ['项目目标', '是否适合后续做成移动端游戏', '---', '2. 市场定位', '目标市场', '---', '3. 核心卖点'].join(
      '\n'
    ),
    createdAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.equal((html.match(/chat-rich-divider/g) ?? []).length, 2);
  assert.match(html, /<hr[^>]*class="chat-rich-divider"/);
  assert.doesNotMatch(html, />---</);
});

test('chat markdown renders GFM lists tables and file paths through the unified renderer', () => {
  const message: ChatMessage = {
    id: 'msg_markdown_gfm',
    role: 'assistant',
    content: [
      '执行顺序：',
      '',
      '1. 读取 `src/game/levels.json`',
      '2. 调整难度',
      '',
      '- [x] 已生成地图',
      '- [ ] 待验证音效',
      '',
      '| 模块 | 状态 |',
      '| --- | --- |',
      '| 关卡 | 完成 |',
      '',
      '更多细节见 src/game/levels.json'
    ].join('\n'),
    createdAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: ['src/game/levels.json'],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /chat-rich-list-block ordered/);
  assert.match(html, /chat-rich-list-block unordered/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /chat-rich-table/);
  assert.match(html, /fp-button[^"]*chat-inline-path/);
});

test('composer live status renders running animation and task checklist above input', () => {
  const html = renderZh(
    createElement(ChatComposer, {
      draft: '',
      attachments: [] as PromptAttachment[],
      contextUsage,
      error: '',
      queuedPrompts: [],
      isSending: true,
      isExecutingPlan: false,
      statusMessage: '正在思考中...',
      runtimeTaskSummary: {
        total: 10,
        completed: 9,
        inProgress: 1,
        pending: 0,
        cancelled: 0,
        items: Array.from({ length: 10 }, (_, index) => ({
          id: `${index + 1}`,
          content: index === 9 ? '最终验收' : `任务 ${index + 1}`,
          status: index === 9 ? ('in_progress' as const) : ('completed' as const),
          priority: index < 5 ? ('high' as const) : ('medium' as const)
        }))
      },
      permissionLabel: 'Build',
      activeProviderLabel: 'Xiaomi MiMo',
      providers: [provider],
      defaultProviderId: provider.id,
      activeProviderId: provider.id,
      permissionMode: 'full-access',
      onDraftChange: noop,
      onPickAttachments: noop,
      onRemoveAttachment: noop,
      onSubmit: noop,
      onCancelStream: noop,
      onRespondPermission: noop,
      onRespondUserInput: noop,
      onUpdateSessionRuntime: noop,
      onUpdatePermissionMode: noop,
      onRemoveQueuedPrompt: noop,
      onOpenAppSettings: noop,
      onOpenProjectAgentSettings: noop
    })
  );

  assert.match(html, /agent-live-status/);
  assert.match(html, /agent-live-spinner/);
  assert.match(html, /fp-button-secondary/);
  assert.match(html, /正在思考中/);
  assert.match(html, /任务清单/);
  assert.match(html, /任务 1/);
  assert.match(html, /最终验收/);
  assert.match(html, /9\/10 完成/);
  assert.match(html, /停止/);
});

test('composer compacts task checklist while waiting for user input', () => {
  const html = renderZh(
    createElement(ChatComposer, {
      draft: '',
      attachments: [] as PromptAttachment[],
      contextUsage,
      error: '',
      queuedPrompts: [],
      isSending: true,
      isExecutingPlan: false,
      statusMessage: '等待用户回答…',
      runtimeTaskSummary: {
        total: 8,
        completed: 1,
        inProgress: 0,
        pending: 7,
        cancelled: 0,
        items: Array.from({ length: 8 }, (_, index) => ({
          id: `${index + 1}`,
          content: `任务 ${index + 1}`,
          status: index === 0 ? ('completed' as const) : ('pending' as const),
          priority: index < 2 ? ('high' as const) : ('medium' as const)
        }))
      },
      pendingUserInput: {
        requestId: 'ask_scope',
        title: '确认游戏核心玩法范围',
        question: '你最想先实现哪些核心玩法？',
        options: [
          { id: 'platformer', label: '基础平台跳跃 + 方块破坏', description: '先做可移动角色和可破坏方块世界' },
          { id: 'combat', label: '战斗探索优先', description: '优先实现角色攻击、敌人 AI 和战斗系统' },
          { id: 'building', label: '建造系统优先', description: '优先实现方块放置、建筑和物品系统' },
          { id: 'prototype', label: '完整最小原型', description: '包含移动、挖掘、建造、简单敌人和物品栏' }
        ],
        allowFreeText: true
      },
      permissionLabel: 'Build',
      activeProviderLabel: 'Xiaomi MiMo',
      providers: [provider],
      defaultProviderId: provider.id,
      activeProviderId: provider.id,
      permissionMode: 'full-access',
      onDraftChange: noop,
      onPickAttachments: noop,
      onRemoveAttachment: noop,
      onSubmit: noop,
      onCancelStream: noop,
      onRespondPermission: noop,
      onRespondUserInput: noop,
      onUpdateSessionRuntime: noop,
      onUpdatePermissionMode: noop,
      onRemoveQueuedPrompt: noop,
      onOpenAppSettings: noop,
      onOpenProjectAgentSettings: noop
    })
  );

  assert.match(html, /agent-composer-status-stack awaiting-user-input/);
  assert.match(html, /agent-live-status compact/);
  assert.match(html, /1\/8 完成/);
  assert.equal(html.includes('任务 1'), false);
  assert.equal(html.includes('任务 3'), false);
  assert.equal(html.includes('任务 4'), false);
  assert.match(html, /确认游戏核心玩法范围/);
  assert.match(html, /完整最小原型/);
  assert.match(html, /提交回答/);
  assert.match(html, /agent-user-input-options/);
  assert.match(html, /fp-textarea agent-user-input-textarea/);
  assert.doesNotMatch(html, /<textarea[^>]*class="agent-user-input-textarea/);
  assert.match(html, /fp-button-primary/);
  assert.equal(html.includes('prototype-primary'), false);
  assert.equal(html.includes('prototype-secondary'), false);
});

test('notification toast dismiss uses shared icon button', () => {
  const html = renderZh(
    createElement(NotificationToastStack, {
      notifications: [
        {
          id: 'notification_1',
          title: '任务已完成',
          body: 'Agent 已完成本轮任务。',
          priority: 'normal',
          createdAt: new Date().toISOString()
        }
      ],
      onDismiss: noop
    })
  );

  assert.match(html, /notification-toast-stack/);
  assert.match(html, /fp-icon-button notification-toast-dismiss/);
  assert.doesNotMatch(html, /<button[^>]*class="notification-toast-dismiss/);
});

test('streaming transcript interleaves assistant text and tool activity by offset', () => {
  const first = '我先看一下项目结构。\n\n';
  const second = '已经确认入口文件。\n\n';
  const third = '下一步修复样式。';
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '修复页面样式',
      content: `${first}${second}${third}`,
      thinkingContent: '',
      toolUses: [
        {
          toolUseId: 'tool_read_notes',
          name: 'read_file',
          input: {
            path: 'notes.md'
          },
          status: 'completed'
        },
        {
          toolUseId: 'tool_patch_app',
          name: 'edit_file',
          input: {
            path: 'src/app.ts'
          },
          status: 'completed'
        }
      ],
      toolResults: [
        {
          toolUseId: 'tool_read_notes',
          content: 'notes fixture content'
        },
        {
          toolUseId: 'tool_patch_app',
          content: 'patched src/app.ts',
          changedFiles: [
            {
              path: 'src/app.ts',
              operation: 'patched',
              hunkCount: 1
            }
          ]
        }
      ],
      stages: [],
      activityItems: [
        {
          id: 'tool:tool_read_notes',
          type: 'tool',
          offset: first.length,
          status: 'completed',
          title: 'tool_completed',
          summary: 'read_file',
          toolUseIds: ['tool_read_notes'],
          createdAt: '2026-05-11T00:00:00.000Z'
        },
        {
          id: 'tool:tool_patch_app',
          type: 'tool',
          offset: `${first}${second}`.length,
          status: 'completed',
          title: 'tool_completed',
          summary: 'edit_file',
          toolUseIds: ['tool_patch_app'],
          createdAt: '2026-05-11T00:00:01.000Z'
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: ['notes.md', 'src/app.ts'],
      onOpenPath: noop
    })
  );

  const firstIndex = html.indexOf('我先看一下项目结构');
  const readIndex = html.indexOf('notes.md');
  const secondIndex = html.indexOf('已经确认入口文件');
  const patchIndex = html.indexOf('src/app.ts');
  const thirdIndex = html.indexOf('下一步修复样式');

  assert.ok(firstIndex >= 0);
  assert.ok(readIndex > firstIndex);
  assert.ok(secondIndex > readIndex);
  assert.ok(patchIndex > secondIndex);
  assert.ok(thirdIndex > patchIndex);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('Previous tool call'), false);
});

test('streaming transcript renders stable markdown and keeps the live tail lightweight', () => {
  const processHtml = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '解释方案',
      content: '**第一段**\n\n- 继续输出',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      statusMessage: '正在生成...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );
  const agentCoreHtml = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '解释方案',
      content: '**不应显示这一段**',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      agentCoreParts: [
        {
          id: 'live_text',
          kind: 'assistant_text',
          createdAt: '2026-05-16T00:00:00.000Z',
          sequence: 0,
          text: '**第二段**\n\n- 继续输出'
        }
      ],
      statusMessage: '正在生成...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  assert.match(processHtml, /chat-streaming-text-line/);
  assert.match(agentCoreHtml, /chat-streaming-text-line/);
  assert.match(processHtml, /chat-streaming-markdown-prefix/);
  assert.match(agentCoreHtml, /chat-streaming-markdown-prefix/);
  assert.match(processHtml, /<strong>第一段<\/strong>/);
  assert.match(agentCoreHtml, /<strong>第二段<\/strong>/);
  assert.match(processHtml, />- 继续输出<\/div>/);
  assert.match(agentCoreHtml, />- 继续输出<\/div>/);
  assert.equal(agentCoreHtml.includes('不应显示这一段'), false);
});

test('streaming tool entries preserve transaction summaries for live tool cards', () => {
  const tools = pairStreamingToolExecutions(
    [
      {
        toolUseId: 'tool_read_notes',
        name: 'read_file',
        input: {
          path: 'notes.md'
        },
        status: 'completed'
      }
    ],
    [
      {
        toolUseId: 'tool_read_notes',
        content: 'notes fixture content',
        transaction: {
          id: 'tool_txn:tool_read_notes',
          toolUseId: 'tool_read_notes',
          toolName: 'read_file',
          toolClass: 'workspace',
          phase: 'completed',
          status: 'completed',
          eventCount: 3,
          startedAt: '2026-05-11T00:00:00.000Z',
          updatedAt: '2026-05-11T00:00:01.000Z'
        }
      }
    ]
  );

  assert.equal(tools[0]?.result?.transaction?.toolName, 'read_file');
  assert.equal(tools[0]?.result?.transaction?.status, 'completed');
});

test('streaming transcript can render directly from Agent Core parts', () => {
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '继续实现',
      content: '[Tool] write_file {"path":"index.html"}',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      agentCoreParts: [
        {
          id: 'stream_text',
          kind: 'assistant_text',
          createdAt: '2026-05-16T00:00:00.000Z',
          sequence: 0,
          text: '我会先写入口文件。'
        },
        {
          id: 'stream_tool_call',
          kind: 'tool_call',
          createdAt: '2026-05-16T00:00:01.000Z',
          sequence: 1,
          toolUseId: 'tool_write',
          name: 'write_file',
          input: {
            path: 'index.html'
          },
          status: 'completed'
        },
        {
          id: 'stream_tool_result',
          kind: 'tool_result',
          createdAt: '2026-05-16T00:00:02.000Z',
          sequence: 2,
          toolUseId: 'tool_write',
          toolName: 'write_file',
          content: '已写入 index.html。'
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  assert.match(html, /我会先写入口文件/);
  assert.match(html, /index\.html/);
  assert.match(html, /已更新 index\.html/);
  assert.match(html, /chat-assistant-answer/);
  assert.equal(html.includes('[Tool]'), false);
});

test('agent core tool process collapses before final answer text', () => {
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '修复测试',
      content: '',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      agentCoreParts: [
        {
          id: 'stream_tool_call_failed',
          kind: 'tool_call',
          createdAt: '2026-05-16T00:00:01.000Z',
          sequence: 0,
          toolUseId: 'tool_test',
          name: 'run_command',
          input: {
            command: 'npm test'
          },
          status: 'failed'
        },
        {
          id: 'stream_tool_error',
          kind: 'tool_error',
          createdAt: '2026-05-16T00:00:02.000Z',
          sequence: 1,
          toolUseId: 'tool_test',
          toolName: 'run_command',
          error: '测试失败。'
        },
        {
          id: 'stream_final_text',
          kind: 'assistant_text',
          createdAt: '2026-05-16T00:00:03.000Z',
          sequence: 2,
          text: '结论：需要先修复断言。'
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  const toolIndex = html.indexOf('chat-tool-step failed collapsed');
  const finalTextIndex = html.indexOf('结论：需要先修复断言');
  assert.ok(toolIndex >= 0);
  assert.ok(finalTextIndex > toolIndex);
  assert.doesNotMatch(html, /有操作失败/);
  assert.doesNotMatch(html, /操作失败/);
  assert.match(html, /1 个失败/);
});

test('streaming transcript merges multiple tools at the same text boundary', () => {
  const first = '我先快速摸一下项目结构。\n\n';
  const second = '现在开始改渲染。';
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '优化工具过程显示',
      content: `${first}${second}`,
      thinkingContent: '',
      toolUses: [
        {
          toolUseId: 'tool_read_a',
          name: 'read_file',
          input: {
            path: 'src/A.tsx'
          },
          status: 'completed'
        },
        {
          toolUseId: 'tool_read_b',
          name: 'read_file',
          input: {
            path: 'src/B.tsx'
          },
          status: 'completed'
        },
        {
          toolUseId: 'tool_search',
          name: 'search_project_content',
          input: {
            query: 'ToolActivityGroup'
          },
          status: 'completed'
        },
        {
          toolUseId: 'tool_test',
          name: 'run_command',
          input: {
            command: 'npm test'
          },
          status: 'completed'
        }
      ],
      toolResults: [
        {
          toolUseId: 'tool_read_a',
          content: 'A content'
        },
        {
          toolUseId: 'tool_read_b',
          content: 'B content'
        },
        {
          toolUseId: 'tool_search',
          content: 'Search results'
        },
        {
          toolUseId: 'tool_test',
          content: 'Tests passed'
        }
      ],
      stages: [],
      activityItems: [
        {
          id: 'tool:tool_read_a',
          type: 'tool',
          offset: first.length,
          status: 'completed',
          title: 'tool_completed',
          toolUseIds: ['tool_read_a'],
          createdAt: '2026-05-11T00:00:00.000Z'
        },
        {
          id: 'tool:tool_read_b',
          type: 'tool',
          offset: first.length,
          status: 'completed',
          title: 'tool_completed',
          toolUseIds: ['tool_read_b'],
          createdAt: '2026-05-11T00:00:01.000Z'
        },
        {
          id: 'tool:tool_search',
          type: 'tool',
          offset: first.length,
          status: 'completed',
          title: 'tool_completed',
          toolUseIds: ['tool_search'],
          createdAt: '2026-05-11T00:00:02.000Z'
        },
        {
          id: 'tool:tool_test',
          type: 'tool',
          offset: first.length,
          status: 'completed',
          title: 'tool_completed',
          toolUseIds: ['tool_test'],
          createdAt: '2026-05-11T00:00:03.000Z'
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: ['src/A.tsx', 'src/B.tsx'],
      onOpenPath: noop
    })
  );

  const firstIndex = html.indexOf('我先快速摸一下项目结构');
  const summaryIndex = html.indexOf('探索 2 个文件');
  const secondIndex = html.indexOf('现在开始改渲染');
  const groupCount = (html.match(/chat-tool-activity completed/g) ?? []).length;

  assert.ok(firstIndex >= 0);
  assert.ok(summaryIndex > firstIndex);
  assert.ok(secondIndex > summaryIndex);
  assert.match(html, /搜索 1 次/);
  assert.match(html, /运行 1 条命令/);
  assert.equal(groupCount, 1);
  assert.equal(html.includes('查看细节'), false);
  assert.equal(html.includes('View details'), false);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('Previous tool call'), false);
});

test('streaming process timeline collapses tool details before final text', () => {
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '检查失败原因',
      content: '结论：测试失败来自快照不匹配。',
      thinkingContent: '',
      toolUses: [
        {
          toolUseId: 'tool_test_failed',
          name: 'run_command',
          input: {
            command: 'npm test'
          },
          status: 'failed'
        }
      ],
      toolResults: [
        {
          toolUseId: 'tool_test_failed',
          content: 'Snapshot failed',
          isError: true
        }
      ],
      stages: [],
      activityItems: [
        {
          id: 'tool:tool_test_failed',
          type: 'tool',
          offset: 0,
          status: 'failed',
          title: 'tool_failed',
          toolUseIds: ['tool_test_failed'],
          createdAt: '2026-05-11T00:00:00.000Z'
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  const toolIndex = html.indexOf('chat-tool-activity failed collapsed');
  const finalTextIndex = html.indexOf('结论：测试失败来自快照不匹配');
  assert.ok(toolIndex >= 0);
  assert.ok(finalTextIndex > toolIndex);
  assert.doesNotMatch(html, /有操作失败/);
  assert.doesNotMatch(html, /操作失败/);
  assert.doesNotMatch(html, /1 个失败/);
});

test('streaming transcript renders todo tool as task list activity', () => {
  const intro = '我先拆一下任务。\n\n';
  const html = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '实现一个复杂后端系统',
      content: `${intro}开始按清单执行。`,
      thinkingContent: '',
      toolUses: [
        {
          toolUseId: 'tool_todo',
          name: 'update_todo_list',
          input: {
            todos: [
              {
                id: 'api',
                content: '实现 API 层',
                status: 'in_progress',
                priority: 'high'
              },
              {
                id: 'test',
                content: '补充测试',
                status: 'pending',
                priority: 'medium'
              }
            ]
          },
          status: 'completed'
        }
      ],
      toolResults: [
        {
          toolUseId: 'tool_todo',
          content:
            '任务清单已更新（2 项）：\n- [in_progress] api (high): 实现 API 层\n- [pending] test (medium): 补充测试'
        }
      ],
      stages: [],
      activityItems: [
        {
          id: 'tool:tool_todo',
          type: 'tool',
          offset: intro.length,
          status: 'completed',
          title: 'tool_completed',
          summary: 'update_todo_list',
          toolUseIds: ['tool_todo'],
          createdAt: '2026-05-11T00:00:04.000Z'
        }
      ],
      statusMessage: '正在思考中...',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  assert.match(html, /更新 1 次任务清单/);
  assert.match(html, /任务清单/);
  assert.match(html, /实现 API 层/);
  assert.match(html, /更新任务清单/);
  assert.match(html, /任务清单已更新/);
  assert.equal(html.includes('update_todo_list'), false);
  assert.equal(html.includes('处理 1 个工具'), false);
});

test('completed assistant transcript can replay persisted process text with inline tools', () => {
  const first = '先读取配置。\n\n';
  const second = '再写入修复。\n\n';
  const final = '修复完成。';
  const message: ChatMessage = {
    id: 'msg_completed_process',
    role: 'assistant',
    content: final,
    createdAt: new Date().toISOString(),
    metadata: {
      agentCoreParts: [
        {
          id: 'part_first_text',
          kind: 'assistant_text',
          sequence: 0,
          createdAt: '2026-05-11T00:00:00.000Z',
          text: first
        },
        {
          id: 'part_read_config',
          kind: 'tool_call',
          sequence: 1,
          createdAt: '2026-05-11T00:00:01.000Z',
          toolUseId: 'tool_read_config',
          name: 'read_file',
          input: {
            path: 'config.json'
          },
          status: 'completed'
        },
        {
          id: 'part_read_config_result',
          kind: 'tool_result',
          sequence: 2,
          createdAt: '2026-05-11T00:00:02.000Z',
          toolUseId: 'tool_read_config',
          toolName: 'read_file',
          content: 'config fixture'
        },
        {
          id: 'part_second_text',
          kind: 'assistant_text',
          sequence: 3,
          createdAt: '2026-05-11T00:00:03.000Z',
          text: second
        },
        {
          id: 'part_write_config',
          kind: 'tool_call',
          sequence: 4,
          createdAt: '2026-05-11T00:00:04.000Z',
          toolUseId: 'tool_write_config',
          name: 'write_file',
          input: {
            path: 'config.json'
          },
          status: 'completed'
        },
        {
          id: 'part_write_config_result',
          kind: 'tool_result',
          sequence: 5,
          createdAt: '2026-05-11T00:00:05.000Z',
          toolUseId: 'tool_write_config',
          toolName: 'write_file',
          content: '已写入 config.json (42 bytes)'
        },
        {
          id: 'part_final_text',
          kind: 'assistant_text',
          sequence: 6,
          createdAt: '2026-05-11T00:00:06.000Z',
          text: final
        }
      ],
      agentProcessText: `${first}${second}${final}`,
      agentProcessActivities: [
        {
          id: 'tool:tool_read_config',
          type: 'tool',
          offset: first.length,
          status: 'completed',
          title: 'tool_completed',
          toolUseIds: ['tool_read_config'],
          createdAt: '2026-05-11T00:00:00.000Z'
        },
        {
          id: 'tool:tool_write_config',
          type: 'tool',
          offset: `${first}${second}`.length,
          status: 'completed',
          title: 'tool_completed',
          toolUseIds: ['tool_write_config'],
          createdAt: '2026-05-11T00:00:01.000Z'
        }
      ]
    }
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: ['config.json'],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  const firstIndex = html.indexOf('先读取配置');
  const summaryIndex = html.indexOf('已探索 1 个文件，编辑 1 个文件');
  const secondIndex = html.indexOf('再写入修复');
  const finalIndex = html.indexOf('修复完成');

  assert.ok(firstIndex >= 0);
  assert.ok(summaryIndex > firstIndex);
  assert.ok(secondIndex > summaryIndex);
  assert.ok(finalIndex > secondIndex);
  assert.equal((html.match(/chat-tool-step-summary/g) ?? []).length, 1);
  assert.match(html, /config fixture/);
  assert.match(html, /已写入 config\.json/);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('Previous tool call'), false);
});

test('completed assistant transcript renders ordered Agent Core parts', () => {
  const message: ChatMessage = {
    id: 'msg_agent_core_parts',
    role: 'assistant',
    content: '最终完成。',
    createdAt: new Date().toISOString(),
    metadata: {
      agentCoreParts: [
        {
          id: 'part_skill',
          kind: 'system_event',
          createdAt: '2026-05-15T00:00:00.000Z',
          sequence: 0,
          title: 'Skill activated: backend-plan',
          summary: 'Reason: automatic_metadata_match · Trust: workspace · Permission: workspace_policy',
          metadata: {
            type: 'skill_activation',
            skillName: 'backend-plan'
          }
        },
        {
          id: 'part_text_1',
          kind: 'assistant_text',
          createdAt: '2026-05-15T00:00:00.000Z',
          sequence: 1,
          text: '先读取配置。'
        },
        {
          id: 'part_tool_call',
          kind: 'tool_call',
          createdAt: '2026-05-15T00:00:01.000Z',
          sequence: 2,
          toolUseId: 'tool_core_read',
          name: 'read_file',
          input: {
            path: 'config.json'
          },
          status: 'completed'
        },
        {
          id: 'part_tool_result',
          kind: 'tool_result',
          createdAt: '2026-05-15T00:00:02.000Z',
          sequence: 3,
          toolUseId: 'tool_core_read',
          toolName: 'read_file',
          content: 'config fixture'
        },
        {
          id: 'part_todo',
          kind: 'todo_update',
          createdAt: '2026-05-15T00:00:03.000Z',
          sequence: 4,
          items: [
            {
              id: 'inspect',
              title: '读取配置',
              status: 'completed'
            },
            {
              id: 'finish',
              title: '输出结果',
              status: 'in_progress'
            }
          ]
        },
        {
          id: 'part_text_2',
          kind: 'assistant_text',
          createdAt: '2026-05-15T00:00:04.000Z',
          sequence: 5,
          text: '最终完成。'
        }
      ]
    }
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: ['config.json'],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  const skillIndex = html.indexOf('已激活 Skill');
  const firstIndex = html.indexOf('先读取配置');
  const toolIndex = html.indexOf('config fixture');
  const todoIndex = html.indexOf('任务清单');
  const finalIndex = html.indexOf('最终完成');
  assert.ok(skillIndex >= 0);
  assert.ok(firstIndex > skillIndex);
  assert.ok(toolIndex >= 0);
  assert.ok(todoIndex > toolIndex);
  assert.ok(finalIndex > todoIndex);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('Previous tool call'), false);
});

test('long task stream renders partial reply, tool states, approvals, user input, and recovery hints', () => {
  const html = renderZh(
    createElement(MessageList, {
      sessionId: 'session_long_task',
      messages: [],
      stream: {
        prompt: '实现一个包含认证、任务队列和测试的后端系统',
        content: '已完成基础目录与数据库层，正在接入队列 worker，并准备运行验证。',
        thinkingContent: '',
        toolUses: [
          {
            toolUseId: 'tool_write_server',
            name: 'write_file',
            input: {
              path: 'src/server.ts'
            },
            status: 'completed'
          },
          {
            toolUseId: 'tool_test',
            name: 'run_command',
            input: {
              command: 'npm test',
              cwd: '/workspace/backend'
            },
            status: 'running'
          },
          {
            toolUseId: 'tool_patch_queue',
            name: 'patch_file',
            input: {
              path: 'src/queue.ts'
            },
            status: 'failed'
          }
        ],
        toolResults: [
          {
            toolUseId: 'tool_write_server',
            content: 'Wrote src/server.ts',
            changedFiles: [
              {
                path: 'src/server.ts',
                operation: 'created'
              }
            ],
            edit: {
              strategy: 'write_file',
              patchFirst: false,
              preflight: 'passed'
            }
          },
          {
            toolUseId: 'tool_patch_queue',
            content: 'Patch failed because the expected queue factory was not found.',
            isError: true,
            changedFiles: [
              {
                path: 'src/queue.ts',
                operation: 'patched',
                hunkCount: 1
              }
            ],
            edit: {
              strategy: 'unified_patch',
              patchFirst: true,
              preflight: 'failed',
              hunkCount: 1,
              failureKind: 'context_mismatch',
              recoveryHint: '重新读取文件后再应用更小补丁'
            }
          }
        ],
        stages: [
          {
            stageId: 'stage_write',
            title: '写入后端模块',
            target: 'src/server.ts',
            status: 'completed',
            summary: '已创建 HTTP server 与 health route',
            runtimeId: 'native',
            providerId: 'provider_mimo',
            model: 'mimo-v2.5-pro'
          },
          {
            stageId: 'stage_verify',
            title: '验证测试',
            target: 'npm test',
            status: 'failed',
            summary: '测试命令发现队列导出缺失',
            errorMessage: 'QueueFactory is not exported',
            errorCode: 'TEST_FAILED',
            suggestedAction: '读取 src/queue.ts 后修复导出',
            recoveryActions: [
              {
                label: '重新运行测试',
                command: 'npm test'
              }
            ]
          }
        ],
        activityItems: [
          {
            id: 'activity_write',
            type: 'tool',
            offset: 0,
            status: 'completed',
            title: 'tool_completed',
            summary: 'write_file completed',
            toolUseIds: ['tool_write_server'],
            createdAt: new Date().toISOString()
          },
          {
            id: 'activity_patch_failed',
            type: 'tool',
            offset: 0,
            status: 'failed',
            title: 'tool_failed',
            summary: 'patch_file failed',
            toolUseIds: ['tool_patch_queue'],
            createdAt: new Date().toISOString()
          }
        ],
        pendingPermission: {
          requestId: 'perm_test',
          title: '允许 Agent 执行命令：npm test？',
          detail: '该命令会在项目目录中运行测试。',
          risk: 'medium',
          impact: {
            toolName: 'run_command',
            toolTitle: 'Run Command',
            commands: ['npm test'],
            cwd: '/workspace/backend',
            permissionPolicy: 'ask',
            reason: '验证后端系统'
          }
        },
        pendingUserInput: {
          requestId: 'ask_env',
          title: '需要确认部署环境',
          question: '这个后端默认使用 SQLite 还是 Postgres？',
          options: [
            {
              id: 'sqlite',
              label: 'SQLite',
              description: '本地优先'
            },
            {
              id: 'postgres',
              label: 'Postgres',
              description: '生产优先'
            }
          ],
          allowFreeText: true
        },
        statusMessage: '正在思考中...'
      },
      searchQuery: '',
      openablePaths: ['src/server.ts', 'src/queue.ts'],
      onOpenPath: noop,
      developerMode: true
    })
  );

  assert.match(html, /实现一个包含认证、任务队列和测试的后端系统/);
  assert.match(html, /已完成基础目录与数据库层/);
  assert.match(html, /等待权限确认/);
  assert.match(html, /Run Command/);
  assert.match(html, /npm test/);
  assert.match(html, /等待用户回答/);
  assert.match(html, /SQLite 还是 Postgres/);
  assert.match(html, /src\/server\.ts/);
  assert.match(html, /src\/queue\.ts/);
  assert.doesNotMatch(html, /有操作失败/);
  assert.match(html, /context_mismatch/);
  assert.match(html, /阶段失败：验证测试/);
  assert.match(html, /QueueFactory is not exported/);
  assert.match(html, /重新运行测试/);
  assert.equal(html.includes('[Tool]'), false);
  assert.equal(html.includes('正在执行兼容工具调用'), false);
  assert.equal(html.includes('Previous tool call'), false);
});

test('permission prompts render structured impact without exposing large inputs', () => {
  const composerHtml = renderZh(
    createElement(ChatComposer, {
      draft: '',
      attachments: [] as PromptAttachment[],
      contextUsage,
      error: '',
      queuedPrompts: [],
      isSending: true,
      isExecutingPlan: false,
      statusMessage: '等待权限确认…',
      pendingPermission: {
        requestId: 'perm_write',
        title: '允许 Agent 执行工具：Write File？',
        detail: '允许后，本轮才会执行该写入型或高风险工具。',
        risk: 'medium',
        impact: {
          toolName: 'write_file',
          toolTitle: 'Write File',
          permissionPolicy: 'ask',
          checkpointPolicy: 'before_write',
          mcp: {
            pluginId: 'plugin_unity',
            pluginName: 'Unity Bridge',
            toolName: 'unity.modify_scene',
            policySource: 'tool',
            permission: 'ask',
            risk: 'write'
          },
          paths: ['src/app.ts'],
          reason: '保存实现',
          inputSummary: ['path: src/app.ts']
        }
      },
      permissionLabel: 'Build',
      activeProviderLabel: 'Xiaomi MiMo',
      providers: [provider],
      defaultProviderId: provider.id,
      activeProviderId: provider.id,
      permissionMode: 'full-access',
      onDraftChange: noop,
      onPickAttachments: noop,
      onRemoveAttachment: noop,
      onSubmit: noop,
      onCancelStream: noop,
      onRespondPermission: noop,
      onRespondUserInput: noop,
      onUpdateSessionRuntime: noop,
      onUpdatePermissionMode: noop,
      onRemoveQueuedPrompt: noop,
      onOpenAppSettings: noop,
      onOpenProjectAgentSettings: noop
    })
  );

  const transcriptHtml = renderZh(
    createElement(StreamingTranscriptMessage, {
      prompt: '写入 src/app.ts',
      content: '',
      thinkingContent: '',
      toolUses: [],
      toolResults: [],
      stages: [],
      activityItems: [],
      pendingPermission: {
        requestId: 'perm_write',
        title: '允许 Agent 执行工具：Write File？',
        detail: '允许后，本轮才会执行该写入型或高风险工具。',
        risk: 'medium',
        impact: {
          toolName: 'write_file',
          toolTitle: 'Write File',
          permissionPolicy: 'ask',
          checkpointPolicy: 'before_write',
          mcp: {
            pluginId: 'plugin_unity',
            pluginName: 'Unity Bridge',
            toolName: 'unity.modify_scene',
            policySource: 'tool',
            permission: 'ask',
            risk: 'write'
          },
          paths: ['src/app.ts'],
          reason: '保存实现'
        }
      },
      statusMessage: '等待权限确认…',
      developerMode: false,
      openablePaths: [],
      onOpenPath: noop
    })
  );

  assert.match(composerHtml, /路径：src\/app\.ts/);
  assert.match(composerHtml, /MCP：Unity Bridge \/ unity\.modify_scene/);
  assert.match(composerHtml, /MCP 策略：ask \/ write \/ tool/);
  assert.match(composerHtml, /恢复策略：before_write/);
  assert.match(transcriptHtml, /工具：Write File/);
  assert.match(transcriptHtml, /MCP：Unity Bridge \/ unity\.modify_scene/);
  assert.match(transcriptHtml, /原因：保存实现/);
  assert.equal(composerHtml.includes('const huge'), false);
  assert.equal(transcriptHtml.includes('const huge'), false);
});

test('project usage settings focus on token and provider summaries', () => {
  const html = renderZh(
    createElement(ProjectTokenUsageSettings, {
      project: null,
      usage: {
        trackedRunCount: 3,
        usageRunCount: 2,
        turns: 4,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 10,
        totalTokens: 160,
        statusCounts: {
          running: 0,
          completed: 2,
          failed: 1,
          interrupted: 0
        },
        verificationRunCount: 2,
        verificationCheckCount: 5,
        verificationPassedCount: 4,
        verificationFailedCount: 1,
        browserVerificationCount: 1,
        runtimeEventCount: 12,
        failedToolResultCount: 1,
        toolRetryCount: 1,
        providerModelGroups: []
      }
    })
  );

  assert.match(html, /项目 Token 概览/);
  assert.match(html, /Token 构成/);
  assert.match(html, /Provider \/ Model/);
  assert.match(html, /fp-info-card/);
  assert.equal(html.includes('prototype-card'), false);
  assert.equal(html.includes('恢复入口'), false);
  assert.equal(html.includes('Agent 验证'), false);
});

test('project Agent runs settings render recovery and verification summaries', () => {
  const html = renderZh(
    createElement(ProjectAgentRunsSettings, {
      project: null,
      runs: {
        trackedRunCount: 3,
        runningRunCount: 0,
        completedRunCount: 2,
        failedRunCount: 1,
        interruptedRunCount: 0,
        resumableRunCount: 1,
        latestUpdatedAt: new Date().toISOString(),
        verificationRunCount: 2,
        verificationCheckCount: 5,
        verificationPassedCount: 4,
        verificationFailedCount: 1,
        browserVerificationCount: 1,
        runtimeEventCount: 12,
        failedToolResultCount: 1,
        toolRetryCount: 1,
        recentRuns: [
          {
            id: 'run_failed',
            kind: 'conversation',
            status: 'failed',
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            canResume: true,
            sessionTitle: '主会话',
            inputPreview: '实现后端系统',
            resumeStrategy: 'resume_after_last_completed_tool',
            totalTokens: 160,
            verificationCheckCount: 5,
            failedToolResultCount: 1
          }
        ]
      },
      onResumeRun: noop
    })
  );

  assert.match(html, /Agent 运行概览/);
  assert.match(html, /验证与质量/);
  assert.match(html, /恢复状态/);
  assert.match(html, /实现后端系统/);
  assert.match(html, /从最近工具边界继续/);
  assert.match(html, /工具失败 1/);
  assert.match(html, /fp-info-card/);
  assert.match(html, /fp-button-secondary/);
  assert.equal(html.includes('prototype-card'), false);
  assert.equal(html.includes('prototype-secondary'), false);
});

test('project Agent settings render direct session and policy controls', () => {
  const activeSession: ProjectSession = {
    id: 'session_main',
    title: '主会话',
    autoTitle: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runtimeOverrides: {
      providerId: provider.id,
      model: 'mimo-v2.5-pro',
      runtimeId: 'native',
      effort: 'high'
    },
    chat: []
  };
  const project = {
    id: 'project_scope',
    name: 'Rogue',
    agentPolicy: {
      permissionMode: 'read-only'
    },
    sessions: [activeSession],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;

  const html = renderZh(
    createElement(ProjectAgentSettings, {
      project,
      providers: [provider, secondaryProvider],
      activeProvider: provider,
      defaultProviderId: provider.id,
      activeSession,
      sessionProviderId: provider.id,
      sessionModel: 'mimo-v2.5-pro',
      sessionRuntimeId: 'native',
      sessionEffort: 'high',
      globalRuntimeStrategy: 'native',
      onUpdatePermissionMode: noopAsync,
      onUpdateSessionRuntime: noopAsync
    })
  );

  assert.doesNotMatch(html, /设置作用域/);
  assert.match(html, /当前会话运行/);
  assert.doesNotMatch(html, /项目 Agent 策略/);
  assert.doesNotMatch(html, /全局默认/);
  assert.doesNotMatch(html, /跟随全局默认/);
  assert.match(html, /主会话/);
  assert.match(html, /Xiaomi MiMo/);
  assert.match(html, /mimo-v2\.5-pro/);
  assert.match(html, /Native/);
  assert.match(html, /Build/);
  assert.match(html, /Plan/);
  assert.match(html, /fp-field/);
  assert.match(html, /fp-input/);
  assert.match(html, /fp-button-primary/);
  assert.match(html, /fp-button-secondary/);
  assert.match(html, /fp-button[^"]*agent-settings-chip-button active/);
  assert.match(html, /fp-button[^"]*settings-choice-button active/);
  assert.match(html, /fp-button[^"]*settings-choice-button/);
  assert.equal(html.includes('prototype-primary'), false);
  assert.equal(html.includes('prototype-secondary'), false);
  assert.equal(html.includes('settings-field'), false);
  assert.doesNotMatch(html, /<button[^>]*class="active"[^>]*>mimo-v2\.5-pro/);
  assert.doesNotMatch(html, /<button[^>]*class="active"[^>]*>Native/);
});

test('provider settings render provider rows with separate details navigation', () => {
  const html = renderZh(
    createElement(ProviderSettingsPage, {
      providers: [provider, secondaryProvider],
      providerTests: {},
      selectedProjectId: 'project_scope',
      onAddProvider: noop,
      onEditProvider: noop,
      onDeleteProvider: noop,
      onTestProvider: noop,
      onSetDefaultProvider: noop,
      onToggleProvider: noop,
      embedded: true
    })
  );

  assert.match(html, /AI Provider/);
  assert.match(html, /Xiaomi MiMo/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /已配置 2 个 Provider/);
  assert.match(html, /默认：Xiaomi MiMo/);
  assert.match(html, /OpenAI 兼容/);
  assert.match(html, /详情/);
  assert.match(html, /停用 Provider/);
  assert.match(html, /provider-channel-list/);
  assert.match(html, /provider-channel-row/);
  assert.match(html, /settings-row-detail-button/);
  assert.match(html, /fp-toggle-switch/);
  assert.match(html, /fp-button-primary/);
  assert.match(html, /fp-button-secondary/);
  assert.doesNotMatch(html, /Base URL/);
  assert.doesNotMatch(html, /API Key/);
  assert.doesNotMatch(html, /provider-settings-layout/);
  assert.doesNotMatch(html, /provider-channel-row selected/);
  assert.doesNotMatch(html, /provider-action-button/);
  assert.doesNotMatch(html, /fp-button-danger/);
});

test('asset provider settings share the config list and details navigation contract', () => {
  const html = renderZh(
    createElement(AssetProviderSettingsPage, {
      providers: [
        {
          id: 'asset_provider_openai',
          name: 'OpenAI Images',
          adapter: 'openai-image' as const,
          enabled: true,
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          hasStoredApiKey: true,
          model: 'gpt-image-2',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: 'asset_provider_comfy',
          name: 'ComfyUI',
          adapter: 'comfyui' as const,
          enabled: false,
          baseUrl: 'http://127.0.0.1:8188',
          apiKey: '',
          model: '',
          workflowPath: 'workflow.json',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      onAddProvider: noop,
      onEditProvider: noop,
      onDeleteProvider: noop,
      onToggleProvider: noop,
      embedded: true
    })
  );

  assert.match(html, /素材 Provider/);
  assert.match(html, /添加素材 Provider/);
  assert.match(html, /OpenAI Images/);
  assert.match(html, /gpt-image-2/);
  assert.match(html, /ComfyUI/);
  assert.match(html, /搜索配置/);
  assert.match(html, /排序/);
  assert.match(html, /config-list-panel/);
  assert.match(html, /config-list-toolbar/);
  assert.match(html, /settings-row-detail-button/);
  assert.match(html, /fp-toggle-switch/);
  assert.doesNotMatch(html, /编辑素材 Provider/);
  assert.doesNotMatch(html, /Base URL/);
});

test('web search settings render through the shared UI component system', () => {
  const settings: WebSearchSettings = {
    provider: 'auto',
    braveApiKey: '',
    bingApiKey: '',
    cacheTtlMs: 300000,
    browserFallbackEnabled: true,
    telemetryEnabled: true
  };
  const html = renderZh(
    createElement(WebSearchSettingsPage, {
      settings,
      onUpdateSettings: noopAsync
    })
  );

  assert.match(html, /Web Search/);
  assert.match(html, /默认 Provider/);
  assert.match(html, /Brave API Key/);
  assert.match(html, /Bing API Key/);
  assert.match(html, /缓存 TTL/);
  assert.match(html, /fp-select-trigger/);
  assert.match(html, /fp-switch-field/);
  assert.match(html, /fp-metric-tile/);
  assert.match(html, /fp-button-primary/);
  assert.equal(html.includes('prototype-primary'), false);
});

test('provider editor prioritizes presets and hides protocol fields under advanced settings', () => {
  const html = renderZh(
    createElement(ProviderEditor, {
      provider: null,
      onCancel: noop,
      onCreate: noopAsync,
      onUpdate: async () => {}
    })
  );

  assert.match(html, /服务商预设/);
  assert.match(html, /核心配置/);
  assert.match(html, /高级协议配置/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Xiaomi MiMo/);
  assert.match(html, /默认模型/);
  assert.match(html, /Base URL/);
  assert.match(html, /API Key/);
  assert.match(html, /接口模式/);
  assert.match(html, /provider-advanced-section/);
  assert.match(html, /fp-field/);
  assert.match(html, /fp-input/);
  assert.match(html, /fp-select-trigger/);
  assert.match(html, /fp-textarea/);
  assert.match(html, /fp-checkbox-field/);
  assert.match(html, /fp-button-primary/);
  assert.match(html, /fp-button-secondary/);
  assert.match(html, /fp-button[^"]*provider-preset-card active/);
  assert.match(html, /fp-button[^"]*agent-settings-chip-button active/);
  assert.equal(/<details class="provider-advanced-section" open/.test(html), false);
  assert.equal(html.includes('app-settings-check-row'), false);
  assert.doesNotMatch(html, /<button[^>]*class="provider-preset-card/);
  assert.doesNotMatch(html, /<button[^>]*class="active"[^>]*>gpt/);
});

test('MCP plugin modal exposes persisted tool permission policy controls', () => {
  const plugin: McpPlugin = {
    id: 'mcp_unity',
    name: 'Unity Bridge',
    kind: 'engine',
    transport: 'stdio',
    baseUrl: '',
    command: 'node',
    args: ['server.mjs'],
    cwd: '/tmp/funplay-mcp',
    env: {
      NODE_ENV: 'test'
    },
    defaultToolPermission: 'ask',
    defaultToolRisk: 'write',
    toolPolicies: {
      'unity.read_scene': {
        permission: 'allow',
        risk: 'read'
      },
      'unity.modify_scene': {
        permission: 'deny',
        risk: 'write',
        notes: 'Requires manual review'
      }
    },
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const html = renderZh(
    createElement(McpPluginModal, {
      plugin,
      onClose: noop,
      onCreate: noopAsync,
      onUpdate: async () => {}
    })
  );

  assert.match(html, /工具权限策略/);
  assert.match(html, /默认权限/);
  assert.match(html, /默认风险/);
  assert.match(html, /工具覆盖 JSON/);
  assert.match(html, /unity\.read_scene/);
  assert.match(html, /unity\.modify_scene/);
  assert.match(html, /Requires manual review/);
  assert.match(html, /deny/);
  assert.match(html, /fp-select-trigger/);
  assert.match(html, /fp-textarea/);
  assert.match(html, /fp-checkbox-field/);
  assert.match(html, /fp-button-primary/);
  assert.match(html, /fp-button-secondary/);
  assert.equal(html.includes('prototype-primary'), false);
  assert.equal(html.includes('prototype-secondary'), false);
  assert.equal(html.includes('app-settings-check-row'), false);
});

test('MCP tool snapshot card warns about changed and removed mappings', () => {
  const html = renderZh(
    createElement(McpToolSnapshotCard, {
      snapshots: [
        {
          pluginId: 'plugin_unity',
          pluginName: 'Unity Bridge',
          originalName: 'unity.echo',
          exposedName: 'mcp__unity_bridge__unity_echo',
          schemaHash: 'a'.repeat(64),
          schemaJson: '{}',
          policySummary: 'MCP policy inferred: permission=ask, risk=write',
          changeKind: 'changed',
          discoveredAt: new Date().toISOString()
        },
        {
          pluginId: 'plugin_unity',
          pluginName: 'Unity Bridge',
          originalName: 'unity.old_tool',
          exposedName: '',
          schemaHash: 'b'.repeat(64),
          schemaJson: '{}',
          changeKind: 'removed',
          discoveredAt: new Date().toISOString()
        }
      ]
    })
  );

  assert.match(html, /工具映射审计/);
  assert.match(html, /有 2 个工具发生变化或被移除/);
  assert.match(html, /unity\.echo/);
  assert.match(html, /mcp__unity_bridge__unity_echo/);
  assert.match(html, /unity\.old_tool/);
  assert.match(html, /未暴露/);
});

test('MCP raw diagnostics card exposes only diagnostic methods', () => {
  const plugin: McpPlugin = {
    id: 'mcp_raw',
    name: 'Raw MCP',
    kind: 'custom',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8765/',
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(McpRawDiagnosticsCard, {
      plugin,
      onSendRawRequest: async () => ({
        method: 'tools/list',
        pluginId: plugin.id,
        durationMs: 1,
        paramsSize: 2,
        responseSize: 2,
        truncated: false,
        result: {}
      })
    })
  );

  assert.match(html, /Raw 诊断/);
  assert.match(html, /tools\/list/);
  assert.match(html, /resources\/read/);
  assert.match(html, /发送诊断请求/);
  assert.match(html, /fp-select-trigger/);
  assert.match(html, /fp-textarea/);
  assert.match(html, /fp-button-secondary/);
  assert.equal(html.includes('tools/call'), false);
  assert.equal(html.includes('class="field'), false);
});

test('MCP raw audit card renders recent diagnostic outcomes', () => {
  const html = renderZh(
    createElement(McpRawAuditCard, {
      audits: [
        {
          id: 'audit_ok',
          pluginId: 'mcp_raw',
          pluginName: 'Raw MCP',
          method: 'tools/list',
          status: 'success',
          durationMs: 12,
          paramsSize: 2,
          responseSize: 44,
          createdAt: '2026-05-15T01:00:00.000Z'
        },
        {
          id: 'audit_failed',
          pluginId: 'mcp_raw',
          pluginName: 'Raw MCP',
          method: 'resources/read',
          status: 'failed',
          durationMs: 4,
          paramsSize: 32,
          error: 'Resource not found',
          createdAt: '2026-05-15T01:01:00.000Z'
        }
      ]
    })
  );

  assert.match(html, /Raw 操作审计/);
  assert.match(html, /已记录 2 次诊断请求，失败 1 次/);
  assert.match(html, /tools\/list/);
  assert.match(html, /resources\/read/);
  assert.match(html, /错误：Resource not found/);
});

test('engine status dialog uses Cocos labels for Cocos diagnostics', () => {
  const project = buildProject('/Users/xyz/Downloads/arrow');
  project.engine = {
    platform: 'cocos',
    setupMode: 'create',
    projectPath: '/Users/xyz/Downloads/arrow',
    dimension: '2d'
  };
  const diagnostics: EnvironmentDiagnostics = {
    platform: 'cocos',
    mode: 'create',
    dimension: '2d',
    checkedAt: new Date().toISOString(),
    projectPath: '/Users/xyz/Downloads/arrow',
    checks: [
      {
        id: 'cocos-dashboard',
        title: 'Cocos Dashboard / Creator',
        description: 'Detected',
        status: 'passed',
        detail: '已检测到 Cocos Creator。',
        actions: []
      },
      {
        id: 'engine-project',
        title: 'Cocos 项目创建',
        description: 'Detected',
        status: 'passed',
        detail: '已检测到有效 Cocos 项目：/Users/xyz/Downloads/arrow · 2D',
        actions: []
      },
      {
        id: 'engine-opened',
        title: 'Cocos 项目打开状态',
        description: 'Detected',
        status: 'passed',
        detail: '已检测到该项目当前就在 Cocos Creator 中打开。',
        actions: []
      },
      {
        id: 'bridge-installed',
        title: 'Funplay Cocos MCP',
        description: 'Detected',
        status: 'passed',
        detail: '已检测到项目中存在 funplay-cocos-mcp 扩展。',
        actions: []
      },
      {
        id: 'bridge-connected',
        title: 'Cocos MCP 连通性',
        description: 'Detected',
        status: 'passed',
        detail: '连接成功：Funplay Cocos MCP - arrow',
        actions: []
      }
    ],
    ready: true
  };
  const html = renderZh(
    createElement(EngineStatusDialog, {
      project,
      diagnostics,
      loading: false,
      actionId: null,
      error: '',
      actionMessage: '',
      onClose: noop,
      onRefresh: noop,
      onRunAction: noop
    })
  );

  assert.match(html, /Cocos Dashboard/);
  assert.match(html, /Cocos 项目/);
  assert.match(html, /Cocos MCP/);
  assert.doesNotMatch(html, /Unity Hub/);
  assert.doesNotMatch(html, /Unity 项目/);
  assert.doesNotMatch(html, /Unity MCP/);
});

test('MCP server list row renders compact details navigation and toggle', () => {
  const plugin: McpPlugin = {
    id: 'mcp_unity',
    name: 'Unity MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8765/',
    defaultToolPermission: 'ask',
    defaultToolRisk: 'write',
    toolPolicies: {
      'unity.read_scene': { permission: 'allow', risk: 'read' }
    },
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const html = renderZh(
    createElement(ServerListRow, {
      plugin,
      selected: true,
      checked: true,
      onSelect: noop,
      onToggle: noop
    })
  );

  assert.match(html, /Unity MCP/);
  assert.match(html, /mcp-server-row-main/);
  assert.match(html, /详情/);
  assert.match(html, /settings-row-detail-button/);
  assert.doesNotMatch(html, /stale schema/);
  assert.doesNotMatch(html, /能力：Tools 3 · Resources 2 · Prompts 1 · Templates 1/);
  assert.doesNotMatch(html, /策略：默认 ask \/ 风险 write · 覆盖 1/);
  assert.doesNotMatch(html, /mcp-status-dot online/);
  assert.match(html, /fp-toggle-switch/);
  assert.match(html, /fp-switch/);
});

test('MCP management pages render shared action controls', () => {
  const plugin: McpPlugin = {
    id: 'mcp_project',
    projectId: 'project_mcp',
    name: 'Project MCP',
    kind: 'custom',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8765/',
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const legacyUnityPlugin: McpPlugin = {
    id: 'mcp_legacy_unity',
    name: 'Unity MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8765/',
    enabled: true,
    isDefault: false,
    notes: 'Funplay built-in Unity MCP bridge.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const project = {
    id: 'project_mcp',
    name: 'MCP Project',
    mcpBindings: {},
    sessions: [],
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const connectionStatus = {
    pluginId: plugin.id,
    transport: 'http',
    status: 'online' as const,
    initializeCount: 1
  };
  const projectHtml = renderZh(
    createElement(McpManagementPage, {
      project,
      plugins: [plugin, legacyUnityPlugin],
      projectBindings: [plugin.id, legacyUnityPlugin.id],
      selectedPlugin: plugin,
      serverInfo: null,
      tools: [],
      toolSnapshots: [],
      rawAudits: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      connectionStatus,
      connectionStatuses: { [plugin.id]: connectionStatus },
      pluginError: '',
      isRefreshing: false,
      onRefresh: noop,
      onReconnect: noop,
      onStop: noop,
      onOpenRegistry: noop,
      onSelectProjectMcpPlugin: noop,
      onToggleProjectMcpPlugin: noop,
      onAddProjectMcpPlugin: noop,
      onEditProjectMcpPlugin: noop,
      onDeleteProjectMcpPlugin: noop,
      onSendRawMcpRequest: async () => ({
        method: 'tools/list',
        pluginId: plugin.id,
        durationMs: 1,
        paramsSize: 2,
        responseSize: 2,
        truncated: false,
        result: {}
      })
    })
  );
  const registryHtml = renderZh(
    createElement(McpRegistrySettingsPage, {
      plugins: [plugin],
      selectedPlugin: plugin,
      serverInfo: null,
      tools: [],
      toolSnapshots: [],
      rawAudits: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      connectionStatus,
      connectionStatuses: { [plugin.id]: connectionStatus },
      pluginError: '',
      isRefreshing: false,
      onSelectPlugin: noop,
      onRefresh: noop,
      onReconnect: noop,
      onStop: noop,
      onTogglePlugin: noop,
      onAddPlugin: noop,
      onEditPlugin: noop,
      onDeletePlugin: noop,
      onSendRawMcpRequest: async () => ({
        method: 'tools/list',
        pluginId: plugin.id,
        durationMs: 1,
        paramsSize: 2,
        responseSize: 2,
        truncated: false,
        result: {}
      })
    })
  );
  const pluginCardHtml = renderZh(
    createElement(PluginListCard, {
      plugin,
      selected: true,
      onClick: noop
    })
  );

  assert.match(projectHtml, /Global Settings|全局设置/);
  assert.match(projectHtml, /Add project server|添加项目 Server/);
  assert.match(projectHtml, /fp-button-primary/);
  assert.match(projectHtml, /fp-button-secondary/);
  assert.match(projectHtml, /fp-button[^"]*mcp-server-row-main/);
  assert.match(projectHtml, /Unity MCP - MCP Project/);
  assert.match(projectHtml, /settings-row-detail-button/);
  assert.match(projectHtml, /详情/);
  assert.match(projectHtml, /fp-toggle-switch/);
  assert.doesNotMatch(projectHtml, /服务端信息/);
  assert.doesNotMatch(projectHtml, /Raw 诊断/);
  assert.match(registryHtml, /MCP Registry/);
  assert.match(registryHtml, /添加 Server|Add server/);
  assert.match(registryHtml, /fp-button-primary/);
  assert.match(registryHtml, /settings-row-detail-button/);
  assert.match(registryHtml, /fp-button[^"]*mcp-server-row-main/);
  assert.match(registryHtml, /fp-toggle-switch/);
  assert.doesNotMatch(registryHtml, /服务端信息/);
  assert.doesNotMatch(registryHtml, /Raw 诊断/);
  assert.doesNotMatch(registryHtml, /fp-button-danger/);
  assert.match(pluginCardHtml, /fp-button[^"]*plugin-list-card selected/);
  assert.doesNotMatch(projectHtml, /<button[^>]*class="mcp-server-row-main/);
  assert.doesNotMatch(pluginCardHtml, /<button[^>]*class="plugin-list-card/);
});

test('runtime doctor renders direct provider repair guidance', () => {
  const result: RuntimeDoctorResult = {
    overallSeverity: 'error',
    generatedAt: new Date().toISOString(),
    durationMs: 42,
    providerId: provider.id,
    runtimeId: 'native',
    repairs: [],
    probes: [
      {
        id: 'native-openai-compatible',
        title: 'Native OpenAI Compatible',
        severity: 'error',
        durationMs: 42,
        findings: [
          {
            severity: 'error',
            code: 'provider_auth_missing',
            summary: 'Provider 缺少 API key/token。',
            suggestedAction: '保存 API key。'
          },
          {
            severity: 'error',
            code: 'native_provider_api_mode_unsupported',
            summary: 'Provider 当前 API mode 与服务商能力不匹配。',
            suggestedAction: '切换 Chat Completions。'
          },
          {
            severity: 'warn',
            code: 'network_provider_unreachable',
            summary: 'Provider endpoint 网络探针失败。',
            suggestedAction: '检查网络。'
          }
        ]
      }
    ]
  };
  const html = renderZh(
    createElement(RuntimeDoctorDialog, {
      provider,
      result,
      loading: false,
      error: '',
      exportedJson: '{"provider":"Xiaomi MiMo"}',
      onRunDry: noop,
      onRunLive: noop,
      onRepair: noop,
      onExport: noop,
      onClose: noop
    })
  );

  assert.match(html, /建议修复顺序/);
  assert.match(html, /runtime-doctor-status-board/);
  assert.match(html, /runtime-doctor-status-grid/);
  assert.match(html, /runtime-doctor-status-card error/);
  assert.match(html, /data-status-card="auth"/);
  assert.match(html, /补全认证配置/);
  assert.match(html, /切换 API Mode/);
  assert.match(html, /检查 Base URL 与网络/);
  assert.match(html, /保存 API key/);
  assert.match(html, /Chat Completions/);
  assert.match(html, /fp-button-secondary/);
  assert.match(html, /fp-badge-danger/);
  assert.match(html, /fp-textarea runtime-doctor-export/);
  assert.match(html, /Xiaomi MiMo/);
  assert.doesNotMatch(html, /<textarea[^>]*class="runtime-doctor-export/);
});

test('agent workbench renders chat without redundant project status header', () => {
  const project = {
    id: 'project_status',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const html = renderZh(
    createElement(AgentWorkbench, {
      project,
      children: createElement('div', null, 'chat')
    })
  );

  assert.match(html, /chat/);
  assert.doesNotMatch(html, /项目状态/);
  assert.doesNotMatch(html, /agent-workbench-status-bar/);
});

test('workspace sidebar navigation marks the active section semantically', () => {
  const html = renderZh(
    createElement(SidebarPanel, {
      files: [],
      selectedFileId: '',
      sessions: [],
      activeSessionId: undefined,
      streamingSessionId: undefined,
      sessionStates: {},
      navItems: [
        { id: 'settings', label: '项目设置', icon: '⚙' },
        { id: 'assets', label: '素材库', icon: '▧' }
      ],
      activeNavId: 'assets',
      width: 300,
      onOpenFile: noop,
      onCreateSession: noop,
      onSelectSession: noop,
      onRenameSession: noop,
      onDeleteSession: noop,
      onSelectNav: noop
    })
  );

  assert.match(html, /aria-label="项目导航"/);
  assert.match(html, /aria-current="page"[^>]*class="[^"]*workspace-sidebar-nav-item active/);
  assert.match(html, /fp-button-label"><span class="workspace-sidebar-nav-icon">▧/);
  assert.equal(/aria-current="page"[^>]*><span class="workspace-sidebar-nav-icon">⚙/.test(html), false);
});

test('workspace sidebar does not show session selection outside the agent section', () => {
  const sessions: ProjectSession[] = [
    {
      id: 'session_main',
      title: '主会话',
      autoTitle: false,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date().toISOString(),
      chat: []
    }
  ];
  const html = renderZh(
    createElement(SidebarPanel, {
      files: [],
      selectedFileId: '',
      sessions,
      activeSessionId: 'session_main',
      streamingSessionId: undefined,
      sessionStates: {},
      navItems: [
        { id: 'agent', label: 'Agent', icon: '✦' },
        { id: 'settings', label: '项目设置', icon: '⚙' },
        { id: 'assets', label: '素材库', icon: '▧' }
      ],
      activeNavId: 'settings',
      width: 300,
      onOpenFile: noop,
      onCreateSession: noop,
      onSelectSession: noop,
      onRenameSession: noop,
      onDeleteSession: noop,
      onSelectNav: noop
    })
  );

  assert.match(html, /主会话/);
  assert.match(html, /workspace-sidebar-nav-item active/);
  assert.doesNotMatch(html, /sidebar-session-item active/);
  assert.doesNotMatch(html, /sidebar-session-dot active/);
});

test('session management panel renders shared toolbar and row action controls', () => {
  const sessions: ProjectSession[] = [
    {
      id: 'session_main',
      title: '主会话',
      autoTitle: false,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date().toISOString(),
      chat: []
    },
    {
      id: 'session_plan',
      title: 'Plan notes',
      autoTitle: false,
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      updatedAt: new Date(Date.now() - 600000).toISOString(),
      chat: []
    }
  ];
  const html = renderZh(
    createElement(SessionManagementPanel, {
      sessions,
      activeSessionId: 'session_main',
      streamingSessionId: 'session_main',
      sessionStates: {
        session_plan: {
          mode: 'queued',
          summary: '等待工具结果',
          hint: '2 queued',
          queuedCount: 2
        }
      },
      onCreateSession: noop,
      onSelectSession: noop,
      onRenameSession: noop,
      onDeleteSession: noop
    })
  );

  assert.match(html, /会话管理/);
  assert.match(html, /主会话/);
  assert.match(html, /Plan notes/);
  assert.match(html, /正在处理当前会话请求/);
  assert.match(html, /fp-icon-button sidebar-tool-icon/);
  assert.match(html, /fp-icon-button sidebar-session-action/);
  assert.match(html, /fp-button[^"]*sidebar-session-main/);
  assert.doesNotMatch(html, /<button[^>]*class="sidebar-tool-icon/);
  assert.doesNotMatch(html, /<button[^>]*class="sidebar-session-main/);
});

test('workspace file tree renders empty folders and inspector handoff state', () => {
  const project = {
    id: 'project_files',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const sidebarHtml = renderZh(
    createElement(SidebarPanel, {
      files: [
        {
          id: 'dir_assets',
          name: 'assets',
          path: 'assets',
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'dir_images',
          name: 'images',
          path: 'assets/images',
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'dir_audio',
          name: 'audio',
          path: 'assets/audio',
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'file_index',
          name: 'index.html',
          path: 'index.html',
          type: 'file',
          size: 512,
          modifiedAt: new Date().toISOString()
        }
      ],
      selectedFileId: 'index.html',
      sessions: [],
      activeSessionId: undefined,
      streamingSessionId: undefined,
      sessionStates: {},
      navItems: [],
      activeNavId: 'agent',
      width: 300,
      onOpenFile: noop,
      onCreateSession: noop,
      onSelectSession: noop,
      onRenameSession: noop,
      onDeleteSession: noop,
      onSelectNav: noop
    })
  );
  const inspectorHtml = renderZh(
    createElement(FileInspectorPanel, {
      file: {
        id: 'index.html',
        label: 'index.html',
        path: 'index.html',
        content: '<!doctype html><canvas id="game"></canvas>',
        isBinary: false,
        mimeType: 'text/html',
        size: 512
      },
      project,
      draft: '<!doctype html><canvas id="game"></canvas>',
      mode: 'preview',
      width: 420,
      isDirty: false,
      isSaving: false,
      saveError: '',
      savedAt: '',
      onDraftChange: noop,
      onModeChange: noop,
      onClose: noop,
      onSave: noop,
      onReset: noop
    })
  );
  const editorHtml = renderZh(
    createElement(FileInspectorPanel, {
      file: {
        id: 'index.html',
        label: 'index.html',
        path: 'index.html',
        content: '<!doctype html><canvas id="game"></canvas>',
        isBinary: false,
        mimeType: 'text/html',
        size: 512
      },
      project,
      draft: '<!doctype html><canvas id="game"></canvas>',
      mode: 'edit',
      width: 420,
      isDirty: false,
      isSaving: false,
      saveError: '',
      savedAt: '',
      onDraftChange: noop,
      onModeChange: noop,
      onClose: noop,
      onSave: noop,
      onReset: noop
    })
  );

  assert.match(sidebarHtml, /assets/);
  assert.match(sidebarHtml, /images/);
  assert.match(sidebarHtml, /audio/);
  assert.match(sidebarHtml, /index\.html/);
  assert.match(sidebarHtml, /file-item tree active/);
  assert.match(sidebarHtml, /fp-button[^"]*file-tree-folder-label/);
  assert.match(sidebarHtml, /fp-button[^"]*file-item tree active/);
  assert.match(inspectorHtml, /index\.html/);
  assert.match(inspectorHtml, /Rogue/);
  assert.match(inspectorHtml, /源码/);
  assert.match(inspectorHtml, /预览/);
  assert.match(inspectorHtml, /真实尺寸/);
  assert.match(inspectorHtml, /fp-icon-button file-inspector-close/);
  assert.match(inspectorHtml, /fp-button[^"]*file-mode-button active/);
  assert.equal(inspectorHtml.includes('funplayPreviewMode=fit'), false);
  assert.match(inspectorHtml, /可编辑文本/);
  assert.match(editorHtml, /file-editor-field/);
  assert.match(editorHtml, /fp-textarea file-editor-textarea/);
  assert.doesNotMatch(editorHtml, /<textarea[^>]*class="file-editor-textarea/);
});

test('session changes panel uses the file code preview surface for diffs', () => {
  const preview: SessionCheckpointPreview = {
    snapshotId: 'snapshot_1',
    sessionId: 'session_1',
    checkpointNote: 'before run',
    checkpointCreatedAt: new Date('2026-05-13T10:00:00.000Z').toISOString(),
    currentMessageCount: 4,
    checkpointMessageCount: 2,
    addedMessages: 2,
    removedMessages: 0,
    fileChanges: [
      {
        path: 'src/game.js',
        status: 'modified',
        diffPreview: [
          'diff --git a/src/game.js b/src/game.js',
          '@@ -1,2 +1,2 @@',
          '-const hp = 10;',
          '+const hp = 12;'
        ].join('\n')
      }
    ]
  };
  const html = renderZh(
    createElement(SessionChangesPanel, {
      preview,
      isLoading: false,
      onRestore: noop,
      onClose: noop
    })
  );

  assert.match(html, /session-change-diff-preview file-editor-shell/);
  assert.match(html, /file-editor-gutter/);
  assert.match(html, /session-change-diff-line add/);
  assert.match(html, /session-change-diff-line remove/);
  assert.match(html, /fp-icon-button session-changes-icon-button/);
  assert.match(html, /fp-button-secondary/);
  assert.equal(html.includes('chat-tool-json compact'), false);
  assert.equal(html.includes('prototype-secondary'), false);
});

test('delete project modal uses shared checkbox field', () => {
  const project = {
    id: 'project_delete',
    name: 'Rogue',
    status: 'active',
    engine: {
      platform: 'web',
      projectPath: '/tmp/rogue'
    },
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const html = renderZh(
    createElement(DeleteProjectModal, {
      project,
      deleteSourceFiles: true,
      isDeleting: false,
      onChangeDeleteSourceFiles: noop,
      onClose: noop,
      onConfirm: noop
    })
  );

  assert.match(html, /删除项目/);
  assert.match(html, /fp-checkbox-field delete-project-checkbox/);
  assert.match(html, /同时删除源文件目录/);
  assert.equal(html.includes('type="checkbox"'), true);
});

test('HTML inspector warns when a project entry requires a dev server', () => {
  const project = {
    id: 'project_vite_preview',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const html = renderZh(
    createElement(FileInspectorPanel, {
      file: {
        id: 'index.html',
        label: 'index.html',
        path: 'index.html',
        content: '<!doctype html><script type="module" src="/src/main.ts"></script>',
        isBinary: false,
        mimeType: 'text/html',
        size: 128
      },
      project,
      draft: '<!doctype html><script type="module" src="/src/main.ts"></script>',
      mode: 'preview',
      width: 420,
      isDirty: false,
      isSaving: false,
      saveError: '',
      savedAt: '',
      onDraftChange: noop,
      onModeChange: noop,
      onClose: noop,
      onSave: noop,
      onReset: noop
    })
  );

  assert.match(html, /TypeScript\/Vite 入口/);
  assert.match(html, /启动预览/);
  assert.match(html, /fp-button-secondary/);
  assert.match(html, /这里预览/);
  assert.equal(html.includes('funplayPreviewMode=fit'), false);
});

test('Markdown file preview renders standalone thematic breaks as horizontal rules', () => {
  const project = {
    id: 'project_markdown_preview',
    name: 'Bird',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const draft = ['# 核心玩法一句话', '', '玩家通过画线规划飞行路线。', '', '---', '', '## 2. 市场定位'].join('\n');
  const html = renderZh(
    createElement(FileInspectorPanel, {
      file: {
        id: 'Bird_Nest_Rescue_策划案.md',
        label: 'Bird_Nest_Rescue_策划案.md',
        path: 'Bird_Nest_Rescue_策划案.md',
        content: draft,
        isBinary: false,
        mimeType: 'text/markdown',
        size: draft.length
      },
      project,
      draft,
      mode: 'preview',
      width: 420,
      isDirty: false,
      isSaving: false,
      saveError: '',
      savedAt: '',
      onDraftChange: noop,
      onModeChange: noop,
      onClose: noop,
      onSave: noop,
      onReset: noop
    })
  );

  assert.match(html, /markdown-preview/);
  assert.match(html, /<hr\s*\/?>/);
  assert.doesNotMatch(html, />---<\/p>/);
});

test('Markdown file preview renders GFM tables and blockquotes', () => {
  const project = {
    id: 'project_markdown_gfm_preview',
    name: 'Sweeper',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const draft = [
    '# 工作区根目录',
    '',
    '> `node_modules/` 已经随搬移进入 `minesweeper/node_modules/`，根目录不再有依赖。',
    '',
    '## 常用入口',
    '',
    '| 想做什么 | 怎么操作 |',
    '| --- | --- |',
    '| 跑协作扫雷 | `cd minesweeper && npm start` |',
    '| 玩 Animal Pop | 打开 `animal-pop/index.html` |'
  ].join('\n');
  const html = renderZh(
    createElement(FileInspectorPanel, {
      file: {
        id: 'README.md',
        label: 'README.md',
        path: 'README.md',
        content: draft,
        isBinary: false,
        mimeType: 'text/markdown',
        size: draft.length
      },
      project,
      draft,
      mode: 'preview',
      width: 420,
      isDirty: false,
      isSaving: false,
      saveError: '',
      savedAt: '',
      onDraftChange: noop,
      onModeChange: noop,
      onClose: noop,
      onSave: noop,
      onReset: noop
    })
  );

  assert.match(html, /markdown-preview-table-wrap/);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /\| 想做什么 \| 怎么操作 \|/);
  assert.doesNotMatch(html, /&gt; <code>node_modules\/<\/code>/);
});

test('project settings shell marks selected settings category and renders only the active page', () => {
  const project = {
    id: 'project_settings_shell',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;

  const html = renderZh(
    createElement(ProjectSettingsPage, {
      tab: 'engine',
      onTabChange: noop,
      project,
      plugins: [],
      selectedPlugin: null,
      serverInfo: null,
      tools: [],
      toolSnapshots: [],
      rawAudits: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      connectionStatus: null,
      connectionStatuses: {},
      pluginError: '',
      isRefreshing: false,
      globalRuntimeStrategy: 'native',
      projectBindings: [],
      skillDraft: {
        name: '',
        description: '',
        trigger: '',
        instruction: '',
        enabled: true
      },
      editingSkillId: '',
      skillCatalog: null,
      isLoadingSkillCatalog: false,
      skillCatalogError: '',
      providers: [provider],
      activeProvider: provider,
      defaultProviderId: provider.id,
      activeSession: null,
      sessionProviderId: undefined,
      sessionModel: undefined,
      sessionRuntimeId: 'native',
      sessionEffort: 'medium',
      runtimeStatuses: [],
      onUpdateProjectPermissionMode: noopAsync,
      onUpdateSessionRuntime: noopAsync,
      onRefreshSkillCatalog: noopAsync,
      onInstallCatalogSkill: noopAsync,
      onChangeSkillDraft: noop,
      onSaveProjectSkill: noopAsync,
      onEditProjectSkill: noop,
      onCancelProjectSkillEdit: noop,
      onToggleProjectSkill: noopAsync,
      onDeleteProjectSkill: noopAsync,
      onRefreshPluginMeta: noop,
      onOpenMcpRegistry: noop,
      onSelectProjectMcpPlugin: noop,
      onToggleProjectMcpPlugin: noop,
      onAddProjectMcpPlugin: noop,
      onEditProjectMcpPlugin: noop,
      onDeleteProjectMcpPlugin: noop,
      onSendRawMcpRequest: async () => ({
        method: 'tools/list',
        durationMs: 1,
        paramsSize: 2,
        responseSize: 2,
        truncated: false,
        result: {}
      }),
      onReconnectMcpPlugin: noop,
      onStopMcpPlugin: noop,
      onResumeAgentRun: noop
    })
  );

  assert.match(html, /项目设置分类/);
  assert.match(html, /fp-button[^"]*project-settings-nav-item active/);
  assert.match(html, /aria-current="page"[^>]*title="引擎项目 · 路径、平台、运行状态/);
  assert.match(html, /project-settings-nav-icon/);
  assert.match(html, /<span class="project-settings-nav-copy"><strong>引擎项目/);
  assert.match(html, /运行状态/);
  assert.equal(html.includes('Agent 运行概览'), false);
  assert.doesNotMatch(html, /<button[^>]*class="project-settings-nav-item/);
});

test('app settings modal is a semantic dialog and opens directly to provider settings', () => {
  const appUpdateSnapshot = {
    status: 'idle' as const,
    currentVersion: '0.0.0',
    canCheck: false,
    canDownload: false,
    canInstall: false,
    isPackaged: false,
    feedSource: 'none' as const,
    autoDownload: false
  };

  const html = renderZh(
    createElement(AppSettingsModal, {
      initialTab: 'provider',
      theme: 'light',
      language: 'zh-CN',
      developerMode: false,
      runtimeStrategy: 'native',
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
      providers: [provider],
      providerTests: {},
      mcpPlugins: [],
      selectedMcpPlugin: null,
      serverInfo: null,
      tools: [],
      toolSnapshots: [],
      rawAudits: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      connectionStatus: null,
      connectionStatuses: {},
      pluginError: '',
      isRefreshingPlugin: false,
      memoryFiles: [],
      selectedMemoryPath: '',
      selectedMemoryFile: null,
      memoryDraft: '',
      isLoadingMemory: false,
      isSavingMemory: false,
      memoryError: '',
      notificationTasks: [],
      isLoadingNotificationTasks: false,
      notificationTaskError: '',
      appUpdateStatus: null,
      selectedProjectId: 'project_settings_shell',
      onChangeTheme: noop,
      onChangeLanguage: noop,
      onChangeDeveloperMode: noop,
      onChangeRuntimeStrategy: noop,
      onUpdateWebSearchSettings: noopAsync,
      onCreateProvider: noopAsync,
      onUpdateProvider: noopAsync,
      onDeleteProvider: noop,
      onTestProvider: noop,
      onSetDefaultProvider: noop,
      onSelectMcpPlugin: noop,
      onRefreshMcpPluginMeta: noop,
      onToggleMcpPlugin: noop,
      onAddMcpPlugin: noop,
      onEditMcpPlugin: noop,
      onDeleteMcpPlugin: noop,
      onSendRawMcpRequest: async () => ({
        method: 'tools/list',
        durationMs: 1,
        paramsSize: 2,
        responseSize: 2,
        truncated: false,
        result: {}
      }),
      onReconnectMcpPlugin: noop,
      onStopMcpPlugin: noop,
      onImportClaudeSession: noopAsync,
      onRefreshMemoryFiles: noopAsync,
      onSelectMemoryFile: noopAsync,
      onChangeMemoryDraft: noop,
      onSaveMemoryFile: noopAsync,
      onClearMemory: noopAsync,
      onRefreshNotificationTasks: noopAsync,
      onCancelNotificationTask: noopAsync,
      onRefreshAppUpdateStatus: async () => appUpdateSnapshot,
      onCheckForUpdates: async () => appUpdateSnapshot,
      onDownloadUpdate: async () => appUpdateSnapshot,
      onInstallUpdate: async () => appUpdateSnapshot,
      onClose: noop
    })
  );

  assert.match(html, /data-modal-state="open"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /aria-current="page"[^>]*class="[^"]*app-settings-nav-item active/);
  assert.match(html, /app-settings-nav-icon/);
  assert.match(html, /app-settings-nav-copy"><strong>AI Provider/);
  assert.match(html, /fp-modal app-settings-modal/);
  assert.match(html, /fp-icon-button modal-close-button/);
  assert.match(html, /Xiaomi MiMo/);
  assert.equal(html.includes('prototype-modal'), false);
  assert.equal(html.includes('Claude Code Runtime'), false);
});

test('app settings memory center renders shared search and editor controls', () => {
  const appUpdateSnapshot = {
    status: 'idle' as const,
    currentVersion: '0.0.0',
    canCheck: false,
    canDownload: false,
    canInstall: false,
    isPackaged: false,
    feedSource: 'none' as const,
    autoDownload: false
  };
  const memoryFile = {
    path: 'memory.md',
    title: 'memory.md',
    kind: 'longterm' as const,
    memoryKinds: ['project_fact' as const],
    tags: ['agent', 'ui'],
    excerpt: 'UI route migration notes',
    size: 128,
    lineCount: 8,
    updatedAt: new Date().toISOString(),
    content: '# Memory\nUI route migration notes'
  };
  const html = renderZh(
    createElement(AppSettingsModal, {
      initialTab: 'memory',
      theme: 'light',
      language: 'zh-CN',
      developerMode: false,
      runtimeStrategy: 'native',
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
      providers: [provider],
      providerTests: {},
      mcpPlugins: [],
      selectedMcpPlugin: null,
      serverInfo: null,
      tools: [],
      toolSnapshots: [],
      rawAudits: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      connectionStatus: null,
      connectionStatuses: {},
      pluginError: '',
      isRefreshingPlugin: false,
      memoryFiles: [memoryFile],
      selectedMemoryPath: memoryFile.path,
      selectedMemoryFile: memoryFile,
      memoryDraft: memoryFile.content,
      isLoadingMemory: false,
      isSavingMemory: false,
      memoryError: '',
      notificationTasks: [],
      isLoadingNotificationTasks: false,
      notificationTaskError: '',
      appUpdateStatus: null,
      selectedProjectId: 'project_memory',
      onChangeTheme: noop,
      onChangeLanguage: noop,
      onChangeDeveloperMode: noop,
      onChangeRuntimeStrategy: noop,
      onUpdateWebSearchSettings: noopAsync,
      onCreateProvider: noopAsync,
      onUpdateProvider: noopAsync,
      onDeleteProvider: noop,
      onTestProvider: noop,
      onSetDefaultProvider: noop,
      onSelectMcpPlugin: noop,
      onRefreshMcpPluginMeta: noop,
      onToggleMcpPlugin: noop,
      onAddMcpPlugin: noop,
      onEditMcpPlugin: noop,
      onDeleteMcpPlugin: noop,
      onSendRawMcpRequest: async () => ({
        method: 'tools/list',
        durationMs: 1,
        paramsSize: 2,
        responseSize: 2,
        truncated: false,
        result: {}
      }),
      onReconnectMcpPlugin: noop,
      onStopMcpPlugin: noop,
      onImportClaudeSession: noopAsync,
      onRefreshMemoryFiles: noopAsync,
      onSelectMemoryFile: noopAsync,
      onChangeMemoryDraft: noop,
      onSaveMemoryFile: noopAsync,
      onClearMemory: noopAsync,
      onRefreshNotificationTasks: noopAsync,
      onCancelNotificationTask: noopAsync,
      onRefreshAppUpdateStatus: async () => appUpdateSnapshot,
      onCheckForUpdates: async () => appUpdateSnapshot,
      onDownloadUpdate: async () => appUpdateSnapshot,
      onInstallUpdate: async () => appUpdateSnapshot,
      onClose: noop
    })
  );

  assert.match(html, /Memory/);
  assert.match(html, /搜索 Memory/);
  assert.match(html, /内容/);
  assert.match(html, /memory-search-field/);
  assert.match(html, /memory-editor-field/);
  assert.match(html, /memory-editor-textarea/);
  assert.match(html, /fp-field/);
  assert.match(html, /fp-input/);
  assert.match(html, /fp-textarea/);
  assert.match(html, /fp-button-ghost[^"]*active/);
  assert.match(html, /fp-button[^"]*memory-file-row active/);
  assert.doesNotMatch(html, /<button[^>]*class="memory-file-row/);
});

test('empty chat state renders actionable task starters', () => {
  const html = renderZh(
    createElement(MessageList, {
      sessionId: 'session_empty',
      messages: [],
      stream: null,
      emptyActions: [
        {
          id: 'continue-work',
          label: '继续完成项目',
          description: '检查当前状态并继续实现。',
          prompt: '检查当前项目状态，继续完成未完成的实现。'
        },
        {
          id: 'verify-run',
          label: '运行验证',
          description: '找出可用启动和测试命令。',
          prompt: '检查这个项目可以如何运行和验证。'
        }
      ],
      onSelectEmptyAction: noop,
      searchQuery: '',
      openablePaths: [],
      onOpenPath: noop,
      developerMode: false
    })
  );

  assert.match(html, /开始一个新对话/);
  assert.match(html, /常用任务起点/);
  assert.match(html, /继续完成项目/);
  assert.match(html, /运行验证/);
  assert.match(html, /选择一个常用起点/);
  assert.match(html, /fp-button[^"]*agent-empty-suggestion/);
  assert.doesNotMatch(html, /<button[^>]*class="agent-empty-suggestion/);
});

test('skills page hides filesystem registry UI', () => {
  const html = renderZh(
    createElement(SkillsPage, {
      project: null,
      draft: {
        id: '',
        name: '',
        description: '',
        trigger: '',
        instruction: '',
        enabled: true
      },
      editingSkillId: '',
      catalog: null,
      isLoadingCatalog: false,
      catalogError: '',
      onRefreshCatalog: noopAsync,
      onInstallCatalogSkill: async () => {},
      onChangeDraft: noop,
      onSaveSkill: noopAsync,
      onEditSkill: noop,
      onCancelEdit: noop,
      onToggleSkill: async () => {},
      onDeleteSkill: async () => {}
    })
  );

  assert.match(html, /项目 Skills/);
  assert.match(html, /Funplay Skill 仓库/);
  assert.match(html, /添加自定义 Skill/);
  assert.doesNotMatch(html, /Claude Code 文件系统 Skills/);
  assert.doesNotMatch(html, /文件系统 Skills/);
  assert.doesNotMatch(html, /backend-plan/);
  assert.doesNotMatch(html, /trusted_source/);
  assert.doesNotMatch(html, /project:10/);
  assert.doesNotMatch(html, /覆盖冲突/);
  assert.match(html, /fp-button/);
  assert.match(html, /fp-field/);
  assert.match(html, /fp-textarea/);
  assert.match(html, /fp-checkbox-field[^"]*skill-toggle-row/);
  assert.equal(html.includes('skill-form-row'), false);
  assert.equal(html.includes('prototype-primary'), false);
  assert.equal(html.includes('prototype-secondary'), false);
  assert.equal(html.includes('prototype-danger'), false);
  assert.equal(html.includes('prototype-ghost'), false);
});

test('message list windows old history by default but keeps search complete', () => {
  const messages: ChatMessage[] = Array.from({ length: 85 }, (_, index) => ({
    id: `msg_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: index === 0 ? 'old hidden marker' : index === 84 ? 'recent visible marker' : `message ${index}`,
    createdAt: new Date(2026, 4, 12, 10, index).toISOString()
  }));

  const defaultHtml = renderZh(
    createElement(MessageList, {
      sessionId: 'session_windowed',
      messages,
      stream: null,
      searchQuery: '',
      openablePaths: [],
      onOpenPath: noop,
      developerMode: false
    })
  );
  const searchHtml = renderZh(
    createElement(MessageList, {
      sessionId: 'session_windowed',
      messages,
      stream: null,
      searchQuery: 'old hidden marker',
      openablePaths: [],
      onOpenPath: noop,
      developerMode: false
    })
  );

  assert.match(defaultHtml, /已隐藏 5 条更早消息/);
  assert.match(defaultHtml, /fp-button[^"]*agent-hidden-history-button/);
  assert.doesNotMatch(defaultHtml, /old hidden marker/);
  assert.doesNotMatch(defaultHtml, /<button[^>]*class="agent-hidden-history-button/);
  assert.match(defaultHtml, /recent visible marker/);
  assert.match(searchHtml, /old hidden marker/);
  assert.doesNotMatch(searchHtml, /已隐藏/);
});

test('historical orphan tool results render a compact summary until expanded', () => {
  const longToolResult = [
    'tool summary line',
    ...Array.from({ length: 16 }, (_, index) => `middle result line ${index}`),
    'TAIL_SHOULD_NOT_RENDER_BY_DEFAULT'
  ].join('\n');
  const message: ChatMessage = {
    id: 'msg_tool_result_summary',
    role: 'assistant',
    content: longToolResult,
    createdAt: new Date().toISOString(),
    metadata: {
      agentCoreParts: [
        {
          id: 'part_tool_long_result',
          kind: 'tool_result',
          sequence: 0,
          createdAt: '2026-05-20T00:00:00.000Z',
          toolUseId: 'tool_long',
          toolName: 'tool_long',
          content: longToolResult
        }
      ]
    }
  };
  const html = renderZh(
    createElement(ChatTranscriptMessage, {
      message,
      openablePaths: [],
      searchQuery: '',
      developerMode: false,
      onOpenPath: noop
    })
  );

  assert.match(html, /tool summary line/);
  assert.match(html, /已处理 1 个工具/);
  assert.match(html, /tool_long/);
  assert.doesNotMatch(html, /TAIL_SHOULD_NOT_RENDER_BY_DEFAULT/);
});

test('assets page empty state stays focused without a duplicate discovery side panel', () => {
  const project = {
    id: 'project_assets',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const html = renderZh(
    createElement(AssetsPage, {
      project,
      projectFiles: [
        {
          id: 'dir_assets',
          name: 'assets',
          path: 'assets',
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'dir_images',
          name: 'images',
          path: 'assets/images',
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'dir_audio',
          name: 'audio',
          path: 'assets/audio',
          type: 'directory',
          size: 0,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'file_memory',
          name: 'memory.md',
          path: 'memory.md',
          type: 'file',
          size: 128,
          modifiedAt: new Date().toISOString()
        }
      ],
      onOpenAsset: noop,
      onOpenProjectFile: noop
    })
  );

  assert.match(html, /暂无素材/);
  assert.match(html, /0 个当前素材 · 0 个素材总计 · 0 个项目文件可识别/);
  assert.doesNotMatch(html, /素材扫描结果/);
  assert.doesNotMatch(html, /asset-library-inspector/);
  assert.doesNotMatch(html, /assets\/images/);
  assert.doesNotMatch(html, /asset-category-tabs/);
  assert.match(html, /project-settings-page/);
  assert.match(html, /project-settings-sidebar/);
  assert.match(html, /aria-label="素材库分类"/);
  assert.match(html, /fp-button[^"]*project-settings-nav-item active/);
});

test('assets page renders asset cards through shared buttons', () => {
  const project = {
    id: 'project_assets_cards',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const html = renderZh(
    createElement(AssetsPage, {
      project,
      projectFiles: [
        {
          id: 'file_player',
          name: 'player.png',
          path: 'assets/images/player.png',
          type: 'file',
          size: 2048,
          modifiedAt: new Date().toISOString()
        }
      ],
      onOpenAsset: noop,
      onOpenProjectFile: noop
    })
  );

  assert.match(html, /player\.png/);
  assert.match(html, /asset-library-detail/);
  assert.match(html, /fp-button[^"]*asset-library-card/);
  assert.doesNotMatch(html, /<button[^>]*class="asset-library-card/);
});

test('assets page can be controlled by the parent active tab state', () => {
  const project = {
    id: 'project_assets_controlled',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {}
  } as unknown as Project;
  const html = renderZh(
    createElement(AssetsPage, {
      project,
      projectFiles: [
        {
          id: 'file_player',
          name: 'player.png',
          path: 'assets/images/player.png',
          type: 'file',
          size: 2048,
          modifiedAt: new Date().toISOString()
        },
        {
          id: 'file_bgm',
          name: 'bgm.mp3',
          path: 'assets/audio/bgm.mp3',
          type: 'file',
          size: 4096,
          modifiedAt: new Date().toISOString()
        }
      ],
      activeViewId: 'audio',
      onActiveViewChange: noop,
      onOpenAsset: noop,
      onOpenProjectFile: noop
    })
  );

  assert.match(html, /<h2>音频<\/h2>/);
  assert.match(html, /bgm\.mp3/);
  assert.doesNotMatch(html, /player\.png/);
});

test('asset library grid excludes generation jobs from the project asset view', () => {
  const project = {
    id: 'project_assets_jobs',
    name: 'Rogue',
    sessions: [],
    mcpBindings: {},
    chat: [],
    activity: [],
    assets: [],
    tasks: [],
    memory: {},
    contextSummary: {},
    blueprint: {},
    assetGenerationJobs: [
      {
        id: 'job_splash',
        projectId: 'project_assets_jobs',
        title: 'Generated Splash',
        kind: 'image_2d',
        prompt: 'a splash screen',
        providerId: 'asset_provider_openai',
        providerName: 'OpenAI Images',
        providerAdapter: 'openai-image',
        references: [],
        outputSpec: {},
        status: 'completed',
        progress: 1,
        createdBy: 'user',
        outputs: [
          {
            id: 'output_splash',
            name: 'splash.png',
            kind: 'image_2d',
            path: 'assets/generated/images/splash.png',
            mimeType: 'image/png',
            format: 'png',
            size: 1024
          }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }
    ]
  } as unknown as Project;
  const html = renderZh(
    createElement(AssetsPage, {
      project,
      projectFiles: [
        {
          id: 'file_player',
          name: 'player.png',
          path: 'assets/images/player.png',
          type: 'file',
          size: 2048,
          modifiedAt: new Date().toISOString()
        }
      ],
      assetGenerationProviders: [],
      onOpenAsset: noop,
      onOpenProjectFile: noop
    })
  );

  assert.match(html, /player\.png/);
  assert.match(html, /生成记录/);
  assert.doesNotMatch(html, /Generated Splash/);
  assert.doesNotMatch(html, /asset-generation-job/);
});
