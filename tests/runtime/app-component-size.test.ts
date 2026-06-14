import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * U47-6 — Component size ratchet.
 *
 * Large React components are hard to reason about and review. This gate caps
 * `.tsx` file size:
 *
 *  - New / already-small components must stay <= `DEFAULT_LIMIT` (600 lines).
 *  - The oversized files inherited from earlier UI generations are listed in
 *    `BASELINES` with their current line count. The test fails if any of them
 *    GROWS. As U47-1/U47-3/U47-4/U47-5 split these files, lower the matching
 *    baseline (or delete the entry once it drops under `DEFAULT_LIMIT`).
 *  - `App.tsx` additionally carries an explicit `APP_TARGET` (400) — the
 *    U47-1 decomposition goal — recorded here so the intent is visible.
 *
 * The ratchet only ever moves down; that is the whole point.
 */

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const srcDir = resolve(repoRoot, 'src');

const DEFAULT_LIMIT = 600;
const APP_TARGET = 400;

// Oversized .tsx files inherited before U47. Keys are paths relative to repo
// root. Lower a value when a split lands; never raise one.
const BASELINES: Record<string, number> = {
  // App.tsx: MCP/Unity plugin domain extracted into hooks/useMcpManager.ts (U47 slice);
  // formatQueuedPromptWithAttachments moved to lib/app-helpers.ts.
  // Claude runtime removal dropped handleImportClaudeSession and related wiring;
  // runtime-strategy selector removal dropped onChangeRuntimeStrategy + passthroughs;
  // UI-fix pass removed dead imports + sessionRuntimeId passdown;
  // G-refactor: clearSessionScopedState helper + useAssetGenerationProviders hook;
  // UI-rewrite phase 1: per-session composer state moved to sessionComposerStore (Zustand);
  // phase 2: app-shell navigation/lifecycle state moved to uiShellStore;
  // phase 3: project-domain state moved to projectStore;
  // phase 4: session-selection → sessionStore, engine/onboarding setup → engineSetupStore;
  // phase 5: AgentChatView reads composer state from the store (props removed);
  // phase 6: ProjectSettingsPage reads its tab nav from the ui-shell store;
  // phase 7: composer handlers (updateDraft/queuePrompt/removeQueuedPrompt) moved to store actions.
  'src/App.tsx': 1848,
  // ConversationMessage.tsx split into transcript/* modules by U47-3 — now 317 lines.
  // tool-activity.tsx split into tool/* modules by U47-4 — now 452 lines.
  // AgentChatView.tsx split into agent/* modules by U47-5 — now 371 lines.
  // ProjectSettingsPage.tsx split into project-settings/* modules — now 311 lines (under default limit).
  // Claude settings tab removed with the Claude runtime; Agent tab removed and
  // developer-mode toggle relocated into the Appearance tab.
  'src/components/modals/AppSettingsModal.tsx': 687
};

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsxFiles(entryPath));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(entryPath);
    }
  }
  return out;
}

function lineCount(filePath: string): number {
  // Count newline characters — matches `wc -l`, the source of the baselines.
  return readFileSync(filePath, 'utf8').split('\n').length - 1;
}

test('no .tsx component grows beyond its size ratchet', () => {
  const violations: string[] = [];
  for (const filePath of collectTsxFiles(srcDir)) {
    const relPath = relative(repoRoot, filePath);
    const lines = lineCount(filePath);
    const limit = BASELINES[relPath] ?? DEFAULT_LIMIT;
    if (lines > limit) {
      const kind = BASELINES[relPath] ? 'baseline' : 'default limit';
      violations.push(
        `${relPath}: ${lines} lines exceeds ${kind} ${limit}` +
          (BASELINES[relPath]
            ? ' (this file may only shrink — split it or lower the baseline)'
            : ' (split the component or extract subcomponents)')
      );
    }
  }
  assert.equal(violations.length, 0, `Component size ratchet exceeded:\n${violations.join('\n')}`);
});

test('oversized-file baselines stay in sync (no stale entries)', () => {
  const stale: string[] = [];
  for (const [relPath, baseline] of Object.entries(BASELINES)) {
    const lines = lineCount(resolve(repoRoot, relPath));
    if (lines < baseline) {
      stale.push(
        `${relPath}: actual ${lines} < baseline ${baseline} — lower the baseline to ${lines}` +
          (lines <= DEFAULT_LIMIT ? ' (or remove the entry; it is now under the default limit)' : '')
      );
    }
  }
  assert.equal(stale.length, 0, `Size baselines are stale — ratchet them down in this commit:\n${stale.join('\n')}`);
});

test('App.tsx records its U47-1 decomposition target', () => {
  // Informational: keeps the 400-line goal visible next to the live baseline.
  const lines = lineCount(resolve(repoRoot, 'src/App.tsx'));
  assert.ok(
    APP_TARGET < BASELINES['src/App.tsx'],
    'APP_TARGET should remain below the current App.tsx baseline until U47-1 lands'
  );
  assert.ok(lines > 0, 'App.tsx should exist and be non-empty');
});
