import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(repoRoot, 'out/desktop-ui-smoke');
const reportPath = resolve(outDir, 'latest-report.md');

async function readRepoFile(path) {
  return readFile(resolve(repoRoot, path), 'utf8');
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

const appSource = await readRepoFile('src/App.tsx');
const modalSource = await readRepoFile('src/components/settings-modals.tsx');
const sidebarSource = await readRepoFile('src/components/layout/WorkspacePanels.tsx');
const projectSettingsSource = await readRepoFile('src/components/pages/ProjectSettingsPage.tsx');
const uiTestSource = await readRepoFile('tests/runtime/agent-ui-render.test.ts');
const uiPlan = await readRepoFile('docs/desktop-ui-improvement-plan.md');

assertIncludes(appSource, 'data-workspace-section={section}', 'workspace section marker');
assertIncludes(appSource, 'role="main"', 'workspace main role');
assertIncludes(modalSource, 'role="dialog"', 'modal dialog role');
assertIncludes(modalSource, 'aria-modal="true"', 'modal aria-modal');
assertIncludes(modalSource, 'data-modal-state="open"', 'modal open-state marker');
assertIncludes(sidebarSource, 'aria-current={props.activeNavId === item.id ? \'page\' : undefined}', 'workspace nav aria-current');
assertIncludes(projectSettingsSource, 'aria-current={props.tab === item.id ? \'page\' : undefined}', 'project settings aria-current');
assertMatches(uiTestSource, /workspace sidebar navigation marks the active section semantically/, 'workspace nav render test');
assertMatches(uiTestSource, /app settings modal is a semantic dialog/, 'modal render test');
assertMatches(uiPlan, /\| U5-1 \| Add a repeatable desktop UI smoke entry/, 'U5-1 plan row');

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
