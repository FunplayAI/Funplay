import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import electron from 'electron';
import type {
  AppState,
  EngineProjectDimension,
  EnvironmentTask,
  EnvironmentTaskStage,
  EnvironmentTaskStatus,
  ProjectSetupMode
} from '../../shared/types';
import {
  environmentTasks,
  createTask,
  completeTask,
  taskStageUpdate,
  bindTaskProjectPath
} from './environment-task-manager';
import { checkUnityHealth } from './unity-bridge';
import { nowIso } from '../../shared/utils';
import {
  isUnityHubInstalled,
  getUnityHubBinary,
  findUnityEditorInstall,
  isValidUnityProject,
  normalizeProjectPath,
  resolveTargetProjectPath,
  ensureBothInputSystemsEnabled,
  installBridgeDependency,
  configureUnityMcpPort,
  readFunplayMcpSettingsFile,
  type UnityVersionRecommendation
} from './environment-service';
import {
  selectUnityEditorForTemplate,
  selectUnityEditorForProject,
  compareUnityVersions,
  versionStrategyLabel
} from './unity-version';

const execFileAsync = promisify(execFile);
const shell = electron.shell;

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

export async function startInstallUnityHubTask(): Promise<EnvironmentTask> {
  const task = createTask('install_unity_hub', '安装 Unity Hub', '正在准备安装 Unity Hub…');
  taskStageUpdate(task.id, {
    stage: 'checking',
    status: 'running',
    progress: 8,
    message: '正在检查本机安装环境…',
    log: '开始检测 Homebrew。'
  });

  const hasBrew = await commandExists('brew');
  if (hasBrew) {
    taskStageUpdate(task.id, {
      stage: 'downloading',
      progress: 18,
      message: '正在下载 Unity Hub…',
      log: '已检测到 Homebrew，开始执行 brew install --cask unity-hub。'
    });

    const child = spawn('brew', ['install', '--cask', 'unity-hub'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      taskStageUpdate(task.id, {
        stage: /install/i.test(text) ? 'installing' : 'downloading',
        progress: Math.min((environmentTasks.get(task.id)?.progress ?? 18) + 5, 88),
        message: /install/i.test(text) ? '正在安装 Unity Hub…' : '正在下载 Unity Hub…',
        log: text
      });
    });
    child.stderr.on('data', (data) => {
      taskStageUpdate(task.id, {
        log: data.toString().trim()
      });
    });
    child.on('close', (code) => {
      taskStageUpdate(task.id, {
        stage: 'validating',
        progress: 92,
        message: '正在校验 Unity Hub 安装结果…',
        log: '安装命令已结束，开始校验。'
      });
      if (code === 0 && isUnityHubInstalled()) {
        completeTask(task.id, 'completed', 'Unity Hub 安装完成。');
      } else if (code === 0) {
        taskStageUpdate(task.id, {
          stage: 'waiting_manual',
          status: 'needs_user',
          progress: 92,
          message: '安装命令已完成，但尚未检测到 Unity Hub，请手动确认是否已安装。',
          log: '等待用户手动确认 Unity Hub 安装结果。'
        });
      } else {
        completeTask(task.id, 'failed', '通过 Homebrew 安装 Unity Hub 失败，请手动安装。', 100);
      }
    });
    return task;
  }

  taskStageUpdate(task.id, {
    stage: 'waiting_manual',
    status: 'needs_user',
    progress: 24,
    message: '未检测到 Homebrew，已打开 Unity Hub 官方下载页。',
    log: '未检测到 Homebrew，切换为官方下载安装页。'
  });
  await shell.openExternal('https://unity.com/download');

  const interval = setInterval(() => {
    if (isUnityHubInstalled()) {
      clearInterval(interval);
      completeTask(task.id, 'completed', '已检测到 Unity Hub 安装完成。');
    }
  }, 5000);

  setTimeout(() => {
    clearInterval(interval);
    if (environmentTasks.get(task.id)?.status !== 'completed') {
      completeTask(task.id, 'needs_user', '请完成 Unity Hub 安装后返回重新检测。', 100);
    }
  }, 10 * 60 * 1000);

  return task;
}

export async function detectRecommendedUnityVersion(input?: {
  mode?: ProjectSetupMode;
  dimension?: EngineProjectDimension;
  unityEditorVersion?: string | null;
}): Promise<UnityVersionRecommendation | null> {
  const preferredVersion = input?.unityEditorVersion?.trim();
  if (preferredVersion) {
    return {
      version: preferredVersion,
      strategyLabel: '匹配当前 Unity 项目保存版本，避免打开时触发项目升级'
    };
  }

  const binary = getUnityHubBinary();
  if (!binary) {
    return null;
  }

  try {
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const { stdout } = await execFileAsync(binary, ['--', '--headless', 'editors', '-r', '-j', '-a', architecture], {
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });

    const releases = JSON.parse(stdout) as Array<{ version?: string }>;
    const versions = releases.map((release) => release.version).filter((version): version is string => !!version);
    const dimension = input?.dimension ?? 'unknown';
    const strategyLabel = versionStrategyLabel(dimension);
    const stableByFamily = versions.filter((version) => /f\d+/i.test(version)).sort((left, right) => compareUnityVersions(right, left))[0] ?? null;

    const version =
      stableByFamily ??
      versions.sort((left, right) => compareUnityVersions(right, left))[0];

    return version
      ? {
          version,
          strategyLabel
        }
      : null;
  } catch {
    return null;
  }
}

export async function startInstallUnityEditorTask(input?: {
  mode?: ProjectSetupMode;
  dimension?: EngineProjectDimension;
  unityEditorVersion?: string | null;
}): Promise<EnvironmentTask> {
  const task = createTask('install_unity_editor', '安装 Unity Editor', '正在准备安装 Unity Editor…');
  taskStageUpdate(task.id, {
    stage: 'checking',
    status: 'running',
    progress: 6,
    message: '正在检查 Unity Hub 与可用版本…',
    log: '开始检查 Unity Hub。'
  });

  const binary = getUnityHubBinary();
  if (!binary) {
    completeTask(task.id, 'failed', '未检测到 Unity Hub，请先安装 Hub。');
    return task;
  }

  const recommendation = await detectRecommendedUnityVersion(input);
  if (!recommendation) {
    taskStageUpdate(task.id, {
      stage: 'waiting_manual',
      status: 'needs_user',
      progress: 20,
      message: '未能自动获取推荐 Unity 版本，已打开 Unity Hub，请手动安装 LTS 版本。',
      log: '自动查询 Unity 版本失败。'
    });
    await shell.openPath(join(binary, '../../..'));
    return task;
  }

  const version = recommendation.version;

  taskStageUpdate(task.id, {
    stage: 'downloading',
    progress: 28,
    message: `正在下载 Unity Editor ${version}…`,
    log: `已选择推荐版本 ${version}（${recommendation.strategyLabel}），开始后台安装。`
  });

  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const args = ['--', '--headless', 'install', '--version', version, '--architecture', architecture];
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => {
    const text = data.toString().trim();
    const nextStage: EnvironmentTaskStage =
      /login|sign in|authenticate/i.test(text) ? 'waiting_login' : /install/i.test(text) ? 'installing' : 'downloading';
    const nextStatus: EnvironmentTaskStatus | undefined = nextStage === 'waiting_login' ? 'needs_user' : 'running';
    taskStageUpdate(task.id, {
      stage: nextStage,
      status: nextStatus,
      progress: Math.min((environmentTasks.get(task.id)?.progress ?? 28) + 4, 92),
      message:
        nextStage === 'waiting_login'
          ? '等待用户登录 Unity Hub…'
          : nextStage === 'installing'
            ? `正在安装 Unity Editor ${version}…`
            : `正在下载 Unity Editor ${version}…`,
      log: text
    });
  });
  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    const waitingLogin = /login|sign in|authenticate|license/i.test(text);
    taskStageUpdate(task.id, {
      stage: waitingLogin ? 'waiting_login' : environmentTasks.get(task.id)?.stage ?? 'installing',
      status: waitingLogin ? 'needs_user' : environmentTasks.get(task.id)?.status,
      message: waitingLogin ? '等待用户登录 Unity Hub 或激活 License…' : environmentTasks.get(task.id)?.message,
      log: text
    });
  });
  child.on('close', (code) => {
    taskStageUpdate(task.id, {
      stage: 'validating',
      progress: 94,
      status: 'running',
      message: '正在校验 Unity Editor 安装结果…',
      log: '安装命令已结束，开始校验。'
    });
    const editor = findUnityEditorInstall();
    if (code === 0 && editor.installed) {
      completeTask(task.id, 'completed', `Unity Editor 安装完成：${editor.versions.join('、')}`);
    } else {
      completeTask(task.id, 'failed', 'Unity Editor 安装失败，请检查 Unity Hub 登录状态或手动安装。');
    }
  });

  return task;
}

export async function openUnityProjectDirectly(projectPath: string, editorAppPath?: string | null): Promise<boolean> {
  if (!isValidUnityProject(projectPath)) {
    return false;
  }

  const appPath = editorAppPath ?? selectUnityEditorForProject(projectPath).editor?.appPath;
  if (!appPath) {
    return false;
  }

  const editorBinary = join(appPath, 'Contents', 'MacOS', 'Unity');
  const normalizedProjectPath = projectPath.trim().replace(/^~/, process.env.HOME ?? '~');

  try {
    spawn(editorBinary, ['-projectPath', normalizedProjectPath], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    return true;
  } catch {
    return false;
  }
}

export async function warmUpUnityProject(
  editorAppPath: string,
  projectPath: string,
  onProgress?: (message: string) => void
): Promise<boolean> {
  const editorBinary = join(editorAppPath, 'Contents', 'MacOS', 'Unity');
  const normalizedProjectPath = normalizeProjectPath(projectPath);

  return await new Promise<boolean>((resolve) => {
    const child = spawn(editorBinary, ['-batchmode', '-quit', '-projectPath', normalizedProjectPath, '-logFile', '-'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        onProgress?.(text);
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        onProgress?.(text);
      }
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}

export async function startCreateUnityProjectTask(
  state: AppState,
  input: {
    mode: ProjectSetupMode;
    dimension: EngineProjectDimension;
    projectName?: string;
    projectPath: string;
    unityEditorVersion?: string;
  }
): Promise<EnvironmentTask> {
  const targetProjectPath = resolveTargetProjectPath(input);
  const task = createTask('create_unity_project', '创建 Unity 项目', '正在准备自动创建 Unity 项目…');
  bindTaskProjectPath(task.id, targetProjectPath);
  taskStageUpdate(task.id, {
    stage: 'checking',
    status: 'running',
    progress: 8,
    message: '正在检查官方模板、Unity Editor、项目名称和目标目录…',
    log: `目标项目路径：${targetProjectPath}`
  });

  const templateSelection = selectUnityEditorForTemplate(input.dimension, input.unityEditorVersion);
  if (!templateSelection) {
    completeTask(
      task.id,
      'failed',
      `未检测到可用于创建官方 ${input.dimension === '2d' ? '2D URP' : '3D URP'} 模板的 Unity Editor，请先安装推荐版本后重试。`
    );
    return task;
  }

  const projectName = (input.projectName ?? '').trim();
  if (!projectName) {
    completeTask(task.id, 'failed', '请先填写项目名称。');
    return task;
  }

  const parentDir = normalizeProjectPath(input.projectPath);
  if (!existsSync(parentDir)) {
    completeTask(task.id, 'failed', '项目创建目录不存在，请先选择有效目录。');
    return task;
  }

  if (existsSync(targetProjectPath) && !isValidUnityProject(targetProjectPath)) {
    completeTask(task.id, 'failed', '目标项目目录已存在，但不是有效的 Unity 项目，请更换名称或目录。');
    return task;
  }

  if (isValidUnityProject(targetProjectPath)) {
    taskStageUpdate(task.id, {
      stage: 'validating',
      status: 'running',
      progress: 74,
      message: '目标 Unity 项目已存在，正在直接打开并继续后续接入…',
      log: '检测到目标项目已存在，无需重复创建。'
    });
    ensureBothInputSystemsEnabled(targetProjectPath);
    installBridgeDependency(targetProjectPath);
    const preferredPort = state.settings.lastAssignedMcpPort ?? 8765;
    const assignedEndpoint = await configureUnityMcpPort(targetProjectPath, preferredPort);
    if (assignedEndpoint) {
      syncDiscoveredUnityMcpEndpoint(state, assignedEndpoint.url);
    }
    await openUnityProjectDirectly(targetProjectPath, templateSelection.editor.appPath);
    waitForBridgeAfterOpen(task.id, state, targetProjectPath);
    return task;
  }

  const editorBinary = join(templateSelection.editor.appPath, 'Contents', 'MacOS', 'Unity');
  taskStageUpdate(task.id, {
    stage: 'installing',
    status: 'running',
    progress: 24,
    message: `正在按 Unity 官方模板创建 ${templateSelection.template.displayName} 项目…`,
    log: `开始调用 Unity Editor 官方模板创建项目：${templateSelection.editor.version} / ${templateSelection.template.displayName}`
  });

  const child = spawn(
    editorBinary,
    ['-batchmode', '-quit', '-createProject', targetProjectPath, '-cloneFromTemplate', templateSelection.template.path, '-logFile', '-'],
    {
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  child.stdout.on('data', (data) => {
    const text = data.toString().trim();
    taskStageUpdate(task.id, {
      stage: 'installing',
      progress: Math.min((environmentTasks.get(task.id)?.progress ?? 24) + 4, 70),
      message: `正在按 Unity 官方模板创建 ${templateSelection.template.displayName} 项目…`,
      log: text
    });
  });

  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    taskStageUpdate(task.id, {
      log: text
    });
  });

  child.on('close', (code) => {
    void (async () => {
      taskStageUpdate(task.id, {
        stage: 'validating',
        status: 'running',
        progress: 76,
        message: '正在校验 Unity 项目创建结果…',
        log: 'Unity 官方模板创建命令已结束，开始校验结果。'
      });

      if (code !== 0 || !isValidUnityProject(targetProjectPath)) {
        completeTask(task.id, 'failed', 'Unity 官方模板项目创建失败，请检查 Unity License、磁盘权限和模板环境。');
        return;
      }

      taskStageUpdate(task.id, {
        stage: 'installing',
        status: 'running',
        progress: 84,
        message: '正在为新项目配置输入系统并安装 Funplay Bridge…',
        log: '官方模板项目已创建完成，开始写入 Active Input Handling 和 Bridge 依赖。'
      });
      try {
        ensureBothInputSystemsEnabled(targetProjectPath);
        installBridgeDependency(targetProjectPath);
      } catch (error) {
        completeTask(task.id, 'failed', error instanceof Error ? error.message : '写入项目依赖失败。');
        return;
      }

      taskStageUpdate(task.id, {
        stage: 'installing',
        status: 'running',
        progress: 87,
        message: '正在为 MCP 分配空闲端口并写入启动配置…',
        log: '开始为 Unity MCP 分配端口并写入 EditorPrefs 引导脚本。'
      });
      const preferredPort = state.settings.lastAssignedMcpPort ?? 8765;
      const assignedEndpoint = await configureUnityMcpPort(targetProjectPath, preferredPort);
      if (!assignedEndpoint) {
        completeTask(task.id, 'failed', '写入 Unity MCP 端口配置失败，无法继续自动启动 Bridge。');
        return;
      }
      syncDiscoveredUnityMcpEndpoint(state, assignedEndpoint.url);

      taskStageUpdate(task.id, {
        stage: 'installing',
        status: 'running',
        progress: 89,
        message: '正在预热 Unity 项目并完成首次导入…',
        log: '开始无头打开项目，提前完成 URP / Package 首次升级与导入。'
      });
      const warmed = await warmUpUnityProject(templateSelection.editor.appPath, targetProjectPath, (log) => {
        taskStageUpdate(task.id, {
          stage: 'installing',
          progress: Math.min(environmentTasks.get(task.id)?.progress ?? 89, 91),
          message: '正在预热 Unity 项目并完成首次导入…',
          log
        });
      });
      if (!warmed) {
        taskStageUpdate(task.id, {
          stage: 'validating',
          status: 'running',
          progress: 91,
          message: '项目预热未完全完成，继续尝试打开编辑器…',
          log: '无头预热未成功完成，将继续直接打开 Unity Editor。'
        });
      }

      const opened = await openUnityProjectDirectly(targetProjectPath, templateSelection.editor.appPath);
      if (!opened) {
        taskStageUpdate(task.id, {
          stage: 'waiting_manual',
          status: 'needs_user',
          progress: 90,
          message: '项目已按官方模板创建并已写入 Bridge 依赖，请手动打开该 Unity 项目。',
          log: '自动打开项目失败，等待用户手动打开。'
        });
        return;
      }

      taskStageUpdate(task.id, {
        stage: 'validating',
        status: 'running',
        progress: 92,
        message: '项目已创建并打开，正在等待 Bridge / MCP 自动连通…',
        log: '已自动打开项目，开始等待 Unity 导入依赖并启动 MCP。'
      });
      waitForBridgeAfterOpen(task.id, state, targetProjectPath);
    })();
  });

  return task;
}

export function syncDiscoveredUnityMcpEndpoint(state: AppState, url: string): void {
  state.settings.baseUrl = url;
  const portMatch = url.match(/:(\d+)\/?$/);
  if (portMatch) {
    state.settings.lastAssignedMcpPort = Number(portMatch[1]);
  }
  for (const plugin of state.mcpPlugins) {
    if (plugin.kind === 'engine' && /unity|mcp|bridge/i.test(`${plugin.name} ${plugin.notes ?? ''}`)) {
      plugin.baseUrl = url;
      plugin.updatedAt = nowIso();
    }
  }
}

export function waitForBridgeAfterOpen(taskId: string, state: AppState, projectPath?: string): void {
  let attempts = 0;
  const maxAttempts = 60;
  let stopped = false;
  const probe = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    attempts += 1;
    const configuredEndpoint = projectPath ? readFunplayMcpSettingsFile(projectPath) : null;
    if (configuredEndpoint) {
      syncDiscoveredUnityMcpEndpoint(state, configuredEndpoint.url);
    }
    const healthBaseUrl = configuredEndpoint?.url || state.settings.baseUrl || 'http://127.0.0.1:8765/';
    try {
      const health = await checkUnityHealth(
        healthBaseUrl,
        projectPath ? { expectedProjectPath: projectPath, bypassCache: true } : { bypassCache: true }
      );
      if (stopped) {
        return;
      }
      if (health.status === 'online') {
        stopped = true;
        syncDiscoveredUnityMcpEndpoint(state, health.url);
        completeTask(taskId, 'completed', 'Unity 项目已打开，Bridge / MCP 已连通。');
        return;
      }

      taskStageUpdate(taskId, {
        stage: 'validating',
        status: 'running',
        progress: Math.min(76 + attempts, 96),
        message: 'Unity 项目已启动，正在等待 Bridge / MCP 连通…',
        log: health.message
      });
    } catch (error) {
      if (stopped) {
        return;
      }
      taskStageUpdate(taskId, {
        stage: 'validating',
        status: 'running',
        progress: Math.min(76 + attempts, 96),
        message: 'Unity 项目已启动，正在等待 Bridge / MCP 连通…',
        log: error instanceof Error ? error.message : 'Unity MCP 检测失败。'
      });
    }

    if (attempts >= maxAttempts) {
      stopped = true;
      taskStageUpdate(taskId, {
        stage: 'waiting_manual',
        status: 'needs_user',
        progress: 96,
        message: 'Unity 项目可能已打开，但还没有检测到 Bridge / MCP。请确认 Bridge 已安装并启用，然后点击重新检测。',
        log: '等待 Bridge / MCP 连通超时。'
      });
      return;
    }

    setTimeout(() => {
      void probe();
    }, 3000);
  };

  void probe();
}
