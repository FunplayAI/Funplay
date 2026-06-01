import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { makeId } from '../../../shared/utils';
import type {
  AgentToolArtifact,
  AgentToolCommandResult,
  AgentVerificationCheckKind,
  AgentVerificationFailureDiagnosis,
  AgentVerificationFailureKind,
  AgentVerificationFailureReference,
  AgentVerificationTrigger
} from '../../../shared/types';
import { executeAgentToolAction, type WorkspaceToolActionResult } from './workspace-tools';
import type { ConversationOperationStageEvent } from './operation-log';
import type { GenericAgentRuntimeParams, GenericProjectContextIndex } from './types';

export interface ActiveVerificationCheckPlan {
  id: string;
  kind: AgentVerificationCheckKind;
  title: string;
  command?: string;
  cwd?: string;
  target?: string;
  required: boolean;
}

export interface ActiveVerificationPlan {
  trigger: AgentVerificationTrigger;
  blocking: boolean;
  checks: ActiveVerificationCheckPlan[];
  omittedChecks?: ActiveVerificationOmittedCheck[];
  sideEffects?: ActiveVerificationSideEffectEvidence[];
}

export interface ActiveVerificationOmittedCheck {
  id: string;
  kind: AgentVerificationCheckKind;
  title: string;
  command?: string;
  cwd?: string;
  target?: string;
  required?: boolean;
  reason: 'max_checks' | 'duplicate';
}

export interface ActiveVerificationPlanningEvidence {
  changedFiles?: string[];
  sideEffects?: ActiveVerificationSideEffectEvidence[];
}

export interface ActiveVerificationSideEffectEvidence {
  toolName: string;
  kind: string;
  confidence: string;
  verificationTrigger?: AgentVerificationTrigger;
  evidence: string[];
}

export interface ActiveVerificationCheckResult extends ActiveVerificationCheckPlan {
  status: 'passed' | 'failed' | 'skipped';
  outputPreview?: string;
  errorMessage?: string;
  commandResult?: AgentToolCommandResult;
  artifacts?: AgentToolArtifact[];
}

export interface ActiveVerificationRunResult {
  status: 'passed' | 'failed' | 'skipped';
  trigger: AgentVerificationTrigger;
  blocking: boolean;
  checks: ActiveVerificationCheckResult[];
  omittedChecks?: ActiveVerificationOmittedCheck[];
  summary: string;
  diagnosis?: ActiveVerificationFailureDiagnosis;
}

export interface ActiveVerificationRepairFileEvidence {
  path: string;
  excerpt: string;
  source: 'changed_file' | 'verification_output';
  line?: number;
  truncated?: boolean;
}

export type ActiveVerificationFailureKind = AgentVerificationFailureKind;
export type ActiveVerificationFailureDiagnosis = AgentVerificationFailureDiagnosis;

export interface ActiveVerificationChangeSummary {
  source: 'checkpoint_diff' | 'changed_files';
  summary: string;
  truncated?: boolean;
}

const MAX_REPAIR_ARTIFACT_REFERENCES = 4;
const MAX_REPAIR_ARTIFACT_SNIPPET_BYTES = 12_000;
const MAX_REPAIR_ARTIFACT_SNIPPET_CHARS = 8_000;

function readVerificationArtifactExcerpt(path: string): { excerpt: string; truncated?: boolean } | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return undefined;
    }
    const bytesToRead = Math.min(stat.size, MAX_REPAIR_ARTIFACT_SNIPPET_BYTES);
    if (bytesToRead <= 0) {
      return undefined;
    }
    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    } finally {
      closeSync(fd);
    }
    let excerpt = buffer.toString('utf8').replace(/\0+$/g, '');
    if (excerpt.length > MAX_REPAIR_ARTIFACT_SNIPPET_CHARS) {
      excerpt = excerpt.slice(excerpt.length - MAX_REPAIR_ARTIFACT_SNIPPET_CHARS);
    }
    return {
      excerpt,
      truncated: stat.size > bytesToRead || excerpt.length >= MAX_REPAIR_ARTIFACT_SNIPPET_CHARS || undefined
    };
  } catch {
    return undefined;
  }
}

function formatVerificationArtifactReferences(artifacts: AgentToolArtifact[] | undefined): string[] {
  return (artifacts ?? [])
    .filter((artifact) => artifact.type === 'command_output' && (artifact.path || artifact.title))
    .slice(0, MAX_REPAIR_ARTIFACT_REFERENCES)
    .map((artifact, index) => {
      const excerpt = artifact.path ? readVerificationArtifactExcerpt(artifact.path) : undefined;
      return [
        `Artifact ${index + 1}: ${artifact.title ?? artifact.type}`,
        artifact.path ? `Path: ${artifact.path}` : '',
        artifact.size !== undefined ? `Size: ${artifact.size} bytes` : '',
        excerpt
          ? [
              `Excerpt${excerpt.truncated ? ' (tail, truncated)' : ''}:`,
              excerpt.excerpt
            ].join('\n')
          : ''
      ].filter(Boolean).join('\n');
    });
}

export function createActiveVerificationRepairPrompt(input: {
  originalUserMessage: string;
  previousAssistantMessage?: string;
  verification: ActiveVerificationRunResult;
  relatedFiles?: ActiveVerificationRepairFileEvidence[];
  changeSummary?: ActiveVerificationChangeSummary;
}): string {
  const failedChecks = input.verification.checks.filter((check) => check.status === 'failed');
  return [
    'Funplay active verification failed after your last workspace changes.',
    '',
    'Your task is to perform one focused repair pass, then stop with a concise summary.',
    'Do not broaden the scope. Do not reimplement unrelated files. Inspect or edit only what is necessary to make the failed verification pass.',
    '',
    'Original user request:',
    input.originalUserMessage,
    '',
    input.previousAssistantMessage?.trim()
      ? ['Previous assistant message:', input.previousAssistantMessage.trim()].join('\n')
      : '',
    '',
    'Failed verification summary:',
    input.verification.summary,
    input.verification.diagnosis
      ? [
          '',
          'Failure diagnosis:',
          `Kind: ${input.verification.diagnosis.kind}`,
          `Summary: ${input.verification.diagnosis.summary}`,
          `Suggested focus: ${input.verification.diagnosis.suggestedFocus}`,
          input.verification.diagnosis.evidence.length
            ? `Evidence: ${input.verification.diagnosis.evidence.join('; ')}`
            : '',
          input.verification.diagnosis.references?.length
            ? `References: ${input.verification.diagnosis.references.map(formatFailureReference).join('; ')}`
            : ''
        ].filter(Boolean).join('\n')
      : '',
    input.changeSummary
      ? [
          '',
          `Changes to inspect (${input.changeSummary.source}${input.changeSummary.truncated ? ', truncated' : ''}):`,
          input.changeSummary.summary
        ].join('\n')
      : '',
    '',
    'Verification checks from failed run (the host will replan after your repair if changed files differ):',
    ...input.verification.checks.map((check, index) =>
      [
        `${index + 1}. ${check.title} [${check.status}${check.required ? ', required' : ''}]`,
        check.command ? `Command: ${check.command}` : '',
        check.cwd ? `Cwd: ${check.cwd}` : '',
        check.target ? `Target: ${check.target}` : '',
        ...formatVerificationArtifactReferences(check.artifacts)
      ].filter(Boolean).join('\n')
    ),
    input.verification.omittedChecks?.length
      ? [
          '',
          'Omitted verification candidates from failed plan:',
          ...input.verification.omittedChecks.map((check, index) =>
            [
              `${index + 1}. ${check.title} [${check.reason}]`,
              check.command ? `Command: ${check.command}` : '',
              check.cwd ? `Cwd: ${check.cwd}` : '',
              check.target ? `Target: ${check.target}` : ''
            ].filter(Boolean).join('\n')
          )
        ].join('\n')
      : '',
    '',
    'Failed checks:',
    ...failedChecks.map((check, index) =>
      [
        `${index + 1}. ${check.title}`,
        check.command ? `Command: ${check.command}` : '',
        check.cwd ? `Cwd: ${check.cwd}` : '',
        check.errorMessage ? ['Output:', check.errorMessage].join('\n') : check.outputPreview ? ['Output:', check.outputPreview].join('\n') : '',
        ...formatVerificationArtifactReferences(check.artifacts)
      ].filter(Boolean).join('\n')
    ),
    input.relatedFiles?.length
      ? [
          '',
          'Relevant files from failed verification:',
          ...input.relatedFiles.map((file) =>
            [
              `[${file.path}${file.line ? `:${file.line}` : ''}] source=${file.source}${file.truncated ? ' truncated' : ''}`,
              file.excerpt
            ].join('\n')
          )
        ].join('\n\n')
      : '',
    '',
    'Repair rules:',
    '- Use project read/edit tools as needed.',
    '- Prefer the smallest change that addresses the failing check.',
    '- Inspect the failure diagnosis, change summary, and relevant files before editing.',
    '- If the change summary shows a wrong direction that cannot be repaired locally, prefer checkpoint_rollback over broad rewrites.',
    '- Do not run the same verification command yourself unless you need extra diagnosis; the host will rerun active verification after this repair pass.',
    '- When finished, reply with what changed and why the verification should pass.'
  ].filter(Boolean).join('\n');
}

export function formatActiveVerificationFailureReply(
  reply: string,
  verification: ActiveVerificationRunResult,
  handoff?: {
    repairAttempted?: boolean;
    changeSummary?: ActiveVerificationChangeSummary;
    rollbackAvailable?: boolean;
  }
): string {
  return [
    '自动验证未通过，本轮不会标记为完成。',
    '',
    reply.trim() ? ['模型已生成的回复：', reply.trim()].join('\n') : '',
    '',
    '验证结果：',
    verification.summary,
    verification.diagnosis
      ? [
        `失败类型：${verification.diagnosis.kind}`,
        `修复焦点：${verification.diagnosis.suggestedFocus}`
      ].join('\n')
      : '',
    handoff?.repairAttempted ? '已执行一次受控修复，但复验仍未通过。' : '',
    handoff?.changeSummary
      ? [
          '',
          `变更摘要（${handoff.changeSummary.source}${handoff.changeSummary.truncated ? '，已截断' : ''}）：`,
          handoff.changeSummary.summary
        ].join('\n')
      : '',
    handoff?.rollbackAvailable
      ? '可回滚：当前运行有 checkpoint，可使用 checkpoint_rollback 恢复本轮文件改动。'
      : '',
    ...verification.checks.map((check) =>
      [
        `- ${check.title}: ${check.status}`,
        check.command ? `  command: ${check.command}` : '',
        check.errorMessage ? `  error: ${check.errorMessage.split('\n')[0]}` : ''
      ].filter(Boolean).join('\n')
    ),
    verification.omittedChecks?.length
      ? [
          '',
          '未执行的验证候选：',
          ...verification.omittedChecks.map((check) =>
            [
              `- ${check.title}: ${check.reason === 'max_checks' ? '因计划上限省略' : '因重复候选省略'}`,
              check.command ? `  command: ${check.command}` : ''
            ].filter(Boolean).join('\n')
          )
        ].join('\n')
      : ''
  ].filter(Boolean).join('\n');
}

const CHECK_COMMAND_TIMEOUT_MS = 120_000;
const MAX_ACTIVE_VERIFICATION_CHECKS = 3;
const MAX_OMITTED_ACTIVE_VERIFICATION_CHECKS = 8;
const MAX_REPAIR_FILE_EVIDENCE = 5;
const MAX_REPAIR_FILE_BYTES = 240_000;
const MAX_REPAIR_SNIPPET_CHARS = 2600;
const MAX_REPAIR_SNIPPET_LINES = 80;
const MAX_REPAIR_CHANGE_SUMMARY_CHARS = 5000;
const SOURCE_EXTENSIONS = new Set([
  'cjs',
  'css',
  'cs',
  'go',
  'html',
  'js',
  'json',
  'jsx',
  'md',
  'mjs',
  'py',
  'rs',
  'scss',
  'svelte',
  'ts',
  'tsx',
  'vue',
  'yaml',
  'yml'
]);

interface PackageScriptCommand {
  name: string;
  command: string;
  source?: string;
  cwd?: string;
  packageManager?: PackageManager;
}

type PackageManager = NonNullable<GenericProjectContextIndex['packageManager']>;

interface ChangedFileClassification {
  changedFiles: string[];
  sourceFiles: string[];
  unitTestFiles: string[];
  e2eTestFiles: string[];
  docsOnly: boolean;
  hasSource: boolean;
  hasJsTs: boolean;
  hasTests: boolean;
  hasE2eTests: boolean;
  hasWebSurface: boolean;
  hasBrowserSurface: boolean;
  hasManifestOrConfig: boolean;
  hasBrowserConfig: boolean;
  hasNativeManifestOrConfig: boolean;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parsePackageManagerSpec(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/i.exec(value.trim());
  const name = match?.[1]?.toLowerCase();
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun'
    ? name
    : undefined;
}

function detectPackageManagerForDirectory(
  rootPath: string,
  packageDir: string,
  declared: PackageManager | undefined,
  fallback: PackageManager | undefined
): PackageManager | undefined {
  if (declared) {
    return declared;
  }
  if (existsSync(resolve(rootPath, packageDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(rootPath, packageDir, 'yarn.lock'))) return 'yarn';
  if (existsSync(resolve(rootPath, packageDir, 'bun.lockb')) || existsSync(resolve(rootPath, packageDir, 'bun.lock'))) return 'bun';
  if (fallback) return fallback;
  if (existsSync(resolve(rootPath, packageDir, 'package-lock.json')) || existsSync(resolve(rootPath, packageDir, 'package.json'))) return 'npm';
  return undefined;
}

function packageManagerRunCommand(packageManager: PackageManager | undefined, scriptName: string, args: string[] = []): string {
  const suffix = args.length ? ` -- ${args.map(shellQuote).join(' ')}` : '';
  if (packageManager === 'pnpm') return `pnpm ${scriptName === 'test' ? 'test' : `run ${scriptName}`}${suffix}`;
  if (packageManager === 'yarn') return `yarn ${scriptName === 'test' ? 'test' : scriptName}${args.length ? ` ${args.map(shellQuote).join(' ')}` : ''}`;
  if (packageManager === 'bun') return `bun run ${scriptName}${suffix}`;
  return `npm ${scriptName === 'test' ? 'test' : `run ${scriptName}`}${suffix}`;
}

function pathForScriptCwd(path: string, cwd: string | undefined): string {
  if (!cwd || cwd === '.') {
    return path;
  }
  const normalizedCwd = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  return path.startsWith(`${normalizedCwd}/`) ? path.slice(normalizedCwd.length + 1) : path;
}

function findScriptCommand(params: GenericAgentRuntimeParams, names: string[]): PackageScriptCommand | undefined {
  const scripts = params.context.projectContextIndex?.scripts ?? [];
  for (const name of names) {
    const exact = scripts.find((script) => script.name === name);
    if (exact) {
      return {
        name: exact.name,
        command: packageManagerRunCommand(params.context.projectContextIndex?.packageManager, exact.name),
        source: exact.source
      };
    }
  }
  return undefined;
}

function findScriptByPattern(
  params: GenericAgentRuntimeParams,
  pattern: RegExp,
  commandPattern?: RegExp,
  excludedNames: Set<string> = new Set()
): PackageScriptCommand | undefined {
  const scripts = params.context.projectContextIndex?.scripts ?? [];
  const match = scripts.find((script) =>
    !excludedNames.has(script.name) &&
    (pattern.test(script.name) || (commandPattern ? commandPattern.test(script.command) : false))
  );
  if (!match) {
    return undefined;
  }
  return {
    name: match.name,
    command: packageManagerRunCommand(params.context.projectContextIndex?.packageManager, match.name),
    source: match.source
  };
}

function readPackageManifest(
  rootPath: string,
  packageDir: string,
  fallbackPackageManager: PackageManager | undefined
): { scripts: Record<string, string>; packageManager?: PackageManager } | undefined {
  const packageJsonPath = resolve(rootPath, packageDir, 'package.json');
  if (!isPathInsideRoot(rootPath, packageJsonPath) || !existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown; packageManager?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
      return undefined;
    }
    const scripts: Record<string, string> = {};
    for (const [name, command] of Object.entries(parsed.scripts)) {
      if (typeof command === 'string') {
        scripts[name] = command;
      }
    }
    return {
      scripts,
      packageManager: detectPackageManagerForDirectory(
        rootPath,
        packageDir,
        parsePackageManagerSpec(parsed.packageManager),
        fallbackPackageManager
      )
    };
  } catch {
    return undefined;
  }
}

function findMatchingPackageScript(
  scripts: Record<string, string>,
  names: string[],
  namePattern?: RegExp,
  commandPattern?: RegExp,
  excludedNames: Set<string> = new Set()
): { name: string; command: string } | undefined {
  for (const name of names) {
    const command = scripts[name];
    if (command && !excludedNames.has(name)) {
      return { name, command };
    }
  }
  if (!namePattern && !commandPattern) {
    return undefined;
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (excludedNames.has(name)) {
      continue;
    }
    if ((namePattern && namePattern.test(name)) || (commandPattern && commandPattern.test(command))) {
      return { name, command };
    }
  }
  return undefined;
}

function findNearestPackageScriptForFile(input: {
  params: GenericAgentRuntimeParams;
  file: string;
  names: string[];
  namePattern?: RegExp;
  commandPattern?: RegExp;
  excludedNames?: Set<string>;
}): PackageScriptCommand | undefined {
  const rootPath = resolveProjectRoot(input.params);
  if (!rootPath) {
    return undefined;
  }
  let directory = directoryPath(input.file);
  while (directory) {
    const manifest = readPackageManifest(rootPath, directory, input.params.context.projectContextIndex?.packageManager);
    const match = manifest
      ? findMatchingPackageScript(manifest.scripts, input.names, input.namePattern, input.commandPattern, input.excludedNames)
      : undefined;
    if (match) {
      return {
        name: match.name,
        command: packageManagerRunCommand(manifest?.packageManager, match.name),
        source: `${directory}/package.json`,
        cwd: directory,
        packageManager: manifest?.packageManager
      };
    }
    directory = directoryPath(directory);
  }
  return undefined;
}

function findNearestPackageScript(
  params: GenericAgentRuntimeParams,
  files: string[],
  names: string[],
  namePattern?: RegExp,
  commandPattern?: RegExp,
  excludedNames: Set<string> = new Set()
): PackageScriptCommand | undefined {
  for (const file of Array.from(new Set(files))) {
    const match = findNearestPackageScriptForFile({
      params,
      file,
      names,
      namePattern,
      commandPattern,
      excludedNames
    });
    if (match) {
      return match;
    }
  }
  return undefined;
}

function createScriptCheck(input: {
  id: string;
  kind: AgentVerificationCheckKind;
  title: string;
  script: {
    name: string;
    command: string;
    source?: string;
    cwd?: string;
  };
}): ActiveVerificationCheckPlan {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    command: input.script.command,
    cwd: input.script.cwd ?? '.',
    target: input.script.source ?? 'package.json',
    required: true
  };
}

function createTargetedScriptCheck(input: {
  id: string;
  kind: AgentVerificationCheckKind;
  title: string;
  script: PackageScriptCommand | undefined;
  packageManager: PackageManager | undefined;
  paths: string[];
}): ActiveVerificationCheckPlan | undefined {
  if (!input.script || input.paths.length === 0) {
    return undefined;
  }
  const paths = input.paths
    .slice(0, 4)
    .map((path) => pathForScriptCwd(path, input.script?.cwd));
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    command: packageManagerRunCommand(input.script.packageManager ?? input.packageManager, input.script.name, paths),
    cwd: input.script.cwd ?? '.',
    target: paths.join(', '),
    required: true
  };
}

function getPreferredScriptChecks(params: GenericAgentRuntimeParams): {
  qualityScript?: PackageScriptCommand;
  typecheckScript?: PackageScriptCommand;
  lintScript?: PackageScriptCommand;
  buildScript?: PackageScriptCommand;
  testScript?: PackageScriptCommand;
  e2eScript?: PackageScriptCommand;
  quality?: ActiveVerificationCheckPlan;
  typecheck?: ActiveVerificationCheckPlan;
  lint?: ActiveVerificationCheckPlan;
  build?: ActiveVerificationCheckPlan;
  test?: ActiveVerificationCheckPlan;
  e2e?: ActiveVerificationCheckPlan;
} {
  const quality =
    findScriptCommand(params, ['check', 'verify', 'validate', 'quality', 'check:ci', 'ci:check', 'test:ci']) ??
    findScriptByPattern(params, /(^|:)(verify|validate|quality)(:|$)|^(check|ci)$/i);
  const qualityScriptNames = quality ? new Set([quality.name]) : new Set<string>();
  const typecheck =
    findScriptCommand(params, ['typecheck', 'check:types', 'type-check']) ??
    findScriptByPattern(params, /(^|:)(typecheck|check:types|type-check)$/i, /\btsc\b.*--noEmit/i, qualityScriptNames);
  const lint =
    findScriptCommand(params, ['lint', 'check:lint']) ??
    findScriptByPattern(params, /(^|:)(lint|eslint)$/i, /\beslint\b/i, qualityScriptNames);
  const build =
    findScriptCommand(params, ['build', 'compile']) ??
    findScriptByPattern(params, /(^|:)(build|compile)$/i, /\b(vite|next|astro|svelte-kit|tsc|webpack|rollup)\b/i, qualityScriptNames);
  const test =
    findScriptCommand(params, ['test', 'test:unit', 'test:runtime']) ??
    findScriptByPattern(params, /(^|:)(test|test:unit|test:runtime|unit)$/i, /\b(vitest|jest|node --test|playwright test)\b/i, qualityScriptNames);
  const e2e =
    findScriptCommand(params, ['test:e2e', 'e2e', 'test:browser', 'test:ui', 'playwright', 'cypress:run']) ??
    findScriptByPattern(params, /(^|:)(e2e|browser|ui|playwright|cypress)(:|$)/i, /\b(playwright test|cypress run)\b/i, qualityScriptNames);

  return {
    qualityScript: quality,
    typecheckScript: typecheck,
    lintScript: lint,
    buildScript: build,
    testScript: test,
    e2eScript: e2e,
    quality: quality ? createScriptCheck({
      id: 'active_verify_quality',
      kind: 'command',
      title: 'Run project quality check',
      script: quality
    }) : undefined,
    typecheck: typecheck ? createScriptCheck({
      id: 'active_verify_typecheck',
      kind: 'build',
      title: 'Run type check',
      script: typecheck
    }) : undefined,
    lint: lint ? createScriptCheck({
      id: 'active_verify_lint',
      kind: 'command',
      title: 'Run lint check',
      script: lint
    }) : undefined,
    build: build ? createScriptCheck({
      id: 'active_verify_build',
      kind: 'build',
      title: 'Run build check',
      script: build
    }) : undefined,
    test: test ? createScriptCheck({
      id: 'active_verify_test',
      kind: 'test',
      title: 'Run automatic tests',
      script: test
    }) : undefined,
    e2e: e2e ? createScriptCheck({
      id: 'active_verify_browser_e2e',
      kind: 'browser',
      title: 'Run browser/e2e verification',
      script: e2e
    }) : undefined
  };
}

function getScopedScriptChecks(params: GenericAgentRuntimeParams, changed: ChangedFileClassification): {
  qualityScript?: PackageScriptCommand;
  typecheckScript?: PackageScriptCommand;
  lintScript?: PackageScriptCommand;
  buildScript?: PackageScriptCommand;
  testScript?: PackageScriptCommand;
  e2eScript?: PackageScriptCommand;
  quality?: ActiveVerificationCheckPlan;
  typecheck?: ActiveVerificationCheckPlan;
  lint?: ActiveVerificationCheckPlan;
  build?: ActiveVerificationCheckPlan;
  test?: ActiveVerificationCheckPlan;
  e2e?: ActiveVerificationCheckPlan;
} {
  const files = [
    ...changed.sourceFiles,
    ...changed.unitTestFiles,
    ...changed.e2eTestFiles
  ];
  const quality =
    findNearestPackageScript(
      params,
      files,
      ['check', 'verify', 'validate', 'quality', 'check:ci', 'ci:check', 'test:ci'],
      /(^|:)(verify|validate|quality)(:|$)|^(check|ci)$/i
    );
  const qualityScriptNames = quality ? new Set([quality.name]) : new Set<string>();
  const typecheck =
    findNearestPackageScript(params, files, ['typecheck', 'check:types', 'type-check'], /(^|:)(typecheck|check:types|type-check)$/i, /\btsc\b.*--noEmit/i, qualityScriptNames);
  const lint =
    findNearestPackageScript(params, files, ['lint', 'check:lint'], /(^|:)(lint|eslint)$/i, /\beslint\b/i, qualityScriptNames);
  const build =
    findNearestPackageScript(params, files, ['build', 'compile'], /(^|:)(build|compile)$/i, /\b(vite|next|astro|svelte-kit|tsc|webpack|rollup)\b/i, qualityScriptNames);
  const test =
    findNearestPackageScript(params, files, ['test', 'test:unit', 'test:runtime'], /(^|:)(test|test:unit|test:runtime|unit)$/i, /\b(vitest|jest|node --test|playwright test)\b/i, qualityScriptNames);
  const e2e =
    findNearestPackageScript(params, files, ['test:e2e', 'e2e', 'test:browser', 'test:ui', 'playwright', 'cypress:run'], /(^|:)(e2e|browser|ui|playwright|cypress)(:|$)/i, /\b(playwright test|cypress run)\b/i, qualityScriptNames);

  return {
    qualityScript: quality,
    typecheckScript: typecheck,
    lintScript: lint,
    buildScript: build,
    testScript: test,
    e2eScript: e2e,
    quality: quality ? createScriptCheck({
      id: 'active_verify_scoped_quality',
      kind: 'command',
      title: 'Run package quality check',
      script: quality
    }) : undefined,
    typecheck: typecheck ? createScriptCheck({
      id: 'active_verify_scoped_typecheck',
      kind: 'build',
      title: 'Run package type check',
      script: typecheck
    }) : undefined,
    lint: lint ? createScriptCheck({
      id: 'active_verify_scoped_lint',
      kind: 'command',
      title: 'Run package lint check',
      script: lint
    }) : undefined,
    build: build ? createScriptCheck({
      id: 'active_verify_scoped_build',
      kind: 'build',
      title: 'Run package build check',
      script: build
    }) : undefined,
    test: test ? createScriptCheck({
      id: 'active_verify_scoped_test',
      kind: 'test',
      title: 'Run package tests',
      script: test
    }) : undefined,
    e2e: e2e ? createScriptCheck({
      id: 'active_verify_scoped_browser_e2e',
      kind: 'browser',
      title: 'Run package browser/e2e verification',
      script: e2e
    }) : undefined
  };
}

function normalizeChangedFilePath(path: string): string | undefined {
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('://') || normalized.split('/').includes('..')) {
    return undefined;
  }
  return normalized;
}

function fileExtension(path: string): string {
  return path.split('.').at(-1)?.toLowerCase() ?? '';
}

function classifyChangedFiles(files: string[] | undefined): ChangedFileClassification {
  const changedFiles = Array.from(new Set((files ?? []).map(normalizeChangedFilePath).filter((file): file is string => Boolean(file))));
  const relevant = changedFiles.filter((file) => !/(^|\/)(node_modules|dist|build|coverage|out|\.git)\//.test(file));
  const docsOnly = relevant.length > 0 && relevant.every((file) => /\.(md|mdx|txt|adoc|rst)$/i.test(file));
  const e2eTestFiles = relevant.filter((file) => /(^|\/)(e2e|playwright|cypress|tests\/e2e)\/|(\.|-)(e2e|browser|ui)\.(test|spec)\.[cm]?[jt]sx?$/i.test(file));
  const unitTestFiles = relevant.filter((file) =>
    e2eTestFiles.includes(file)
      ? false
      : /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.go$/i.test(file)
  );
  const sourceFiles = relevant.filter((file) =>
    !unitTestFiles.includes(file) &&
    !e2eTestFiles.includes(file) &&
    SOURCE_EXTENSIONS.has(fileExtension(file))
  );
  const hasTests = unitTestFiles.length > 0 || e2eTestFiles.length > 0;
  const hasE2eTests = e2eTestFiles.length > 0;
  const hasJsTs = relevant.some((file) => /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/i.test(file));
  const hasSource = relevant.some((file) => SOURCE_EXTENSIONS.has(fileExtension(file)));
  const hasWebSurface = relevant.some((file) => /\.(html|css|scss|tsx?|jsx?|vue|svelte)$/i.test(file));
  const hasBrowserSurface = relevant.some((file) =>
    /\.(html|css|scss|tsx|jsx|vue|svelte)$/i.test(file) ||
    /(^|\/)(app|pages|routes|components|public|styles?)\//i.test(file) ||
    /(^|\/)(App|index|main)\.(tsx|jsx|html)$/i.test(file)
  );
  const hasManifestOrConfig = relevant.some((file) =>
    /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|tsconfig\.json|vite\.config\.[jt]s|next\.config\.[cm]?js|electron\.vite\.config\.[jt]s)$/i.test(file)
  );
  const hasBrowserConfig = relevant.some((file) =>
    /(^|\/)(playwright\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s)$/i.test(file)
  );
  const hasNativeManifestOrConfig = relevant.some((file) =>
    /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py|setup\.cfg|pytest\.ini|tox\.ini|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/i.test(file)
  );
  return {
    changedFiles,
    sourceFiles,
    unitTestFiles,
    e2eTestFiles,
    docsOnly,
    hasSource,
    hasJsTs,
    hasTests,
    hasE2eTests,
    hasWebSurface,
    hasBrowserSurface,
    hasManifestOrConfig,
    hasBrowserConfig,
    hasNativeManifestOrConfig
  };
}

function createFallbackCommandCheck(params: GenericAgentRuntimeParams, trigger: AgentVerificationTrigger): ActiveVerificationCheckPlan {
  const gitCheck = params.context.runtimeEnvironment?.isGitRepository
    ? 'git diff --check'
    : 'node -e "console.log(\'Funplay active verification: no project test/build script discovered\')"';
  return {
    id: trigger === 'active_engine' ? 'active_verify_engine_fallback' : 'active_verify_workspace_fallback',
    kind: 'command',
    title: trigger === 'active_engine' ? 'Run engine change sanity check' : 'Run workspace change sanity check',
    command: gitCheck,
    cwd: '.',
    target: params.context.runtimeEnvironment?.isGitRepository ? 'git diff --check' : 'node',
    required: true
  };
}

function createNativeCommandCheck(input: {
  id: string;
  kind: AgentVerificationCheckKind;
  title: string;
  command: string;
  target: string;
}): ActiveVerificationCheckPlan {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    command: input.command,
    cwd: '.',
    target: input.target,
    required: true
  };
}

function projectHasFile(params: GenericAgentRuntimeParams, changed: ChangedFileClassification, path: string): boolean {
  const normalized = normalizeChangedFilePath(path);
  if (!normalized) {
    return false;
  }
  if (changed.changedFiles.includes(normalized)) {
    return true;
  }
  const index = params.context.projectContextIndex;
  if (
    index?.configFiles.includes(normalized) ||
    index?.manifests.some((manifest) => manifest.path === normalized) ||
    index?.entrypoints.some((entrypoint) => entrypoint.path === normalized)
  ) {
    return true;
  }
  const rootPath = resolveProjectRoot(params);
  return rootPath ? existsSync(resolve(rootPath, normalized)) : false;
}

function projectHasAnyFile(params: GenericAgentRuntimeParams, changed: ChangedFileClassification, paths: string[]): boolean {
  return paths.some((path) => projectHasFile(params, changed, path));
}

function filesWithExtension(files: string[], extension: string): string[] {
  return files.filter((file) => fileExtension(file) === extension);
}

function directoryPath(path: string): string {
  return path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
}

function createPythonCompileCheck(changed: ChangedFileClassification): ActiveVerificationCheckPlan {
  const pythonFiles = filesWithExtension(changed.changedFiles, 'py');
  if (pythonFiles.length > 0 && pythonFiles.length <= 6) {
    return createNativeCommandCheck({
      id: 'active_verify_python_compile',
      kind: 'build',
      title: 'Run Python compile check',
      command: `python -m py_compile ${pythonFiles.map(shellQuote).join(' ')}`,
      target: pythonFiles.join(', ')
    });
  }
  return createNativeCommandCheck({
    id: 'active_verify_python_compileall',
    kind: 'build',
    title: 'Run Python compile check',
    command: 'python -m compileall -q .',
    target: 'Python project'
  });
}

function createPythonTestCheck(input: {
  id: string;
  title: string;
  paths: string[];
}): ActiveVerificationCheckPlan | undefined {
  const pythonTestFiles = filesWithExtension(input.paths, 'py').slice(0, 4);
  if (pythonTestFiles.length === 0) {
    return undefined;
  }
  return createNativeCommandCheck({
    id: input.id,
    kind: 'test',
    title: input.title,
    command: `python -m pytest ${pythonTestFiles.map(shellQuote).join(' ')}`,
    target: pythonTestFiles.join(', ')
  });
}

function createGoPackageTestCheck(input: {
  id: string;
  title: string;
  paths: string[];
}): ActiveVerificationCheckPlan | undefined {
  const goFiles = filesWithExtension(input.paths, 'go');
  if (goFiles.length === 0) {
    return undefined;
  }
  const packageTargets = Array.from(new Set(goFiles.map((file) => {
    const directory = directoryPath(file);
    return directory ? `./${directory}` : '.';
  }))).slice(0, 4);
  return createNativeCommandCheck({
    id: input.id,
    kind: 'test',
    title: input.title,
    command: `go test ${packageTargets.map(shellQuote).join(' ')}`,
    target: packageTargets.join(', ')
  });
}

function getNativeProjectChecks(
  params: GenericAgentRuntimeParams,
  changed: ChangedFileClassification,
  relatedUnitTestFiles: string[] = []
): {
  build?: ActiveVerificationCheckPlan;
  test?: ActiveVerificationCheckPlan;
  targetedTest?: ActiveVerificationCheckPlan;
  relatedTest?: ActiveVerificationCheckPlan;
} {
  const checks: {
    build?: ActiveVerificationCheckPlan;
    test?: ActiveVerificationCheckPlan;
    targetedTest?: ActiveVerificationCheckPlan;
    relatedTest?: ActiveVerificationCheckPlan;
  } = {};
  const hasPython =
    changed.changedFiles.some((file) => fileExtension(file) === 'py') ||
    projectHasAnyFile(params, changed, ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini']);
  if (hasPython) {
    checks.build = createPythonCompileCheck(changed);
    checks.targetedTest = createPythonTestCheck({
      id: 'active_verify_python_targeted_test',
      title: 'Run targeted Python tests',
      paths: changed.unitTestFiles
    });
    checks.relatedTest = createPythonTestCheck({
      id: 'active_verify_python_related_test',
      title: 'Run related Python tests',
      paths: relatedUnitTestFiles
    });
  }

  const hasGo =
    changed.changedFiles.some((file) => fileExtension(file) === 'go') ||
    projectHasAnyFile(params, changed, ['go.mod']);
  if (hasGo) {
    checks.targetedTest = createGoPackageTestCheck({
      id: 'active_verify_go_targeted_test',
      title: 'Run targeted Go tests',
      paths: changed.unitTestFiles
    }) ?? checks.targetedTest;
    checks.relatedTest = createGoPackageTestCheck({
      id: 'active_verify_go_related_test',
      title: 'Run related Go tests',
      paths: relatedUnitTestFiles
    }) ?? checks.relatedTest;
    checks.test = createNativeCommandCheck({
      id: 'active_verify_go_test',
      kind: 'test',
      title: 'Run Go tests',
      command: 'go test ./...',
      target: 'Go module'
    });
  }

  const hasRust =
    changed.changedFiles.some((file) => fileExtension(file) === 'rs') ||
    projectHasAnyFile(params, changed, ['Cargo.toml']);
  if (hasRust) {
    checks.test = createNativeCommandCheck({
      id: 'active_verify_rust_test',
      kind: 'test',
      title: 'Run Rust tests',
      command: 'cargo test',
      target: 'Cargo project'
    });
  }

  return checks;
}

function stripSourceExtension(path: string): string {
  return path.replace(/\.[^.\/]+$/, '');
}

function sourceTestPathCandidates(sourceFile: string): string[] {
  const normalized = sourceFile.replaceAll('\\', '/');
  const withoutExtension = stripSourceExtension(normalized);
  const fileName = withoutExtension.split('/').at(-1) ?? withoutExtension;
  const extension = fileExtension(normalized);
  const directory = directoryPath(withoutExtension);
  const relativeWithoutSourceRoot = withoutExtension.replace(/^(src|app|lib|packages\/[^/]+\/src)\//, '');
  const relativeDirectory = directoryPath(relativeWithoutSourceRoot);

  if (extension === 'py') {
    const pythonBases = [
      directory ? `${directory}/test_${fileName}` : `test_${fileName}`,
      directory ? `${directory}/${fileName}_test` : `${fileName}_test`,
      directory ? `${directory}/tests/test_${fileName}` : `tests/test_${fileName}`,
      directory ? `${directory}/__tests__/test_${fileName}` : `__tests__/test_${fileName}`,
      relativeDirectory ? `tests/${relativeDirectory}/test_${fileName}` : `tests/test_${fileName}`,
      relativeDirectory ? `test/${relativeDirectory}/test_${fileName}` : `test/test_${fileName}`
    ];
    return Array.from(new Set(pythonBases.map((base) => `${base}.py`)));
  }

  if (extension === 'go') {
    return [`${withoutExtension}_test.go`];
  }

  const testExtensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
  const suffixes = ['test', 'spec'];
  const bases = [
    withoutExtension,
    directory ? `${directory}/__tests__/${fileName}` : `__tests__/${fileName}`,
    `tests/${relativeWithoutSourceRoot}`,
    `test/${relativeWithoutSourceRoot}`,
    `tests/runtime/${fileName}`,
    `tests/unit/${fileName}`
  ];

  const candidates: string[] = [];
  for (const base of bases) {
    for (const suffix of suffixes) {
      for (const extension of testExtensions) {
        candidates.push(`${base}.${suffix}.${extension}`);
      }
    }
  }
  return Array.from(new Set(candidates));
}

function collectRelatedUnitTestFiles(params: GenericAgentRuntimeParams, sourceFiles: string[]): string[] {
  const rootPath = resolveProjectRoot(params);
  if (!rootPath || sourceFiles.length === 0) {
    return [];
  }
  const found: string[] = [];
  for (const sourceFile of sourceFiles) {
    for (const candidate of sourceTestPathCandidates(sourceFile)) {
      if (found.includes(candidate)) {
        continue;
      }
      const absolutePath = resolve(rootPath, candidate);
      if (!isPathInsideRoot(rootPath, absolutePath) || !existsSync(absolutePath)) {
        continue;
      }
      try {
        if (statSync(absolutePath).isFile()) {
          found.push(candidate);
        }
      } catch {
        // Ignore unreadable candidates; the broad verification checks can still run.
      }
      if (found.length >= 4) {
        return found;
      }
    }
  }
  return found;
}

interface ActiveVerificationCheckSelection {
  checks: ActiveVerificationCheckPlan[];
  omittedChecks: ActiveVerificationOmittedCheck[];
}

function pushOmittedCheck(
  selection: ActiveVerificationCheckSelection,
  check: ActiveVerificationCheckPlan,
  reason: ActiveVerificationOmittedCheck['reason']
): void {
  if (selection.omittedChecks.length >= MAX_OMITTED_ACTIVE_VERIFICATION_CHECKS) {
    return;
  }
  const key = check.command ?? check.id;
  if (selection.omittedChecks.some((existing) => existing.reason === reason && (existing.command ?? existing.id) === key)) {
    return;
  }
  selection.omittedChecks.push({
    id: check.id,
    kind: check.kind,
    title: check.title,
    command: check.command,
    cwd: check.cwd,
    target: check.target,
    required: check.required,
    reason
  });
}

function pushUniqueCheck(selection: ActiveVerificationCheckSelection, check: ActiveVerificationCheckPlan | undefined): void {
  if (!check) {
    return;
  }
  const key = check.command ?? check.id;
  if (selection.checks.some((existing) => (existing.command ?? existing.id) === key)) {
    pushOmittedCheck(selection, check, 'duplicate');
    return;
  }
  if (selection.checks.length >= MAX_ACTIVE_VERIFICATION_CHECKS) {
    pushOmittedCheck(selection, check, 'max_checks');
    return;
  }
  selection.checks.push(check);
}

function selectCommandChecks(
  params: GenericAgentRuntimeParams,
  trigger: AgentVerificationTrigger,
  evidence?: ActiveVerificationPlanningEvidence
): ActiveVerificationCheckSelection {
  const preferred = getPreferredScriptChecks(params);
  const changed = classifyChangedFiles(evidence?.changedFiles);
  const scoped = getScopedScriptChecks(params, changed);
  const selected = {
    qualityScript: scoped.qualityScript ?? preferred.qualityScript,
    typecheckScript: scoped.typecheckScript ?? preferred.typecheckScript,
    lintScript: scoped.lintScript ?? preferred.lintScript,
    buildScript: scoped.buildScript ?? preferred.buildScript,
    testScript: scoped.testScript ?? preferred.testScript,
    e2eScript: scoped.e2eScript ?? preferred.e2eScript,
    quality: scoped.quality ?? preferred.quality,
    typecheck: scoped.typecheck ?? preferred.typecheck,
    lint: scoped.lint ?? preferred.lint,
    build: scoped.build ?? preferred.build,
    test: scoped.test ?? preferred.test,
    e2e: scoped.e2e ?? preferred.e2e
  };
  const relatedUnitTestFiles = collectRelatedUnitTestFiles(params, changed.sourceFiles);
  const native = getNativeProjectChecks(params, changed, relatedUnitTestFiles);
  const selection: ActiveVerificationCheckSelection = {
    checks: [],
    omittedChecks: []
  };

  if (changed.docsOnly) {
    pushUniqueCheck(selection, createFallbackCommandCheck(params, trigger));
    return selection;
  }

  if (trigger === 'active_engine') {
    pushUniqueCheck(selection, selected.build);
    pushUniqueCheck(selection, selected.test);
    pushUniqueCheck(selection, selected.e2e);
    pushUniqueCheck(selection, selected.quality);
    pushUniqueCheck(selection, createFallbackCommandCheck(params, trigger));
    return selection;
  }

  if (changed.hasE2eTests) {
    pushUniqueCheck(selection, createTargetedScriptCheck({
      id: 'active_verify_targeted_browser_e2e',
      kind: 'browser',
      title: 'Run targeted browser/e2e verification',
      script: selected.e2eScript,
      packageManager: params.context.projectContextIndex?.packageManager,
      paths: changed.e2eTestFiles
    }) ?? selected.e2e);
    pushUniqueCheck(selection, selected.typecheck);
    pushUniqueCheck(selection, selected.test);
    pushUniqueCheck(selection, selected.quality);
  } else if (changed.hasTests) {
    pushUniqueCheck(selection, createTargetedScriptCheck({
      id: 'active_verify_targeted_test',
      kind: 'test',
      title: 'Run targeted tests',
      script: selected.testScript,
      packageManager: params.context.projectContextIndex?.packageManager,
      paths: changed.unitTestFiles
    }) ?? native.targetedTest ?? selected.test);
    pushUniqueCheck(selection, selected.typecheck ?? native.build);
    pushUniqueCheck(selection, native.test);
    pushUniqueCheck(selection, selected.build);
    pushUniqueCheck(selection, selected.quality);
  } else if (changed.hasJsTs || changed.hasManifestOrConfig) {
    const hasBrowserVerificationSurface = changed.hasBrowserSurface || changed.hasBrowserConfig;
    pushUniqueCheck(selection, selected.typecheck);
    if (!selected.typecheck && changed.hasWebSurface) {
      pushUniqueCheck(selection, selected.build);
    }
    pushUniqueCheck(selection, createTargetedScriptCheck({
      id: 'active_verify_related_test',
      kind: 'test',
      title: 'Run related tests',
      script: selected.testScript,
      packageManager: params.context.projectContextIndex?.packageManager,
      paths: relatedUnitTestFiles
    }) ?? selected.test);
    if (hasBrowserVerificationSurface && relatedUnitTestFiles.length > 0) {
      pushUniqueCheck(selection, selected.e2e);
    }
    if (relatedUnitTestFiles.length > 0) {
      pushUniqueCheck(selection, selected.test);
    }
    if (hasBrowserVerificationSurface && relatedUnitTestFiles.length === 0) {
      pushUniqueCheck(selection, selected.e2e);
    }
    pushUniqueCheck(selection, selected.lint);
    pushUniqueCheck(selection, selected.quality);
  } else if (changed.hasWebSurface) {
    pushUniqueCheck(selection, selected.build);
    pushUniqueCheck(selection, selected.e2e);
    pushUniqueCheck(selection, selected.test);
    pushUniqueCheck(selection, selected.quality);
  } else if (changed.hasSource || changed.hasNativeManifestOrConfig || changed.changedFiles.length === 0) {
    pushUniqueCheck(selection, native.build);
    pushUniqueCheck(selection, native.relatedTest);
    pushUniqueCheck(selection, native.test);
    pushUniqueCheck(selection, selected.test);
    pushUniqueCheck(selection, selected.build);
    pushUniqueCheck(selection, selected.lint);
    pushUniqueCheck(selection, selected.quality);
  }

  if (selection.checks.length === 0) {
    pushUniqueCheck(selection, native.build);
    pushUniqueCheck(selection, native.test);
    pushUniqueCheck(selection, selected.test);
    pushUniqueCheck(selection, selected.build);
    pushUniqueCheck(selection, selected.lint);
    pushUniqueCheck(selection, selected.quality);
  }
  if (selection.checks.length === 0) {
    pushUniqueCheck(selection, createFallbackCommandCheck(params, trigger));
  }
  return selection;
}

export function planActiveVerification(
  params: GenericAgentRuntimeParams,
  trigger: AgentVerificationTrigger | undefined,
  evidence?: ActiveVerificationPlanningEvidence
): ActiveVerificationPlan | undefined {
  if (!trigger || (trigger !== 'active_write' && trigger !== 'active_engine')) {
    return undefined;
  }
  const selection = selectCommandChecks(params, trigger, evidence);
  return {
    trigger,
    blocking: true,
    checks: selection.checks,
    omittedChecks: selection.omittedChecks.length ? selection.omittedChecks : undefined,
    sideEffects: evidence?.sideEffects?.length ? evidence.sideEffects : undefined
  };
}

function resolveProjectRoot(params: GenericAgentRuntimeParams): string | undefined {
  const root = params.context.projectPath ?? params.project.engine?.projectPath;
  return root ? resolve(root) : undefined;
}

function isPathInsideRoot(rootPath: string, absolutePath: string): boolean {
  return absolutePath === rootPath || absolutePath.startsWith(`${rootPath}/`);
}

function normalizeRepairEvidencePath(rootPath: string, token: string): { path: string; absolutePath: string } | undefined {
  const cleaned = token
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/^[@'"`({\[<]+|['"`)}\]>,.;]+$/g, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  if (!cleaned || cleaned.includes('://')) {
    return undefined;
  }
  const absolutePath = cleaned.startsWith('/') ? resolve(cleaned) : resolve(rootPath, cleaned);
  if (!isPathInsideRoot(rootPath, absolutePath)) {
    return undefined;
  }
  const path = relative(rootPath, absolutePath).replaceAll('\\', '/');
  if (!path || path.startsWith('..') || /(^|\/)(node_modules|dist|build|coverage|out|\.git)\//.test(path)) {
    return undefined;
  }
  if (!SOURCE_EXTENSIONS.has(fileExtension(path))) {
    return undefined;
  }
  return { path, absolutePath };
}

function extractVerificationPathReferences(rootPath: string, text: string): Array<{ path: string; absolutePath: string; line?: number }> {
  const references: Array<{ path: string; absolutePath: string; line?: number }> = [];
  const seen = new Set<string>();
  const pattern = /((?:\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?::(\d+)(?::\d+)?)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && references.length < MAX_REPAIR_FILE_EVIDENCE * 3) {
    const normalized = normalizeRepairEvidencePath(rootPath, match[1] ?? '');
    if (!normalized) {
      continue;
    }
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
    const key = `${normalized.path}:${line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push({ ...normalized, line: Number.isFinite(line) ? line : undefined });
  }
  return references;
}

function readRepairFileExcerpt(absolutePath: string, line?: number): { excerpt?: string; truncated?: boolean } {
  try {
    const fileStat = statSync(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_REPAIR_FILE_BYTES) {
      return {};
    }
    const raw = readFileSync(absolutePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const startIndex = line ? Math.max(0, line - 8) : 0;
    const endIndex = line ? Math.min(lines.length, line + 7) : Math.min(lines.length, MAX_REPAIR_SNIPPET_LINES);
    const excerpt = lines
      .slice(startIndex, endIndex)
      .map((value, index) => `${startIndex + index + 1}: ${value}`)
      .join('\n');
    if (excerpt.length <= MAX_REPAIR_SNIPPET_CHARS) {
      return {
        excerpt,
        truncated: endIndex < lines.length
      };
    }
    return {
      excerpt: `${excerpt.slice(0, MAX_REPAIR_SNIPPET_CHARS - 1)}…`,
      truncated: true
    };
  } catch {
    return {};
  }
}

export function collectActiveVerificationRepairEvidence(
  params: GenericAgentRuntimeParams,
  verification: ActiveVerificationRunResult,
  planningEvidence: ActiveVerificationPlanningEvidence = {}
): ActiveVerificationRepairFileEvidence[] {
  const rootPath = resolveProjectRoot(params);
  if (!rootPath || !existsSync(rootPath)) {
    return [];
  }

  const candidates: Array<{
    path: string;
    absolutePath: string;
    line?: number;
    source: ActiveVerificationRepairFileEvidence['source'];
  }> = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: {
    path: string;
    absolutePath: string;
    line?: number;
    source: ActiveVerificationRepairFileEvidence['source'];
  }): void => {
    const key = `${candidate.path}:${candidate.line ?? ''}`;
    if (seen.has(key) || candidates.length >= MAX_REPAIR_FILE_EVIDENCE * 2) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  for (const file of planningEvidence.changedFiles ?? []) {
    const normalized = normalizeRepairEvidencePath(rootPath, file);
    if (normalized) {
      pushCandidate({ ...normalized, source: 'changed_file' });
    }
  }

  for (const reference of verification.diagnosis?.references ?? []) {
    const normalized = normalizeRepairEvidencePath(rootPath, reference.path);
    if (normalized) {
      pushCandidate({ ...normalized, line: reference.line, source: 'verification_output' });
    }
  }

  for (const check of verification.checks.filter((candidate) => candidate.status === 'failed')) {
    const output = [
      check.errorMessage,
      check.outputPreview,
      check.commandResult?.stdout,
      check.commandResult?.stderr
    ].filter(Boolean).join('\n');
    for (const reference of extractVerificationPathReferences(rootPath, output)) {
      pushCandidate({ ...reference, source: 'verification_output' });
    }
  }

  return candidates
    .map((candidate): ActiveVerificationRepairFileEvidence | undefined => {
      const excerpt = readRepairFileExcerpt(candidate.absolutePath, candidate.line);
      if (!excerpt.excerpt) {
        return undefined;
      }
      const evidence: ActiveVerificationRepairFileEvidence = {
        path: candidate.path,
        source: candidate.source,
        excerpt: excerpt.excerpt
      };
      if (candidate.line !== undefined) {
        evidence.line = candidate.line;
      }
      if (excerpt.truncated !== undefined) {
        evidence.truncated = excerpt.truncated;
      }
      return evidence;
    })
    .filter((item): item is ActiveVerificationRepairFileEvidence => Boolean(item))
    .slice(0, MAX_REPAIR_FILE_EVIDENCE);
}

function compactVerificationOutput(value: string, maxChars = 2400): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function summarizeVerificationResults(results: ActiveVerificationCheckResult[]): string {
  if (results.length === 0) {
    return 'No active verification checks were planned.';
  }
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  return `Active verification: ${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}.`;
}

function formatActiveVerificationPlanMetadata(plan: ActiveVerificationPlan): string {
  return `Plan metadata: ${JSON.stringify({
    plannedChecks: plan.checks.map((check) => ({
      id: check.id,
      kind: check.kind,
      title: check.title,
      command: check.command,
      cwd: check.cwd,
      target: check.target,
      required: check.required
    })),
    omittedChecks: (plan.omittedChecks ?? []).map((check) => ({
      id: check.id,
      kind: check.kind,
      title: check.title,
      command: check.command,
      cwd: check.cwd,
      target: check.target,
      required: check.required,
      reason: check.reason
    })),
    sideEffects: (plan.sideEffects ?? []).map((item) => ({
      toolName: item.toolName,
      kind: item.kind,
      confidence: item.confidence,
      verificationTrigger: item.verificationTrigger,
      evidence: item.evidence
    }))
  })}`;
}

function compactRepairChangeSummary(value: string): { summary: string; truncated?: boolean } {
  if (value.length <= MAX_REPAIR_CHANGE_SUMMARY_CHARS) {
    return { summary: value };
  }
  return {
    summary: `${value.slice(0, MAX_REPAIR_CHANGE_SUMMARY_CHARS - 1)}…`,
    truncated: true
  };
}

function normalizeDiagnosticReferencePath(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/^[@'"`({\[<]+|['"`)}\]>,.;]+$/g, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  if (!cleaned || cleaned.includes('://') || cleaned.split('/').includes('..')) {
    return undefined;
  }
  if (/(^|\/)(node_modules|dist|build|coverage|out|\.git)\//.test(cleaned)) {
    return undefined;
  }
  if (!SOURCE_EXTENSIONS.has(fileExtension(cleaned))) {
    return undefined;
  }
  return cleaned;
}

function extractDiagnosticReferences(text: string): AgentVerificationFailureReference[] {
  const references: AgentVerificationFailureReference[] = [];
  const seen = new Set<string>();
  const pushReference = (value: string, lineValue?: string, columnValue?: string): void => {
    if (references.length >= 8) {
      return;
    }
    const path = normalizeDiagnosticReferencePath(value);
    if (!path) {
      return;
    }
    const line = lineValue ? Number.parseInt(lineValue, 10) : undefined;
    const column = columnValue ? Number.parseInt(columnValue, 10) : undefined;
    const reference: AgentVerificationFailureReference = { path };
    if (Number.isFinite(line)) {
      reference.line = line;
    }
    if (Number.isFinite(column)) {
      reference.column = column;
    }
    const key = `${reference.path}:${reference.line ?? ''}:${reference.column ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    references.push(reference);
  };

  let match: RegExpExecArray | null;
  const pythonTracebackPattern = /File\s+["']([^"']+\.[A-Za-z0-9]{1,12})["'],\s+line\s+(\d+)/g;
  while ((match = pythonTracebackPattern.exec(text)) && references.length < 8) {
    pushReference(match[1] ?? '', match[2]);
  }

  const pathPattern = /((?:file:\/\/)?(?:\/|\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?::(\d+)(?::(\d+))?)?/g;
  while ((match = pathPattern.exec(text)) && references.length < 8) {
    pushReference(match[1] ?? '', match[2], match[3]);
  }

  return references;
}

function formatFailureReference(reference: AgentVerificationFailureReference): string {
  return [
    reference.path,
    reference.line !== undefined ? reference.line : undefined,
    reference.column !== undefined ? reference.column : undefined
  ].filter((part): part is string | number => part !== undefined).join(':');
}

function collectFailureEvidenceLines(text: string, patterns: RegExp[]): string[] {
  const evidence: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 280) {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(trimmed)) && !evidence.includes(trimmed)) {
      evidence.push(trimmed);
    }
    if (evidence.length >= 5) {
      break;
    }
  }
  return evidence;
}

function makeFailureDiagnosis(input: {
  kind: ActiveVerificationFailureKind;
  check: ActiveVerificationCheckResult;
  text: string;
  patterns: RegExp[];
  suggestedFocus: string;
}): ActiveVerificationFailureDiagnosis {
  const commandEvidence = input.check.command ? [`command=${input.check.command}`] : [];
  const lineEvidence = collectFailureEvidenceLines(input.text, input.patterns);
  const references = extractDiagnosticReferences(input.text);
  const diagnosis: ActiveVerificationFailureDiagnosis = {
    kind: input.kind,
    summary: `${input.kind} in ${input.check.title}`,
    evidence: [...commandEvidence, ...lineEvidence].slice(0, 6),
    suggestedFocus: input.suggestedFocus
  };
  if (references.length > 0) {
    diagnosis.references = references;
  }
  return diagnosis;
}

export function diagnoseActiveVerificationFailure(results: ActiveVerificationCheckResult[]): ActiveVerificationFailureDiagnosis | undefined {
  const failedChecks = results.filter((check) => check.status === 'failed');
  if (failedChecks.length === 0) {
    return undefined;
  }

  for (const check of failedChecks) {
    const text = [
      check.errorMessage,
      check.outputPreview,
      check.commandResult?.stdout,
      check.commandResult?.stderr
    ].filter(Boolean).join('\n');
    const command = check.command ?? '';
    if (check.commandResult?.timedOut || /timed out|timeout|SIGTERM/i.test(text)) {
      return makeFailureDiagnosis({
        kind: 'timeout',
        check,
        text,
        patterns: [/timed out|timeout|SIGTERM/i],
        suggestedFocus: 'Identify the slow or hanging verification path before editing; prefer a smaller targeted check for diagnosis.'
      });
    }
    if (
      /missing script|command not found|not found:|(?:command|executable|script)\s+.+not found|ENOENT|could not determine executable/i.test(text) ||
      (/\bpython\b.*\bpytest\b/i.test(command) && /No module named ['"]?pytest['"]?/i.test(text)) ||
      /Cannot find module ['"][^'"]*(vitest|jest|playwright|eslint)[^'"]*['"]|No module named ['"]?(vitest|jest|playwright|eslint)['"]?/i.test(text)
    ) {
      return makeFailureDiagnosis({
        kind: 'missing_command',
        check,
        text,
        patterns: [
          /missing script|command not found|not found:|(?:command|executable|script)\s+.+not found|ENOENT|could not determine executable/i,
          /No module named ['"]?pytest['"]?|Cannot find module ['"][^'"]*(vitest|jest|playwright|eslint)[^'"]*['"]/i
        ],
        suggestedFocus: 'Fix the verification runner, dependency, or project script before touching product code.'
      });
    }
    if (/\bTS\d{4}:|Type '.+' is not assignable|Property '.+' does not exist|Cannot find name '.+'|tsc\b/i.test(text)) {
      return makeFailureDiagnosis({
        kind: 'type_error',
        check,
        text,
        patterns: [/\bTS\d{4}:|Type '.+' is not assignable|Property '.+' does not exist|Cannot find name '.+'|tsc\b/i],
        suggestedFocus: 'Repair type contracts, imports, or changed API shapes near the referenced files.'
      });
    }
    if (/eslint|prettier|no-unused-vars|no-undef|Parsing error|lint/i.test(text) || /\blint\b/i.test(command)) {
      return makeFailureDiagnosis({
        kind: 'lint_error',
        check,
        text,
        patterns: [/eslint|prettier|no-unused-vars|no-undef|Parsing error|lint/i],
        suggestedFocus: 'Apply the smallest formatting, import, or lint-rule fix without changing behavior.'
      });
    }
    if (
      /\bpython\b.*\b(py_compile|compileall)\b/i.test(command) ||
      /SyntaxError|IndentationError|TabError|ModuleNotFoundError|ImportError/i.test(text)
    ) {
      return makeFailureDiagnosis({
        kind: 'build_error',
        check,
        text,
        patterns: [/SyntaxError|IndentationError|TabError|ModuleNotFoundError|ImportError|File\s+["'].+\.py["'],\s+line\s+\d+/i],
        suggestedFocus: 'Fix the Python syntax, import, or module initialization error at the referenced file and line.'
      });
    }
    if (
      /\bgo test\b/i.test(command) &&
      /\.go:\d+:\d+:\s*(undefined:|cannot use|syntax error|expected|imported and not used|not enough arguments|too many arguments|assignment mismatch)/i.test(text)
    ) {
      return makeFailureDiagnosis({
        kind: 'build_error',
        check,
        text,
        patterns: [/\.go:\d+:\d+:\s*(undefined:|cannot use|syntax error|expected|imported and not used|not enough arguments|too many arguments|assignment mismatch)/i],
        suggestedFocus: 'Repair the Go compile error in the referenced package before treating this as a failing assertion.'
      });
    }
    if (
      /\bcargo test\b/i.test(command) &&
      /error(?:\[[A-Z]\d+\])?:|^\s*-->\s+.+\.rs:\d+:\d+/im.test(text) &&
      !/thread '.+' panicked at/i.test(text)
    ) {
      return makeFailureDiagnosis({
        kind: 'build_error',
        check,
        text,
        patterns: [/error(?:\[[A-Z]\d+\])?:|^\s*-->\s+.+\.rs:\d+:\d+/im],
        suggestedFocus: 'Repair the Rust compile error at the referenced file before treating this as a failing assertion.'
      });
    }
    if (
      check.kind === 'test' ||
      /\b(test|vitest|jest|node --test|playwright test)\b/i.test(command) ||
      /AssertionError|assert\b|expected|Expected|Received|FAIL|FAILED|failing|not equal|strictEqual|deepEqual|panicked at/i.test(text)
    ) {
      return makeFailureDiagnosis({
        kind: 'test_assertion',
        check,
        text,
        patterns: [/AssertionError|assert\b|expected|Expected|Received|FAIL|FAILED|failing|not equal|strictEqual|deepEqual|panicked at/i],
        suggestedFocus: 'Use the failing assertion and referenced files to repair behavior, not the test, unless the test is clearly stale.'
      });
    }
    if (check.kind === 'build' || /\b(build|compile|vite|webpack|rollup)\b/i.test(command)) {
      return makeFailureDiagnosis({
        kind: 'build_error',
        check,
        text,
        patterns: [/error|failed|Cannot|SyntaxError|Module not found|Could not resolve/i],
        suggestedFocus: 'Repair compile, bundling, import, or asset resolution errors introduced by the latest changes.'
      });
    }
    if (/ReferenceError|TypeError|SyntaxError|RangeError|Unhandled|Exception|ERR_[A-Z_]+/i.test(text)) {
      return makeFailureDiagnosis({
        kind: 'runtime_error',
        check,
        text,
        patterns: [/ReferenceError|TypeError|SyntaxError|RangeError|Unhandled|Exception|ERR_[A-Z_]+/i],
        suggestedFocus: 'Trace the runtime exception to the changed code path and patch the minimal guard or logic bug.'
      });
    }
  }

  return makeFailureDiagnosis({
    kind: 'unknown',
    check: failedChecks[0],
    text: [
      failedChecks[0].errorMessage,
      failedChecks[0].outputPreview
    ].filter(Boolean).join('\n'),
    patterns: [/./],
    suggestedFocus: 'Inspect the failing command output and changed files before choosing a minimal repair.'
  });
}

export async function collectActiveVerificationChangeSummary(
  params: GenericAgentRuntimeParams,
  planningEvidence: ActiveVerificationPlanningEvidence = {}
): Promise<ActiveVerificationChangeSummary | undefined> {
  if (params.checkpointSnapshotId) {
    try {
      const result = await executeAgentToolAction(params.project, { type: 'checkpoint_diff' }, {
        plugins: params.plugins,
        appState: params.appState,
        persistAppState: params.persistAppState,
        checkpointSnapshotId: params.checkpointSnapshotId,
        abortSignal: params.abortSignal
      });
      if (result.ok && result.summary.trim()) {
        return {
          source: 'checkpoint_diff',
          ...compactRepairChangeSummary(result.summary)
        };
      }
    } catch {
      // Fall back to changed-file metadata below; repair should not fail only because diff capture failed.
    }
  }

  const changedFiles = Array.from(new Set((planningEvidence.changedFiles ?? []).map(normalizeChangedFilePath).filter((file): file is string => Boolean(file))));
  if (changedFiles.length === 0) {
    return undefined;
  }
  return {
    source: 'changed_files',
    summary: [
      'Changed files recorded during this run:',
      ...changedFiles.slice(0, 40).map((file) => `- ${file}`),
      changedFiles.length > 40 ? `- ... ${changedFiles.length - 40} more` : ''
    ].filter(Boolean).join('\n'),
    truncated: changedFiles.length > 40 || undefined
  };
}

export async function runActiveVerificationGate(input: {
  params: GenericAgentRuntimeParams;
  plan: ActiveVerificationPlan;
  emitStage: (stage: ConversationOperationStageEvent) => void;
  emitToolUse: NonNullable<GenericAgentRuntimeParams['onToolUse']>;
  emitToolResult: NonNullable<GenericAgentRuntimeParams['onToolResult']>;
}): Promise<ActiveVerificationRunResult> {
  const results: ActiveVerificationCheckResult[] = [];
  const omittedCheckCount = input.plan.omittedChecks?.length ?? 0;
  input.emitStage({
    stageId: 'stage:native_active_verification',
    phase: 'verification',
    title: 'Run active verification',
    target: input.plan.trigger,
    status: 'running',
    summary: `Planned ${input.plan.checks.length} blocking verification check(s)${omittedCheckCount ? `; omitted ${omittedCheckCount} candidate check(s).` : '.'}`,
    input: {
      trigger: input.plan.trigger,
      blocking: input.plan.blocking,
      plannedChecks: input.plan.checks,
      omittedChecks: input.plan.omittedChecks,
      sideEffects: input.plan.sideEffects
    }
  });

  for (const check of input.plan.checks) {
    const toolUseId = makeId('verify_tool');
    input.emitStage({
      stageId: `stage:native_active_verification:${check.id}`,
      phase: 'verification',
      title: check.title,
      target: check.command ?? check.target ?? check.id,
      status: 'running',
      summary: `Active verification check started: ${check.command ?? check.target ?? check.id}`,
      input: {
        trigger: input.plan.trigger,
        blocking: input.plan.blocking,
        plannedCheck: check
      }
    });
    input.emitToolUse({
      toolUseId,
      name: 'run_command',
      input: {
        command: check.command,
        cwd: check.cwd,
        reason: 'Funplay active verification gate'
      },
      status: 'running'
    });

    let actionResult: WorkspaceToolActionResult;
    if (check.command) {
      actionResult = await executeAgentToolAction(input.params.project, {
        type: 'run_command',
        command: check.command,
        cwd: check.cwd,
        timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
        reason: 'Funplay active verification gate'
      }, {
        plugins: input.params.plugins,
        appState: input.params.appState,
        persistAppState: input.params.persistAppState,
        checkpointSnapshotId: input.params.checkpointSnapshotId,
        abortSignal: input.params.abortSignal
      });
    } else {
      actionResult = {
        ok: false,
        isError: true,
        summary: `Active verification check has no executable command: ${check.id}`
      };
    }

    const status = actionResult.ok && !actionResult.isError ? 'passed' : 'failed';
    const checkResult: ActiveVerificationCheckResult = {
      ...check,
      status,
      outputPreview: compactVerificationOutput(actionResult.summary),
      errorMessage: status === 'failed' ? actionResult.summary : undefined,
      commandResult: actionResult.command,
      artifacts: actionResult.artifacts
    };
    const checkDiagnosis = status === 'failed' ? diagnoseActiveVerificationFailure([checkResult]) : undefined;
    const content = [
      '[Active verification]',
      `Trigger: ${input.plan.trigger}`,
      `Blocking: ${input.plan.blocking ? 'yes' : 'no'}`,
      formatActiveVerificationPlanMetadata(input.plan),
      `Check: ${check.title}`,
      checkDiagnosis
        ? [
            `Diagnosis: ${checkDiagnosis.kind}`,
            `Suggested focus: ${checkDiagnosis.suggestedFocus}`,
            ...checkDiagnosis.evidence.map((item) => `Diagnosis evidence: ${item}`),
            ...(checkDiagnosis.references ?? []).map((item) => `Diagnosis reference: ${formatFailureReference(item)}`)
          ].join('\n')
        : '',
      '',
      actionResult.summary
    ].filter(Boolean).join('\n');
    input.emitToolResult({
      toolUseId,
      toolName: 'run_command',
      content,
      isError: status === 'failed',
      command: actionResult.command,
      terminal: actionResult.terminal,
      artifacts: actionResult.artifacts
    });
    input.emitToolUse({
      toolUseId,
      name: 'run_command',
      input: undefined,
      status: status === 'passed' ? 'completed' : 'failed'
    });
    input.emitStage({
      stageId: `stage:native_active_verification:${check.id}`,
      phase: 'verification',
      title: check.title,
      target: check.command ?? check.target ?? check.id,
      status: status === 'passed' ? 'completed' : 'failed',
      summary: compactVerificationOutput(actionResult.summary),
      errorMessage: status === 'failed' ? actionResult.summary : undefined,
      input: {
        trigger: input.plan.trigger,
        blocking: input.plan.blocking,
        plannedCheck: check
      }
    });
    results.push(checkResult);
  }

  const status = results.length === 0
    ? 'skipped'
    : results.some((result) => result.status === 'failed' && result.required)
      ? 'failed'
      : 'passed';
  const summary = summarizeVerificationResults(results);
  const diagnosis = status === 'failed' ? diagnoseActiveVerificationFailure(results) : undefined;
  input.emitStage({
    stageId: 'stage:native_active_verification',
    phase: 'verification',
    title: 'Run active verification',
    target: input.plan.trigger,
    status: status === 'passed' ? 'completed' : status,
    summary,
    errorMessage: status === 'failed' ? summary : undefined,
    input: {
      trigger: input.plan.trigger,
      blocking: input.plan.blocking,
      plannedChecks: input.plan.checks,
      omittedChecks: input.plan.omittedChecks,
      diagnosis
    }
  });

  return {
    status,
    trigger: input.plan.trigger,
    blocking: input.plan.blocking,
    checks: results,
    omittedChecks: input.plan.omittedChecks,
    summary,
    diagnosis
  };
}
