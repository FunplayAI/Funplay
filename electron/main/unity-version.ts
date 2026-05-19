import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { EngineProjectDimension, InstalledUnityEditorOption, UnityReleaseChannel } from '../../shared/types';

type UnityProjectTemplateKind = '2d-urp' | '3d-urp';

interface InstalledUnityEditor {
  version: string;
  appPath: string;
}

interface UnityProjectTemplate {
  displayName: string;
  packageName: string;
  packageVersion: string;
  kind: UnityProjectTemplateKind;
  path: string;
  source: 'editor' | 'hub-cache';
}

interface UnityEditorTemplateSelection {
  editor: InstalledUnityEditor;
  template: UnityProjectTemplate;
}

interface UnityVersionRecommendation {
  version: string;
  strategyLabel: string;
}

function parseUnityVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  channelRank: number;
  channelNumber: number;
} {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)/i);
  if (!match) {
    return {
      major: 0,
      minor: 0,
      patch: 0,
      channelRank: 0,
      channelNumber: 0
    };
  }

  const channel = match[4].toLowerCase();
  const channelRankMap: Record<string, number> = {
    a: 1,
    b: 2,
    f: 3,
    p: 4
  };

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    channelRank: channelRankMap[channel] ?? 0,
    channelNumber: Number(match[5])
  };
}

function getUnityReleaseChannel(version: string): UnityReleaseChannel {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)([abfp])(\d+)/i);
  if (!match) {
    return 'unknown';
  }
  const channel = match[4].toLowerCase();
  if (channel === 'f') return 'stable';
  if (channel === 'p') return 'patch';
  if (channel === 'b') return 'beta';
  if (channel === 'a') return 'alpha';
  return 'unknown';
}

function isStableUnityRelease(version: string): boolean {
  const channel = getUnityReleaseChannel(version);
  return channel === 'stable' || channel === 'patch';
}

function getTemplateKindFromDimension(dimension: EngineProjectDimension): UnityProjectTemplateKind | null {
  if (dimension === '2d') return '2d-urp';
  if (dimension === '3d') return '3d-urp';
  return null;
}

function readUnityTemplateManifest(templatePath: string): {
  name?: string;
  displayName?: string;
  version?: string;
  dependencies?: Record<string, string>;
} | null {
  try {
    const raw = execFileSync('tar', ['-xOf', templatePath, 'package/package.json'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 512 * 1024
    });
    return JSON.parse(raw) as {
      name?: string;
      displayName?: string;
      version?: string;
      dependencies?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

function classifyUnityTemplate(manifest: {
  name?: string;
  displayName?: string;
  dependencies?: Record<string, string>;
}): UnityProjectTemplateKind | null {
  const packageName = manifest.name ?? '';
  const displayName = manifest.displayName ?? '';
  const dependencies = manifest.dependencies ?? {};
  const hasUrp = !!dependencies['com.unity.render-pipelines.universal'];
  const has2dFeature =
    !!dependencies['com.unity.feature.2d'] ||
    Object.keys(dependencies).some((dependency) => dependency.startsWith('com.unity.2d.'));

  if (!hasUrp) {
    return null;
  }

  if (
    /universal 2d|2d urp/i.test(displayName) ||
    packageName === 'com.unity.template.universal-2d' ||
    has2dFeature
  ) {
    return '2d-urp';
  }

  if (
    /3d urp/i.test(displayName) ||
    packageName === 'com.unity.template.urp-blank' ||
    (/universal/i.test(packageName) && !/2d/i.test(packageName))
  ) {
    return '3d-urp';
  }

  return null;
}

function getUnityHubTemplateCachePaths(): string[] {
  const home = process.env.HOME ?? '';
  if (!home) {
    return [];
  }

  const templateRoots = [
    join(home, 'Library', 'Application Support', 'UnityHub', 'Templates'),
    join(home, 'Library', 'Application Support', 'UnityHub', 'Templates', 'UOS')
  ];

  return templateRoots.flatMap((root) => {
    if (!existsSync(root)) {
      return [];
    }

    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
  });
}

function listUnityProjectTemplates(editorAppPath: string): UnityProjectTemplate[] {
  const templatesDir = join(editorAppPath, 'Contents', 'Resources', 'PackageManager', 'ProjectTemplates');
  const editorTemplatePaths = existsSync(templatesDir)
    ? readdirSync(templatesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
        .map((entry) => join(templatesDir, entry.name))
    : [];
  const templatePaths = [...editorTemplatePaths, ...getUnityHubTemplateCachePaths()];

  const templates = templatePaths
    .map((templatePath) => {
      const manifest = readUnityTemplateManifest(templatePath);
      if (!manifest) {
        return null;
      }

      const kind = classifyUnityTemplate(manifest);
      if (!kind) {
        return null;
      }

      return {
        displayName: manifest.displayName ?? manifest.name ?? templatePath.split('/').pop() ?? 'Unity Template',
        packageName: manifest.name ?? '',
        packageVersion: manifest.version ?? '',
        kind,
        path: templatePath,
        source: templatePath.startsWith(templatesDir) ? 'editor' : 'hub-cache'
      } satisfies UnityProjectTemplate;
    })
    .filter((template): template is UnityProjectTemplate => !!template);

  const deduped = new Map<string, UnityProjectTemplate>();
  for (const template of templates) {
    const key = `${template.packageName}@${template.packageVersion}`;
    if (!deduped.has(key) || (deduped.get(key)?.source === 'hub-cache' && template.source === 'editor')) {
      deduped.set(key, template);
    }
  }

  return [...deduped.values()];
}

export function listInstalledUnityEditors(): InstalledUnityEditor[] {
  const hubEditorRoot = '/Applications/Unity/Hub/Editor';
  const editors: InstalledUnityEditor[] = [];

  if (existsSync(hubEditorRoot)) {
    try {
      editors.push(
        ...readdirSync(hubEditorRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(hubEditorRoot, entry.name, 'Unity.app')))
          .map((entry) => ({
            version: entry.name,
            appPath: join(hubEditorRoot, entry.name, 'Unity.app')
          }))
      );
    } catch {
      // noop
    }
  }

  const fallback = '/Applications/Unity/Unity.app';
  if (existsSync(fallback)) {
    editors.push({
      version: '本地 Unity.app',
      appPath: fallback
    });
  }

  return editors.sort((left, right) => compareUnityVersions(right.version, left.version));
}

export function compareUnityVersions(left: string, right: string): number {
  const a = parseUnityVersion(left);
  const b = parseUnityVersion(right);

  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.channelRank !== b.channelRank) return a.channelRank - b.channelRank;
  if (a.channelNumber !== b.channelNumber) return a.channelNumber - b.channelNumber;
  return left.localeCompare(right);
}

export function versionStrategyLabel(dimension: EngineProjectDimension): string {
  return `优先使用本机已安装且支持官方 ${dimension === '2d' ? '2D URP' : '3D URP'} 模板的最新 Unity 版本`;
}

export function buildInstalledUnityEditorOptions(dimension: EngineProjectDimension = 'unknown'): InstalledUnityEditorOption[] {
  const editors = listInstalledUnityEditors().map((editor) => {
    const templates = listUnityProjectTemplates(editor.appPath);
    const supports2dUrp = templates.some((template) => template.kind === '2d-urp');
    const supports3dUrp = templates.some((template) => template.kind === '3d-urp');
    const compatible = dimension === '2d' ? supports2dUrp : dimension === '3d' ? supports3dUrp : supports2dUrp || supports3dUrp;

    return {
      version: editor.version,
      displayName: editor.version,
      releaseChannel: getUnityReleaseChannel(editor.version),
      supports2dUrp,
      supports3dUrp,
      recommended: false,
      compatible,
      reason: compatible
        ? isStableUnityRelease(editor.version)
          ? '支持官方模板，可直接创建，推荐稳定版。'
          : '支持官方模板，但属于预发布版本。'
        : `当前版本不支持 ${dimension === '2d' ? '2D URP' : dimension === '3d' ? '3D URP' : '所选'} 官方模板。`
    } satisfies InstalledUnityEditorOption;
  });

  const compatibleEditors = editors.filter((editor) => editor.compatible);
  const recommendedEditor =
    compatibleEditors
      .filter((editor) => editor.releaseChannel === 'stable' || editor.releaseChannel === 'patch')
      .sort((left, right) => compareUnityVersions(right.version, left.version))[0] ??
    compatibleEditors.sort((left, right) => compareUnityVersions(right.version, left.version))[0];

  return editors.map((editor) => ({
    ...editor,
    recommended: editor.version === recommendedEditor?.version,
    reason:
      editor.version === recommendedEditor?.version
        ? editor.releaseChannel === 'stable' || editor.releaseChannel === 'patch'
          ? '推荐稳定版。'
          : '推荐：当前可用的最新版本。'
        : editor.reason
  }));
}

export function selectUnityEditorForTemplate(
  dimension: EngineProjectDimension,
  preferredVersion?: string
): UnityEditorTemplateSelection | null {
  const templateKind = getTemplateKindFromDimension(dimension);
  if (!templateKind) {
    return null;
  }

  const matches = listInstalledUnityEditors()
    .map((editor) => ({
      editor,
      template: listUnityProjectTemplates(editor.appPath)
        .filter((candidate) => candidate.kind === templateKind)
        .sort((left, right) => {
          if (left.source !== right.source) {
            return left.source === 'editor' ? -1 : 1;
          }
          return compareUnityVersions(right.packageVersion, left.packageVersion);
        })[0]
    }))
    .filter((candidate): candidate is { editor: InstalledUnityEditor; template: UnityProjectTemplate } => !!candidate.template)
    .sort((left, right) => compareUnityVersions(right.editor.version, left.editor.version));

  if (matches.length === 0) {
    return null;
  }

  if (preferredVersion) {
    const installedEditor = listInstalledUnityEditors().find((candidate) => candidate.version === preferredVersion);
    if (installedEditor) {
      const preferred = matches.find((candidate) => candidate.editor.version === preferredVersion);
      return preferred ?? null;
    }
  }

  const recommendedStable =
    matches.find((candidate) => isStableUnityRelease(candidate.editor.version)) ??
    matches[0];

  return recommendedStable;
}
