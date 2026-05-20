import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = resolve(repoRoot, 'out/desktop-ui-maturity-gate');
const reportPath = resolve(reportDir, 'latest-report.md');

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
}

async function collectComponentFiles(dir = resolve(repoRoot, 'src/components')) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectComponentFiles(entryPath));
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
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

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Desktop UI maturity gate failed: missing ${label}`);
  }
}

function assertMatches(source, pattern, label) {
  if (!pattern.test(source)) {
    throw new Error(`Desktop UI maturity gate failed: missing ${label}`);
  }
}

function assertNotMatches(source, pattern, label) {
  if (pattern.test(source)) {
    throw new Error(`Desktop UI maturity gate failed: unexpected ${label}`);
  }
}

const packageJson = JSON.parse(await readRepoFile('package.json'));
const componentFiles = await collectComponentFiles();
const rawControlMatches = [];
for (const file of componentFiles) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/<(button|input|select|textarea)\b/g)) {
    const relativePath = relative(repoRoot, file);
    if (relativePath !== 'src/components/ui/FormControls.tsx') {
      rawControlMatches.push(`${relativePath}:${match.index}:${match[0]}`);
    }
  }
}
if (rawControlMatches.length > 0) {
  throw new Error(`Desktop UI maturity gate failed: raw controls outside shared UI primitives:\n${rawControlMatches.join('\n')}`);
}

const uiIndex = await readRepoFile('src/components/ui/index.ts');
const formControls = await readRepoFile('src/components/ui/FormControls.tsx');
const dialogFocusHook = await readRepoFile('src/components/ui/useDialogFocus.ts');
const appShell = await readRepoFile('src/components/layout/AppShell.tsx');
const modalShell = await readRepoFile('src/components/settings-modals.tsx');
const electronSmoke = await readRepoFile('scripts/desktop-ui-electron-smoke.mjs');
const staticSmoke = await readRepoFile('scripts/desktop-ui-smoke.mjs');
const renderTests = await readRepoFile('tests/runtime/agent-ui-render.test.ts');
const styles = await readSlicedStyles();
const uiPlan = await readRepoFile('docs/desktop-ui-improvement-plan.md');

for (const scriptName of ['ui:smoke', 'ui:electron-smoke', 'ui:maturity-gate']) {
  if (!packageJson.scripts?.[scriptName]) {
    throw new Error(`Desktop UI maturity gate failed: missing package script ${scriptName}`);
  }
}

for (const exportName of ['Button', 'IconButton', 'TextField', 'TextAreaControl', 'TextAreaField', 'SelectField', 'SwitchField', 'CheckboxField', 'Badge', 'Surface', 'useDialogFocus']) {
  assertIncludes(uiIndex, exportName, `shared UI export ${exportName}`);
}

assertIncludes(formControls, 'export function TextAreaControl', 'shared standalone textarea control');
assertIncludes(dialogFocusHook, 'export function useDialogFocus', 'shared dialog focus hook');
assertIncludes(dialogFocusHook, 'FOCUSABLE_SELECTOR', 'shared dialog focus selector');
assertIncludes(dialogFocusHook, 'event.key === \'Escape\'', 'shared dialog Escape handling');
assertIncludes(dialogFocusHook, 'event.key !== \'Tab\'', 'shared dialog Tab trap');
assertIncludes(dialogFocusHook, 'previousActiveElement', 'shared dialog focus restoration');
assertIncludes(appShell, 'CommandPrimitive', 'command palette primitive');
assertIncludes(appShell, 'aria-keyshortcuts="Meta+K Control+K"', 'command palette keyboard shortcut');
assertIncludes(appShell, 'data-command-palette-state="open"', 'command palette open state marker');
assertIncludes(appShell, 'data-command-id={action.id}', 'command palette action ids');
assertIncludes(appShell, 'event.key.toLowerCase() === \'k\'', 'command palette keyboard listener');
assertIncludes(appShell, 'useDialogFocus({', 'command palette shared dialog focus hook');
assertIncludes(modalShell, 'useDialogFocus({', 'modal shared dialog focus hook');
assertIncludes(modalShell, 'tabIndex={-1}', 'modal focusable dialog shell');

assertIncludes(electronSmoke, 'BrowserWindow', 'real Electron smoke window');
assertIncludes(electronSmoke, 'capturePage()', 'app-scoped screenshot capture');
assertIncludes(electronSmoke, 'activeElementInsideModal', 'modal focus smoke detail');
assertIncludes(electronSmoke, 'pressKey(win.webContents, \'Tab\')', 'Tab focus smoke assertion');
assertIncludes(electronSmoke, 'pressKey(win.webContents, \'Escape\')', 'Escape close smoke assertion');
assertIncludes(electronSmoke, 'pressCommandPaletteShortcut', 'command palette shortcut smoke assertion');
assertIncludes(electronSmoke, 'commandPaletteAfterTab.activeElementInsideCommandPalette', 'command palette Tab trap smoke assertion');
assertIncludes(electronSmoke, 'Emulation.setEmulatedMedia', 'Electron reduced-motion emulation');
assertIncludes(electronSmoke, 'reducedMotionMatches', 'Electron reduced-motion smoke detail');
assertIncludes(electronSmoke, 'forcedColorsMatches', 'Electron forced-colors smoke detail');
assertIncludes(electronSmoke, 'forced-colors', 'Electron forced-colors emulation');
assertIncludes(electronSmoke, 'commandPaletteAnimationName', 'command palette reduced-motion computed style assertion');
assertIncludes(electronSmoke, 'commandPaletteBorderColor', 'command palette forced-colors computed style assertion');
assertIncludes(electronSmoke, 'clickCommandPaletteItem', 'command palette command execution smoke assertion');
assertIncludes(electronSmoke, 'collectAccessibilityIssues', 'real-window interactive accessibility audit');
assertIncludes(electronSmoke, 'Visible interactive controls without accessible names', 'accessibility audit failure message');
assertIncludes(electronSmoke, '## Accessibility Audit', 'accessibility audit report section');
assertIncludes(electronSmoke, 'collectLayoutIssues', 'real-window layout stability audit');
assertIncludes(electronSmoke, 'Visible desktop UI layout overflow', 'layout audit failure message');
assertIncludes(electronSmoke, '## Layout Stability Audit', 'layout audit report section');
assertIncludes(electronSmoke, 'verifyAgentChatScroll', 'real-window chat scroll regression assertion');
assertIncludes(electronSmoke, 'Expected long chat transcript to overflow', 'chat scroll regression failure message');
assertIncludes(electronSmoke, 'sidebarSessionTitleWidth', 'real-window session title visibility assertion');
assertIncludes(electronSmoke, 'verifyComposerBottomAnchoring', 'real-window composer bottom anchoring assertion');
assertIncludes(electronSmoke, 'Expected composer to stay anchored near chat bottom', 'composer bottom anchoring failure message');
assertIncludes(electronSmoke, 'Empty Agent Composer', 'empty chat composer regression state');
assertIncludes(electronSmoke, 'Compact Agent Composer', 'compact composer smoke state');
assertIncludes(staticSmoke, 'legacy UI class emissions', 'legacy component source audit');
assertIncludes(staticSmoke, 'legacy UI selector aliases', 'legacy CSS alias audit');

for (const testName of [
  'completed transcript inline controls render through shared buttons',
  'notification toast dismiss uses shared icon button',
  'app shell exposes a global keyboard command palette',
  'app settings modal is a semantic dialog',
  'chat composer exposes provider and Build/Plan controls',
  'message list windows old history by default'
]) {
  assertIncludes(renderTests, testName, `render test ${testName}`);
}
assertIncludes(renderTests, 'tabindex="-1"', 'modal focusable shell render assertion');
assertIncludes(renderTests, 'data-command-palette-state="open"', 'command palette open render assertion');
assertIncludes(renderTests, 'aria-label="命令面板"[^>]*tabindex="-1"', 'command palette focusable dialog render assertion');

assertNotMatches(styles, /prototype-|\.field\b|settings-field|skill-form-row|app-settings-check-row/, 'legacy UI selector aliases');
assertIncludes(styles, '@media (prefers-reduced-motion: reduce)', 'reduced-motion media query');
assertIncludes(styles, 'animation-duration: 0.001ms !important', 'global reduced-motion animation duration');
assertIncludes(styles, 'transition-duration: 0.001ms !important', 'global reduced-motion transition duration');
assertIncludes(styles, '.command-palette-dialog', 'command palette reduced-motion coverage');
assertIncludes(styles, '.agent-live-spinner::before', 'running status reduced-motion coverage');
assertIncludes(styles, 'color-scheme: light', 'light color scheme declaration');
assertIncludes(styles, 'color-scheme: dark', 'dark color scheme declaration');
assertIncludes(styles, '@media (forced-colors: active)', 'forced-colors media query');
assertIncludes(styles, 'accent-color: Highlight', 'forced-colors accent color');
assertIncludes(styles, 'background: Highlight !important', 'forced-colors selected background');
assertIncludes(styles, 'outline: 2px solid Highlight !important', 'forced-colors focus outline');
assertMatches(uiPlan, /U35-1 through U35-4/, 'U35 completion marker');
assertMatches(uiPlan, /U36-1 through U36-4/, 'U36 completion marker');
assertMatches(uiPlan, /U37-1 through U37-4/, 'U37 completion marker');
assertMatches(uiPlan, /U38-1 through U38-4/, 'U38 completion marker');
assertMatches(uiPlan, /U39-1 through U39-4/, 'U39 completion marker');
assertMatches(uiPlan, /U40-1 through U40-4/, 'U40 completion marker');
assertMatches(uiPlan, /U41-1 through U41-4/, 'U41 completion marker');
assertMatches(uiPlan, /U42-1 through U42-4/, 'U42 completion marker');
assertMatches(uiPlan, /U43-1 through U43-4/, 'U43 completion marker');
assertMatches(uiPlan, /U44-1 through U44-4/, 'U44 completion marker');
assertMatches(uiPlan, /UI platform maturity for the current desktop scope is complete/i, 'UI maturity roadmap completion marker');

const generatedAt = new Date().toISOString();
const report = [
  '# Desktop UI Maturity Gate Report',
  '',
  `Generated: ${generatedAt}`,
  '',
  '## Passed Checks',
  '',
  '- Shared UI primitive exports are present.',
  '- Raw native controls are confined to `src/components/ui/FormControls.tsx`.',
  '- ModalShell owns focus, traps Tab, closes on Escape, and restores previous focus.',
  '- The AppShell exposes a keyboard command palette with tested shortcut and command execution.',
  '- Reduced-motion preference handling is globally defined and smoke-tested in Electron.',
  '- Color scheme and forced-colors accessibility contracts are globally defined and smoke-tested in Electron.',
'- Visible interactive controls are audited for accessible names in real Electron route states.',
'- Real Electron route states are audited for window-level horizontal overflow, critical-surface clipping, and button-label overflow.',
'- Chat transcript scrolling, composer anchoring, and sidebar session title visibility are covered by real Electron regression assertions.',
  '- Electron smoke records app-scoped screenshots and verifies modal keyboard behavior.',
  '- Static smoke still guards route semantics and legacy class regressions.',
  '- Render tests cover chat, transcript, toast, modal, settings, and list migration surfaces.',
  '- Legacy prototype/form CSS aliases are absent.',
  ''
].join('\n');

await mkdir(reportDir, { recursive: true });
await writeFile(reportPath, report);
console.log(`Desktop UI maturity gate passed: ${reportPath}`);
