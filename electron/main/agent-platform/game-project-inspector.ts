import type { Project, ProjectFileEntry } from '../../../shared/types';
import { readProjectFileForProject } from '../project-file-service';
import type { WorkspaceToolActionResult } from './workspace-tools-types';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index).toLowerCase() : '';
}

function hasPath(paths: Set<string>, path: string): boolean {
  return paths.has(path);
}

function hasDirectory(paths: Set<string>, path: string): boolean {
  return paths.has(path) || [...paths].some((candidate) => candidate.startsWith(`${path}/`));
}

function parsePackageScripts(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

function formatList(items: string[], empty: string): string[] {
  return items.length ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

export async function inspectGameProject(project: Project, files: ProjectFileEntry[]): Promise<WorkspaceToolActionResult> {
  const paths = new Set(files.map((file) => file.path));
  const filePaths = files.filter((file) => file.type === 'file').map((file) => file.path);
  const directoryPaths = files.filter((file) => file.type === 'directory').map((file) => file.path);
  const hasPackageJson = hasPath(paths, 'package.json');
  const hasIndexHtml = hasPath(paths, 'index.html');
  const hasUnityProject = hasDirectory(paths, 'Assets') && (hasPath(paths, 'ProjectSettings/ProjectVersion.txt') || hasPath(paths, 'Packages/manifest.json'));
  const hasWebEntrypoint = hasIndexHtml || filePaths.some((path) => /^src\/(main|index|App)\.(tsx?|jsx?)$/i.test(path));
  const packageScripts = hasPackageJson ? parsePackageScripts((await readProjectFileForProject(project, 'package.json')).content) : {};
  const playableScripts = Object.entries(packageScripts)
    .filter(([name, command]) => /^(dev|start|serve|preview|build|test|play)$/i.test(name) || /\b(vite|next|astro|webpack|parcel|electron-vite)\b/i.test(command))
    .map(([name, command]) => `${name}: ${command}`);
  const playableEntrypoints = [
    hasIndexHtml ? 'index.html' : '',
    ...filePaths.filter((path) => /^src\/(main|index|App|game|server)\.(tsx?|jsx?|mjs)$/i.test(path)),
    ...filePaths.filter((path) => /^Assets\/.*\.unity$/i.test(path)).slice(0, 8)
  ].filter(Boolean);
  const assetDirectories = directoryPaths.filter((path) =>
    /(^|\/)(assets?|sprites?|images?|audio|sounds?|fonts?|misc|public|static)$/i.test(path)
  );
  const assetCounts = filePaths.reduce((counts, path) => {
    const extension = extensionOf(path);
    if (IMAGE_EXTENSIONS.has(extension)) counts.images += 1;
    else if (AUDIO_EXTENSIONS.has(extension)) counts.audio += 1;
    else if (FONT_EXTENSIONS.has(extension)) counts.fonts += 1;
    else if (/^(assets?|public|static)\//i.test(path)) counts.misc += 1;
    return counts;
  }, {
    images: 0,
    audio: 0,
    fonts: 0,
    misc: 0
  });
  const detectedKind = hasUnityProject
    ? 'unity-game'
    : hasWebEntrypoint || playableScripts.length
      ? 'web-game'
      : assetDirectories.length
        ? 'asset-workspace'
        : 'generic-workspace';
  const confidence = detectedKind === 'generic-workspace'
    ? 'low'
    : playableEntrypoints.length || hasUnityProject
      ? 'high'
      : 'medium';

  return {
    ok: true,
    summary: [
      'Game project inspection',
      `Detected kind: ${detectedKind}`,
      `Confidence: ${confidence}`,
      '',
      'Playable entrypoints:',
      ...formatList(playableEntrypoints, 'No obvious playable entrypoint found.'),
      '',
      'Runnable scripts:',
      ...formatList(playableScripts, 'No obvious dev/build/play script found.'),
      '',
      'Asset workflow:',
      ...formatList(assetDirectories, 'No dedicated asset directory found yet.'),
      `Asset counts: images=${assetCounts.images}, audio=${assetCounts.audio}, fonts=${assetCounts.fonts}, misc=${assetCounts.misc}`,
      '',
      'Browser validation workflow:',
      '- Run the dev/build command with run_command or terminal_start.',
      '- Open the local URL with browser_open/browser_navigate.',
      '- Check browser_console and capture browser_screenshot before claiming playable validation passed.',
      '',
      'Unity MCP workflow:',
      hasUnityProject
        ? '- Unity project structure detected. Use read_mcp_resource for scene/console state, then call_mcp_tool only when the user requests Unity-side actions.'
        : '- Unity project structure not detected. Do not assume Unity MCP is applicable unless the project is rebound or Unity files appear.'
    ].join('\n')
  };
}
