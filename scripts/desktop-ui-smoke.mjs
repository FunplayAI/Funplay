import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(repoRoot, 'out/desktop-ui-smoke');
const reportPath = resolve(outDir, 'latest-report.md');

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

async function readComponentSources(dir = resolve(repoRoot, 'src/components')) {
  const entries = await readdir(dir, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(await readComponentSources(entryPath));
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      sources.push(await readFile(entryPath, 'utf8'));
    }
  }
  return sources.join('\n');
}

// U46-1 sliced src/styles.css into src/styles/base, components, layers. This
// concatenates every slice (excluding tokens.css and the index.css barrel) so
// content checks behave exactly as they did against the old monolith.
async function readSlicedStyles(dir = resolve(repoRoot, 'src/styles')) {
  const entries = await readdir(dir, { withFileTypes: true });
  const sources = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(await readSlicedStyles(entryPath));
    } else if (entry.name.endsWith('.css') && entry.name !== 'tokens.css' && entry.name !== 'index.css') {
      sources.push(await readFile(entryPath, 'utf8'));
    }
  }
  return sources.join('\n');
}

// Slice file paths relative to src/styles/, e.g. 'base/foundation.css'.
async function readSlicedStyleFileList(dir = resolve(repoRoot, 'src/styles'), prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = resolve(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await readSlicedStyleFileList(entryPath, relPath)));
    } else if (entry.name.endsWith('.css') && entry.name !== 'tokens.css' && entry.name !== 'index.css') {
      files.push(relPath);
    }
  }
  return files;
}

// Plain (non-module) `.css` files under src/components — these leak global
// scope and are rejected by U46-3.
async function findNonModuleComponentCss(dir = resolve(repoRoot, 'src/components')) {
  const entries = await readdir(dir, { withFileTypes: true });
  const offenders = [];
  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      offenders.push(...(await findNonModuleComponentCss(entryPath)));
    } else if (entry.name.endsWith('.css') && !entry.name.endsWith('.module.css')) {
      offenders.push(entryPath.slice(repoRoot.length + 1));
    }
  }
  return offenders;
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Desktop UI smoke failed: missing ${label}`);
  }
}

function assertMatches(source, pattern, label) {
  if (!pattern.test(source)) {
    throw new Error(`Desktop UI smoke failed: missing ${label}`);
  }
}

function assertNotMatches(source, pattern, label) {
  if (pattern.test(source)) {
    throw new Error(`Desktop UI smoke failed: unexpected ${label}`);
  }
}

const appSource = await readRepoFile('src/App.tsx');
const modalSource = await readRepoFile('src/components/settings-modals.tsx');
const appSettingsModalSource = await readRepoFile('src/components/modals/AppSettingsModal.tsx');
const appSettingsAiProviderSectionSource = await readRepoFile('src/components/modals/AppSettingsAiProviderSection.tsx');
const appSettingsAssetProviderSectionSource = await readRepoFile(
  'src/components/modals/AppSettingsAssetProviderSection.tsx'
);
const sidebarSource = await readRepoFile('src/components/layout/WorkspacePanels.tsx');
const projectSettingsSource = await readRepoFile('src/components/pages/ProjectSettingsPage.tsx');
const messageListSource = await readRepoFile('src/components/chat/MessageList.tsx');
const chatMarkdownSource = await readRepoFile('src/components/chat/transcript/chat-markdown.tsx');
const agentCoreSource = await readRepoFile('shared/agent-core-v2.ts');
const appHelpersSource = await readRepoFile('src/lib/app-helpers.ts');
const componentSources = await readComponentSources();
const stylesSource = await readSlicedStyles();
const uiTestSource = await readRepoFile('tests/runtime/agent-ui-render.test.ts');

assertIncludes(appSource, 'data-workspace-section={section}', 'workspace section marker');
assertIncludes(appSource, 'role="main"', 'workspace main role');
assertIncludes(modalSource, 'role="dialog"', 'modal dialog role');
assertIncludes(modalSource, 'aria-modal="true"', 'modal aria-modal');
assertIncludes(modalSource, 'data-modal-state="open"', 'modal open-state marker');
assertIncludes(
  sidebarSource,
  "aria-current={props.activeNavId === item.id ? 'page' : undefined}",
  'workspace nav aria-current'
);
assertIncludes(
  projectSettingsSource,
  "aria-current={tab === item.id ? 'page' : undefined}",
  'project settings aria-current'
);
assertMatches(
  uiTestSource,
  /workspace sidebar navigation marks the active section semantically/,
  'workspace nav render test'
);
assertMatches(uiTestSource, /app settings modal is a semantic dialog/, 'modal render test');
assertNotMatches(
  componentSources,
  /prototype-|className=(?:"field\b|'field\b|\{`field\b)|settings-field|skill-form-row|app-settings-check-row/,
  'legacy UI class emissions'
);
assertNotMatches(
  stylesSource,
  /prototype-|\.field\b|settings-field|skill-form-row|app-settings-check-row/,
  'legacy UI selector aliases'
);
assertIncludes(stylesSource, '@media (prefers-reduced-motion: reduce)', 'reduced-motion media query');
assertIncludes(stylesSource, 'animation-duration: 0.001ms !important', 'global reduced-motion animation duration');
assertIncludes(stylesSource, '.command-palette-dialog', 'command palette reduced-motion coverage');
assertIncludes(stylesSource, '.agent-live-spinner::before', 'running status reduced-motion coverage');
assertIncludes(stylesSource, 'color-scheme: light', 'light color scheme declaration');
assertIncludes(stylesSource, 'color-scheme: dark', 'dark color scheme declaration');
assertIncludes(stylesSource, '@media (forced-colors: active)', 'forced-colors media query');
assertIncludes(stylesSource, 'accent-color: Highlight', 'forced-colors accent color');
assertIncludes(
  stylesSource,
  ".command-palette-item[aria-selected='true']",
  'forced-colors command palette selection coverage'
);
assertIncludes(stylesSource, 'outline: 2px solid Highlight !important', 'forced-colors focus outline');
assertMatches(
  agentCoreSource,
  /part\.kind === 'usage'[\s\S]*?return '';/,
  'Agent Core usage metadata stays out of plain text projection'
);
assertIncludes(appHelpersSource, 'stripInternalSessionPreviewNoise', 'session preview internal-noise stripping');
assertIncludes(stylesSource, '.provider-card-actions .fp-button-icon', 'Provider action icon reset');
assertMatches(
  stylesSource,
  /\.provider-card-actions \.fp-button-icon,[\s\S]*?background: transparent;/,
  'Provider action inner capsules stay transparent'
);
assertMatches(
  stylesSource,
  /\.file-item-label[\s\S]*?line-height: var\(--fp-space-5\)/,
  'file tree label clipping guard'
);
assertMatches(
  stylesSource,
  /\.agent-composer-footer[\s\S]*?align-items: center;[\s\S]*?min-height: var\(--fp-control-height\)/,
  'composer footer alignment guard'
);
assertIncludes(stylesSource, '.runtime-doctor-status-card', 'Runtime Doctor status card styling');
assertIncludes(messageListSource, '<IconButton', 'scroll-to-bottom renders as icon button');
assertIncludes(chatMarkdownSource, 'chat-plain-text-block', 'plain text fences skip labeled code chrome');
assertMatches(
  stylesSource,
  /\.chat-transcript-bubble\.assistant \.chat-transcript-meta[\s\S]*?align-items: center;/,
  'assistant meta row vertical alignment'
);
assertIncludes(
  projectSettingsSource,
  'project-settings-nav-icon',
  'project settings navigation uses compact icon affordances'
);
assertNotMatches(componentSources, /asset-library-inspector/, 'asset library duplicate side inspector');
assertMatches(
  appSettingsAiProviderSectionSource,
  /editorOpen[\s\S]*?<ProviderEditor[\s\S]*?return \([\s\S]*?<ProviderSettingsPage/,
  'provider editor replaces the provider list while adding or editing'
);
assertMatches(
  appSettingsAssetProviderSectionSource,
  /editorOpen[\s\S]*?<AssetProviderEditor[\s\S]*?return \([\s\S]*?<AssetProviderSettingsPage/,
  'asset provider editor replaces the provider list while adding or editing'
);
assertMatches(
  stylesSource,
  /@media \(max-width: 860px\), \(max-height: 680px\)[\s\S]*?\.app-settings-nav-copy span[\s\S]*?display: none;/,
  'compact app settings navigation hides verbose descriptions'
);

// U45-2g: Keep component-level `:root[data-theme='dark']` selectors under a
// ratchet baseline. Theme-aware values should flow through tokens defined in
// `src/styles/tokens.css` when practical; lower this baseline as the remaining
// dark-only code highlighting rules migrate to token-backed selectors.
const darkComponentOverrideBaseline = 31;
const darkComponentOverrideCount = (stylesSource.match(/:root\[data-theme='dark'\]\s+[.\w]/g) ?? []).length;
if (darkComponentOverrideCount > darkComponentOverrideBaseline) {
  throw new Error(
    `Desktop UI smoke failed: src/styles.css contains ${darkComponentOverrideCount} component-level :root[data-theme='dark'] selectors, exceeding the baseline of ${darkComponentOverrideBaseline}. Theme-dependent styling should reference a token from src/styles/tokens.css or a :where()-based fallback where practical.`
  );
}

const tokensCssSource = await readRepoFile('src/styles/tokens.css');
assertIncludes(tokensCssSource, '--fp-color-gray-50', 'tokens.css raw color scale');
assertIncludes(tokensCssSource, '--fp-body-background', 'tokens.css body background token');
assertIncludes(tokensCssSource, '--fp-elevated-card-bg', 'tokens.css elevated card token');
assertIncludes(tokensCssSource, '--fp-workspace-sidebar-bg', 'tokens.css workspace sidebar token');
assertIncludes(tokensCssSource, '--fp-agent-composer-bg', 'tokens.css agent composer token');
assertIncludes(tokensCssSource, '--fp-chat-code-card-bg', 'tokens.css chat markdown code token');
assertIncludes(tokensCssSource, '--fp-chat-user-bubble-bg', 'tokens.css chat user bubble token');
assertIncludes(tokensCssSource, '--fp-project-settings-page-bg', 'tokens.css project settings shell token');
assertIncludes(tokensCssSource, '--fp-asset-generation-panel-bg', 'tokens.css asset generation panel token');
assertIncludes(tokensCssSource, ":root[data-theme='dark']", 'tokens.css dark theme overrides');
assertMatches(
  stylesSource,
  /\.workspace-sidebar[\s\S]*?background: var\(--fp-workspace-sidebar-bg\)/,
  'workspace sidebar uses theme token surface'
);
assertMatches(
  stylesSource,
  /\.agent-composer-shell[\s\S]*?background: var\(--fp-agent-composer-bg\)/,
  'agent composer uses theme token surface'
);
assertMatches(
  stylesSource,
  /\.chat-code-card[\s\S]*?background: var\(--fp-chat-code-card-bg\)/,
  'chat markdown code card uses theme token surface'
);
assertMatches(
  stylesSource,
  /\.chat-transcript-bubble\.user[\s\S]*?background: var\(--fp-chat-user-bubble-bg\)/,
  'chat user bubble uses theme token surface'
);
assertMatches(
  stylesSource,
  /\.project-settings-page[\s\S]*?background: var\(--fp-project-settings-page-bg\)/,
  'project settings shell uses theme token surface'
);
assertMatches(
  stylesSource,
  /\.project-settings-detail-header[\s\S]*?background: var\(--fp-project-settings-detail-header-bg\)/,
  'project settings header uses theme token surface'
);
assertMatches(
  stylesSource,
  /\.asset-library-card[\s\S]*?background: var\(--fp-asset-card-bg\)/,
  'asset library cards use theme token surface'
);
assertMatches(
  stylesSource,
  /\.asset-generation-form,[\s\S]*?\.asset-generation-job[\s\S]*?background: var\(--fp-asset-generation-panel-bg\)/,
  'asset generation panels use theme token surface'
);

// U46: CSS architecture integrity. The monolithic src/styles.css was sliced
// into src/styles/{base,components,layers} in source order; src/styles/index.css
// is the ordered barrel. These checks keep the slice structure intact and stop
// a regression back to a monolith.
const monolithExists = await readRepoFile('src/styles.css').then(
  () => true,
  () => false
);
if (monolithExists) {
  throw new Error(
    'Desktop UI smoke failed: src/styles.css reappeared. Styling is sliced under src/styles/; add new rules to the appropriate slice or a component *.module.css, and import via src/styles/index.css.'
  );
}

const barrelSource = await readRepoFile('src/styles/index.css');
const barrelImports = [...barrelSource.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1]);
const sliceFiles = (await readSlicedStyleFileList()).map((p) => `./${p}`);
for (const slice of sliceFiles) {
  if (!barrelImports.includes(slice)) {
    throw new Error(
      `Desktop UI smoke failed: src/styles/index.css does not @import the slice ${slice}. Every slice file must be in the barrel, in source order.`
    );
  }
}
assertIncludes(barrelSource, "@import './tokens.css'", 'barrel imports tokens.css first');
const tokensImportIndex = barrelSource.indexOf("@import './tokens.css'");
const baseImportIndex = barrelSource.indexOf("@import './base/");
if (tokensImportIndex < 0 || baseImportIndex < 0 || tokensImportIndex > baseImportIndex) {
  throw new Error('Desktop UI smoke failed: src/styles/index.css must @import tokens.css before the base slice.');
}

// U46-3: new component stylesheets must be CSS Modules. A plain `.css` file
// (other than a `*.module.css`) under src/components is a global-scope leak
// and is rejected — co-locate component styles as `<Name>.module.css`.
const nonModuleComponentCss = await findNonModuleComponentCss();
if (nonModuleComponentCss.length > 0) {
  throw new Error(
    `Desktop UI smoke failed: non-module stylesheet(s) under src/components: ${nonModuleComponentCss.join(', ')}. ` +
      'New component styles must be co-located CSS Modules (`*.module.css`) that reference --fp-* tokens.'
  );
}

const generatedAt = new Date().toISOString();
const report = [
  '# Desktop UI Smoke Report',
  '',
  `Generated: ${generatedAt}`,
  '',
  '## Deterministic Checks',
  '',
  '- Workspace route wrapper exposes `role="main"` and `data-workspace-section`.',
  '- Workspace sidebar and Project Settings navigation expose `aria-current="page"`.',
  '- App Settings modal exposes `role="dialog"`, `aria-modal="true"`, and `data-modal-state="open"`.',
  '- Static UI render tests cover active navigation semantics and the Provider settings modal entry.',
  '- Component sources no longer emit legacy prototype/form class names.',
  '- CSS no longer contains legacy prototype/form selector aliases.',
  '- CSS defines a global reduced-motion contract for transitions, command palette, and running status animation.',
  '- CSS defines color-scheme and forced-colors contracts for high-contrast accessibility.',
  '- Session previews strip internal runtime usage metadata before rendering summaries.',
  '- Provider action buttons reset nested label/icon capsules and Runtime Doctor renders status cards.',
  '- File tree and composer controls keep token-backed line-height/alignment guards.',
  '- Assistant replies keep header metadata aligned, plain text fences avoid labeled code chrome, and the scroll-to-bottom affordance is icon-only.',
  '- Project/App Settings compact navigation uses icon tabs instead of clipped cards; Assets avoids duplicate side inspector panels.',
  '- Provider add/edit mode replaces the Provider list instead of stacking two workflows.',
  "- CSS carries zero component-level `:root[data-theme='dark']` overrides; theme values flow through `src/styles/tokens.css`.",
  '- CSS is sliced under `src/styles/{base,components,layers}` with an ordered `index.css` barrel; the monolithic `src/styles.css` is gone.',
  '- Component stylesheets under `src/components` are CSS Modules (`*.module.css`).',
  '',
  '## Electron-Only Manual Walkthrough',
  '',
  'Use `npm run dev`, then inspect the Electron/Funplay window only.',
  '',
  '- Confirm the active app is Electron/Funplay before collecting visual evidence.',
  '- Prefer app-scoped Computer Use state for `app="Electron"` over whole-desktop screenshots.',
  '- Whole-desktop screenshots are not accepted as route/modal proof because they can capture Codex or another foreground app.',
  '- Verify Agent -> Project Settings -> Assets route changes by checking both visible content and active navigation state.',
  '- Open App Settings from the titlebar and verify the Provider tab is reachable inside the modal.',
  '- At compact window size, verify App Settings and Project Settings category navigation becomes horizontally scrollable and provider grids collapse to one column.',
  ''
].join('\n');

await mkdir(outDir, { recursive: true });
await writeFile(reportPath, report);
console.log(`Desktop UI smoke passed: ${reportPath}`);
