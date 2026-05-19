import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type {
  AgentSkillActivation,
  AgentSkillIndexEntry,
  AgentSkillPackage,
  AgentSkillPackageSource,
  AgentSkillPermissionPolicy,
  AgentSkillRegistryConflict,
  AgentSkillRegistrySourceSummary,
  AgentSkillScriptDeclaration,
  AgentSkillScriptPolicy,
  AgentSkillSupportingFile,
  AgentSkillTrustLevel,
  AgentSkillVerificationStatus
} from '../../../shared/types';

type FrontmatterValue = string | string[] | boolean;
const MAX_AUTOMATIC_SKILL_ACTIVATIONS = 2;
const MAX_SKILL_SUPPORTING_FILES = 100;
const MAX_SKILL_SUPPORTING_FILE_BYTES = 128_000;
const MAX_SKILL_SUPPORTING_FILE_CHARS = 40_000;

export interface AgentSkillRegistrySource {
  source: AgentSkillPackageSource;
  sourceId: string;
  rootPath: string;
  skillsDir: string;
  priority: number;
}

export interface AgentSkillRegistry {
  packages: AgentSkillPackage[];
  index: AgentSkillIndexEntry[];
  conflicts: AgentSkillRegistryConflict[];
  sourcePrecedence: AgentSkillRegistrySourceSummary[];
}

export interface BuildAgentSkillRegistryOptions {
  projectPath?: string;
  userHomePath?: string;
  sources?: AgentSkillRegistrySource[];
}

function splitFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} {
  if (!content.startsWith('---')) {
    return {
      frontmatter: '',
      body: content
    };
  }

  const closingIndex = content.indexOf('\n---', 3);
  if (closingIndex < 0) {
    return {
      frontmatter: '',
      body: content
    };
  }

  return {
    frontmatter: content.slice(3, closingIndex).trim(),
    body: content.slice(closingIndex + 4).replace(/^\s*\n/, '')
  };
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseScalar(value: string): FrontmatterValue {
  const trimmed = cleanScalar(value);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(cleanScalar)
      .filter(Boolean);
  }
  return trimmed;
}

function parseFrontmatter(value: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  let currentListKey = '';

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/g, '');
    const listMatch = line.match(/^\s*-\s*(.+)$/);
    if (listMatch && currentListKey) {
      const existing = result[currentListKey];
      const list = Array.isArray(existing) ? existing : [];
      result[currentListKey] = [...list, cleanScalar(listMatch[1])];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1];
    const scalar = keyMatch[2] ?? '';
    if (scalar.trim()) {
      result[key] = parseScalar(scalar);
      currentListKey = '';
      continue;
    }

    result[key] = [];
    currentListKey = key;
  }

  return result;
}

function getFrontmatterString(frontmatter: Record<string, FrontmatterValue>, key: string): string | undefined {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
}

function getFrontmatterBoolean(frontmatter: Record<string, FrontmatterValue>, key: string, fallback: boolean): boolean {
  const value = frontmatter[key];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function getFrontmatterList(frontmatter: Record<string, FrontmatterValue>, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/\s*,\s*|\s{2,}/).map(cleanScalar).filter(Boolean);
  }
  return undefined;
}

function getFrontmatterListFromKeys(frontmatter: Record<string, FrontmatterValue>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = getFrontmatterList(frontmatter, key);
    if (value?.length) {
      return value;
    }
  }
  return undefined;
}

function normalizeSkillId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function contentSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveSkillTrustLevel(source: AgentSkillPackageSource, frontmatter: Record<string, FrontmatterValue>): AgentSkillTrustLevel {
  const declared = getFrontmatterString(frontmatter, 'trust-level') ?? getFrontmatterString(frontmatter, 'trust_level');
  if (declared === 'untrusted') {
    return 'untrusted';
  }
  if (declared === 'workspace') {
    return 'workspace';
  }
  if (declared === 'trusted' && (source === 'user' || source === 'plugin')) {
    return 'trusted';
  }
  if (source === 'user' || source === 'plugin') {
    return 'trusted';
  }
  if (source === 'project') {
    return 'workspace';
  }
  return 'untrusted';
}

function resolveSkillVerificationStatus(source: AgentSkillPackageSource, trustLevel: AgentSkillTrustLevel): AgentSkillVerificationStatus {
  if (trustLevel === 'trusted' && (source === 'user' || source === 'plugin')) {
    return 'trusted_source';
  }
  if (source === 'project' || source === 'user' || source === 'plugin') {
    return 'local_source';
  }
  return 'unverified_source';
}

function resolveSkillPermissionPolicy(
  trustLevel: AgentSkillTrustLevel,
  frontmatter: Record<string, FrontmatterValue>
): AgentSkillPermissionPolicy {
  const value = (getFrontmatterString(frontmatter, 'permission-policy') ?? getFrontmatterString(frontmatter, 'permission_policy') ?? '').toLowerCase();
  if (value === 'read-only' || value === 'read_only' || value === 'readonly') {
    return 'read_only';
  }
  if (value === 'approval-required' || value === 'approval_required' || value === 'ask-first' || value === 'ask_first') {
    return 'approval_required';
  }
  return trustLevel === 'untrusted' ? 'approval_required' : 'workspace_policy';
}

function parseScriptDeclarations(frontmatter: Record<string, FrontmatterValue>): AgentSkillScriptDeclaration[] | undefined {
  const scripts = getFrontmatterListFromKeys(frontmatter, ['scripts', 'script-commands', 'script_commands']);
  const singleScript = getFrontmatterString(frontmatter, 'script');
  const values = [...(scripts ?? []), ...(singleScript ? [singleScript] : [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!values.length) {
    return undefined;
  }
  return values.map((value, index) => {
    const [rawName, ...commandParts] = value.includes(':') ? value.split(':') : [];
    const command = commandParts.length ? commandParts.join(':').trim() : value;
    const name = commandParts.length ? normalizeSkillId(rawName ?? '') || `script-${index + 1}` : `script-${index + 1}`;
    return {
      name,
      command,
      risk: command.match(/\b(rm|sudo|curl|wget|chmod|chown|python|node|npm|pnpm|yarn|bun|bash|sh)\b/) ? 'high' : 'medium'
    };
  });
}

function resolveSkillScriptPolicy(scripts: AgentSkillScriptDeclaration[] | undefined): AgentSkillScriptPolicy {
  return scripts?.length ? 'approval_required' : 'none';
}

function safeStatDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readSkillPackage(skillPath: string, source: AgentSkillRegistrySource): AgentSkillPackage | undefined {
  const markdownPath = join(skillPath, 'SKILL.md');
  if (!existsSync(markdownPath)) {
    return undefined;
  }

  const raw = readFileSync(markdownPath, 'utf8');
  const parsed = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(parsed.frontmatter);
  const name = getFrontmatterString(frontmatter, 'name') || basename(skillPath);
  const sourcePath = relative(source.rootPath, markdownPath).replaceAll('\\', '/');
  const id = `${source.source}:${source.sourceId}:${normalizeSkillId(name || basename(skillPath))}`;
  const trustLevel = resolveSkillTrustLevel(source.source, frontmatter);
  const declaredScripts = parseScriptDeclarations(frontmatter);

  return {
    id,
    name,
    description: getFrontmatterString(frontmatter, 'description'),
    source: source.source,
    sourceId: source.sourceId,
    sourcePath,
    skillPath: markdownPath,
    rootPath: source.rootPath,
    relativePath: relative(source.rootPath, skillPath).replaceAll('\\', '/'),
    userInvocable: getFrontmatterBoolean(frontmatter, 'user-invocable', true),
    modelInvocable: !getFrontmatterBoolean(frontmatter, 'disable-model-invocation', false),
    allowedTools: getFrontmatterList(frontmatter, 'allowed-tools') ?? getFrontmatterList(frontmatter, 'allowed_tools'),
    dependencies: getFrontmatterList(frontmatter, 'dependencies'),
    inputs: getFrontmatterList(frontmatter, 'inputs'),
    outputs: getFrontmatterList(frontmatter, 'outputs'),
    examples: getFrontmatterList(frontmatter, 'examples'),
    trustLevel,
    verificationStatus: resolveSkillVerificationStatus(source.source, trustLevel),
    contentSha256: contentSha256(raw),
    permissionPolicy: resolveSkillPermissionPolicy(trustLevel, frontmatter),
    scriptPolicy: resolveSkillScriptPolicy(declaredScripts),
    declaredScripts,
    instruction: parsed.body.trim() || raw.trim(),
    rawFrontmatter: frontmatter
  };
}

function listSkillPackagesInSource(source: AgentSkillRegistrySource): AgentSkillPackage[] {
  if (!safeStatDirectory(source.skillsDir)) {
    return [];
  }

  return readdirSync(source.skillsDir)
    .map((entry) => join(source.skillsDir, entry))
    .filter((entryPath) => safeStatDirectory(entryPath))
    .map((entryPath) => readSkillPackage(entryPath, source))
    .filter((skill): skill is AgentSkillPackage => Boolean(skill));
}

function findProjectSkillRoot(projectPath: string): string {
  let current = resolve(projectPath);
  if (existsSync(current) && !statSync(current).isDirectory()) {
    current = dirname(current);
  }

  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(projectPath);
    }
    current = parent;
  }
}

export function buildDefaultAgentSkillSources(options: BuildAgentSkillRegistryOptions = {}): AgentSkillRegistrySource[] {
  const sources: AgentSkillRegistrySource[] = [];
  if (options.projectPath && existsSync(options.projectPath)) {
    const rootPath = findProjectSkillRoot(options.projectPath);
    sources.push({
      source: 'project',
      sourceId: rootPath,
      rootPath,
      skillsDir: join(rootPath, '.claude', 'skills'),
      priority: 10
    });
  }

  const userHomePath = options.userHomePath ?? homedir();
  if (userHomePath) {
    const rootPath = resolve(userHomePath);
    sources.push({
      source: 'user',
      sourceId: rootPath,
      rootPath,
      skillsDir: join(rootPath, '.claude', 'skills'),
      priority: 20
    });
  }

  return [...sources, ...(options.sources ?? [])];
}

function toIndexEntry(skill: AgentSkillPackage): AgentSkillIndexEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourceId: skill.sourceId,
    sourcePath: skill.sourcePath,
    relativePath: skill.relativePath,
    userInvocable: skill.userInvocable,
    modelInvocable: skill.modelInvocable,
    allowedTools: skill.allowedTools,
    dependencies: skill.dependencies,
    inputs: skill.inputs,
    outputs: skill.outputs,
    examples: skill.examples,
    trustLevel: skill.trustLevel,
    verificationStatus: skill.verificationStatus,
    contentSha256: skill.contentSha256,
    permissionPolicy: skill.permissionPolicy,
    scriptPolicy: skill.scriptPolicy,
    declaredScripts: skill.declaredScripts
  };
}

export function buildAgentSkillRegistry(options: BuildAgentSkillRegistryOptions = {}): AgentSkillRegistry {
  const sources = buildDefaultAgentSkillSources(options).sort((left, right) => left.priority - right.priority);
  const packages = sources
    .flatMap(listSkillPackagesInSource);
  const byName = new Map<string, AgentSkillPackage>();
  const grouped = new Map<string, AgentSkillPackage[]>();

  for (const skill of packages) {
    const normalizedName = normalizeSkillId(skill.name);
    byName.set(normalizedName, skill);
    grouped.set(normalizedName, [...(grouped.get(normalizedName) ?? []), skill]);
  }

  const resolved = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    packages: resolved,
    index: resolved.map(toIndexEntry),
    conflicts: [...grouped.values()]
      .filter((candidates) => candidates.length > 1)
      .map((candidates) => {
        const resolvedSkill = byName.get(normalizeSkillId(candidates[0].name)) ?? (candidates.at(-1) as AgentSkillPackage);
        return {
          name: resolvedSkill.name,
          resolvedSkillId: resolvedSkill.id,
          candidates: candidates.map(toIndexEntry)
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    sourcePrecedence: sources.map((source) => ({
      source: source.source,
      sourceId: source.sourceId,
      priority: source.priority,
      skillsDir: source.skillsDir
    }))
  };
}

export function findAgentSkillPackage(options: BuildAgentSkillRegistryOptions & {
  skillId?: string;
  skillName?: string;
}): AgentSkillPackage | undefined {
  const registry = buildAgentSkillRegistry(options);
  const normalizedName = options.skillName ? normalizeSkillId(options.skillName) : '';
  return registry.packages.find((skill) =>
    (options.skillId && skill.id === options.skillId) ||
    (normalizedName && normalizeSkillId(skill.name) === normalizedName)
  );
}

function extractSlashInvocation(message: string | undefined): string | undefined {
  const match = message?.trim().match(/^\/([A-Za-z0-9._-]+)(?:\s|$)/);
  return match?.[1];
}

function toActivation(skill: AgentSkillPackage, activationReason: AgentSkillActivation['activationReason']): AgentSkillActivation {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourceId: skill.sourceId,
    sourcePath: skill.sourcePath,
    activationReason,
    instruction: skill.instruction,
    allowedTools: skill.allowedTools,
    dependencies: skill.dependencies,
    examples: skill.examples,
    trustLevel: skill.trustLevel,
    verificationStatus: skill.verificationStatus,
    contentSha256: skill.contentSha256,
    permissionPolicy: skill.permissionPolicy,
    scriptPolicy: skill.scriptPolicy,
    declaredScripts: skill.declaredScripts
  };
}

function tokenizeSkillText(value: string | undefined): string[] {
  return [...new Set(
    (value ?? '')
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3)
  )];
}

function scoreAutomaticSkillMatch(skill: AgentSkillPackage, message: string | undefined): number {
  if (!skill.modelInvocable || skill.trustLevel === 'untrusted' || skill.permissionPolicy === 'approval_required' || !message?.trim()) {
    return 0;
  }
  const normalizedMessage = message.toLowerCase().replace(/[_-]+/g, ' ');
  const normalizedName = skill.name.toLowerCase().replace(/[_-]+/g, ' ');
  let score = normalizedMessage.includes(normalizedName) ? 4 : 0;
  const nameTerms = tokenizeSkillText(skill.name);
  const metadataTerms = tokenizeSkillText([
    skill.description,
    ...(skill.examples ?? [])
  ].filter(Boolean).join(' '));

  for (const term of nameTerms) {
    if (normalizedMessage.includes(term)) {
      score += 2;
    }
  }
  for (const term of metadataTerms.slice(0, 16)) {
    if (normalizedMessage.includes(term)) {
      score += 1;
    }
  }
  return score;
}

export function resolveAgentSkillActivations(options: BuildAgentSkillRegistryOptions & {
  message?: string;
}): AgentSkillActivation[] {
  const invoked = extractSlashInvocation(options.message);
  if (invoked === 'compact') {
    return [];
  }
  if (!invoked) {
    const registry = buildAgentSkillRegistry(options);
    return registry.packages
      .map((skill) => ({
        skill,
        score: scoreAutomaticSkillMatch(skill, options.message)
      }))
      .filter((entry) => entry.score >= 4)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
      .slice(0, MAX_AUTOMATIC_SKILL_ACTIVATIONS)
      .map((entry) => toActivation(entry.skill, 'automatic_metadata_match'));
  }

  const skill = findAgentSkillPackage({
    ...options,
    skillName: invoked
  });
  return skill?.userInvocable ? [toActivation(skill, 'explicit_slash')] : [];
}

function resolveSkillDirectory(skill: AgentSkillPackage): string {
  return dirname(skill.skillPath);
}

function safeRelativeSkillFilePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Invalid skill file path.');
  }
  return normalized;
}

function resolveReadableSupportingFile(root: string, relativePath: string) {
  const resolvedRoot = resolve(root);
  const absolutePath = resolve(resolvedRoot, relativePath);
  const pathFromRoot = relative(resolvedRoot, absolutePath);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || pathFromRoot.includes('\0')) {
    throw new Error('Invalid skill file path.');
  }
  let current = resolvedRoot;
  const segments = relativePath.split('/').filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error('Skill supporting file is not readable or is too large.');
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error('Skill supporting file is not readable or is too large.');
    }
  }
  return {
    absolutePath,
    stat: lstatSync(absolutePath)
  };
}

function collectSupportingFiles(skill: AgentSkillPackage): AgentSkillSupportingFile[] {
  const root = resolveSkillDirectory(skill);
  const files: AgentSkillSupportingFile[] = [];
  const visit = (directory: string): void => {
    if (files.length >= MAX_SKILL_SUPPORTING_FILES) {
      return;
    }
    for (const entry of readdirSync(directory)) {
      if (files.length >= MAX_SKILL_SUPPORTING_FILES) {
        return;
      }
      const absolutePath = join(directory, entry);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile() || entry === 'SKILL.md') {
        continue;
      }
      files.push({
        path: relative(root, absolutePath).replaceAll('\\', '/'),
        size: stat.size
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function listAgentSkillSupportingFiles(options: BuildAgentSkillRegistryOptions & {
  skillId?: string;
  skillName?: string;
}): AgentSkillSupportingFile[] {
  const skill = findAgentSkillPackage(options);
  if (!skill) {
    return [];
  }
  return collectSupportingFiles(skill);
}

export function readAgentSkillSupportingFile(options: BuildAgentSkillRegistryOptions & {
  skillId?: string;
  skillName?: string;
  filePath: string;
}): {
  skill: AgentSkillPackage;
  file: AgentSkillSupportingFile;
  content: string;
  truncated: boolean;
} | undefined {
  const skill = findAgentSkillPackage(options);
  if (!skill) {
    return undefined;
  }
  const relativePath = safeRelativeSkillFilePath(options.filePath);
  const root = resolveSkillDirectory(skill);
  const { absolutePath, stat } = resolveReadableSupportingFile(root, relativePath);
  if (!stat.isFile() || stat.size > MAX_SKILL_SUPPORTING_FILE_BYTES) {
    throw new Error('Skill supporting file is not readable or is too large.');
  }
  const buffer = readFileSync(absolutePath);
  if (buffer.includes(0)) {
    throw new Error('Skill supporting file appears to be binary.');
  }
  const content = buffer.toString('utf8');
  return {
    skill,
    file: {
      path: relative(root, absolutePath).replaceAll('\\', '/'),
      size: stat.size
    },
    content: content.length > MAX_SKILL_SUPPORTING_FILE_CHARS ? content.slice(0, MAX_SKILL_SUPPORTING_FILE_CHARS) : content,
    truncated: content.length > MAX_SKILL_SUPPORTING_FILE_CHARS
  };
}
