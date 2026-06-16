import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logEngineDebug, logEngineWarn } from './engine-log';

// The official cocos4 / cocos-cli toolchain (https://github.com/cocos/cocos-cli)
// is source-only — not published to npm — so "downloading cocos4" means cloning
// cocos-cli and letting its `npm run init` pull the cocos4 engine, then building.
// This module owns detection, prerequisite checks, and the staged install.
const COCOS_CLI_REPO = 'https://github.com/cocos/cocos-cli.git';
const MIN_NODE_MAJOR = 22;

export interface CocosCliInstallation {
  dir: string;
  cliPath: string;
}

// Where Funplay keeps its managed cocos-cli checkout. Overridable via
// COCOS_CLI_DIR so a user who already built cocos-cli (or a test) can point at it.
export function getCocosCliDir(userDataPath: string): string {
  const override = process.env.COCOS_CLI_DIR?.trim();
  return override || join(userDataPath, 'cocos-cli');
}

// A usable cocos-cli exists only once `dist/cli.js` has been built (npm install's
// postinstall produces it); a bare clone without a build does not count.
export function findCocosCliInstallation(userDataPath: string): CocosCliInstallation | undefined {
  const dir = getCocosCliDir(userDataPath);
  const cliPath = join(dir, 'dist', 'cli.js');
  return existsSync(cliPath) ? { dir, cliPath } : undefined;
}

export interface CocosCliPrerequisites {
  ok: boolean;
  nodeVersion?: string;
  nodeOk: boolean;
  gitOk: boolean;
  missing: string[];
}

function readToolVersion(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 4000 }).trim();
  } catch (error) {
    logEngineDebug('cocos-cli', `prerequisite probe failed: ${command}`, error);
    return undefined;
  }
}

// cocos-cli's `npm install` shells out to the system node/npm/git toolchain, so we
// gate on those rather than Electron's bundled node. Building the native engine
// also needs platform C++ tooling, but that surfaces as a build-step failure with
// guidance rather than a hard pre-check (it's expensive to probe reliably).
export function checkCocosCliPrerequisites(): CocosCliPrerequisites {
  const nodeVersion = readToolVersion('node', ['-v']);
  const gitVersion = readToolVersion('git', ['--version']);
  const nodeMajor = nodeVersion ? Number(nodeVersion.replace(/^v/, '').split('.')[0]) : NaN;
  const nodeOk = Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR;
  const gitOk = Boolean(gitVersion);
  const missing: string[] = [];
  if (!nodeOk) {
    missing.push(`Node.js ${MIN_NODE_MAJOR}+（当前：${nodeVersion ?? '未检测到'}）`);
  }
  if (!gitOk) {
    missing.push('git');
  }
  return { ok: nodeOk && gitOk, nodeVersion, nodeOk, gitOk, missing };
}

export type CocosCliInstallStageId = 'checking' | 'downloading' | 'installing' | 'validating';

export interface CocosCliInstallStep {
  stage: CocosCliInstallStageId;
  progress: number;
  message: string;
  command: string;
  args: string[];
  cwd: string;
}

export interface CocosCliInstallResult {
  ok: boolean;
  message: string;
  cliPath?: string;
}

// One subprocess step of the install. Injectable so tests can drive the
// orchestration (success/failure ordering) without cloning 3.5G or building.
export type CocosCliStepRunner = (step: CocosCliInstallStep) => Promise<{ code: number; stderrTail?: string }>;

function defaultStepRunner(step: CocosCliInstallStep): Promise<{ code: number; stderrTail?: string }> {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { cwd: step.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    });
    child.on('error', (error) => resolve({ code: -1, stderrTail: error.message }));
    child.on('exit', (code) => resolve({ code: code ?? -1, stderrTail }));
  });
}

// The staged install: clone cocos-cli → `npm run init` (pulls cocos4) → `npm
// install` (builds dist/cli.js) → verify. Each stage reports progress; any
// non-zero step aborts with the captured stderr tail. This is intentionally long
// and heavy (~5G, several minutes); callers run it as a background task.
export async function installCocosCli(options: {
  userDataPath: string;
  onStage: (stage: CocosCliInstallStageId, progress: number, message: string) => void;
  runStep?: CocosCliStepRunner;
}): Promise<CocosCliInstallResult> {
  const { userDataPath, onStage } = options;
  const runStep = options.runStep ?? defaultStepRunner;
  const dir = getCocosCliDir(userDataPath);

  const prereqs = checkCocosCliPrerequisites();
  if (!prereqs.ok) {
    return {
      ok: false,
      message: `缺少安装 cocos-cli 所需的前置环境：${prereqs.missing.join('、')}。请安装后重试。`
    };
  }

  const existing = findCocosCliInstallation(userDataPath);
  if (existing) {
    onStage('validating', 100, 'cocos-cli 已安装。');
    return { ok: true, message: `cocos-cli 已安装：${existing.cliPath}`, cliPath: existing.cliPath };
  }

  const steps: CocosCliInstallStep[] = [
    {
      stage: 'downloading',
      progress: 15,
      message: '正在克隆 cocos-cli…',
      command: 'git',
      args: ['clone', '--depth', '1', COCOS_CLI_REPO, dir],
      cwd: userDataPath
    },
    {
      stage: 'downloading',
      progress: 45,
      message: '正在拉取 cocos4 引擎（约 3.5G，耗时较长）…',
      command: 'npm',
      args: ['run', 'init'],
      cwd: dir
    },
    {
      stage: 'installing',
      progress: 80,
      message: '正在安装依赖并构建 cocos-cli…',
      command: 'npm',
      args: ['install'],
      cwd: dir
    }
  ];

  for (const step of steps) {
    onStage(step.stage, step.progress, step.message);
    const result = await runStep(step);
    if (result.code !== 0) {
      logEngineWarn('cocos-cli', `install step failed: ${step.command} ${step.args.join(' ')}`, result.stderrTail);
      return {
        ok: false,
        message: `${step.message.replace(/…$/, '')}失败（exit ${result.code}）。${result.stderrTail ? `\n${result.stderrTail.slice(-600)}` : ''}`
      };
    }
  }

  onStage('validating', 95, '正在校验 cocos-cli 构建产物…');
  const installed = findCocosCliInstallation(userDataPath);
  if (!installed) {
    return {
      ok: false,
      message: `cocos-cli 安装未完成：${join(dir, 'dist', 'cli.js')} 缺失（构建可能失败）。`
    };
  }
  return { ok: true, message: `cocos-cli 安装完成：${installed.cliPath}`, cliPath: installed.cliPath };
}
