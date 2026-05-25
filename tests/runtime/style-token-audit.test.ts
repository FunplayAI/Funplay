import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * U45-3 — Design token audit.
 *
 * Guards the token system established in U45-1/U45-2:
 *  1. `src/styles/tokens.css` defines the full token category set.
 *  2. `src/styles.css` consumes tokens — its hardcoded color and `px` counts
 *     are held under ratcheting baselines so new code cannot reintroduce
 *     hardcoded theme values. As U46 slices CSS and migrates rules to tokens,
 *     lower the baselines in the same commit (the test only fails on INCREASE).
 *  3. Raw `--fp-color-*` scale tokens live only in `tokens.css`.
 *  4. `styles.css` contains zero component-level `:root[data-theme='dark']`
 *     overrides (the U45-2 end state; also enforced by the UI smoke gate).
 */

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tokensCss = readFileSync(resolve(repoRoot, 'src/styles/tokens.css'), 'utf8');

// U46-1 sliced src/styles.css into src/styles/base, components, layers. The
// concatenation of those slices (excluding tokens.css and the index.css barrel)
// equals the former monolithic styles.css, so the ratchet baselines below stay
// comparable across the slice boundary.
function readSlicedStyles(dir = resolve(repoRoot, 'src/styles')): string {
  const parts: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      parts.push(readSlicedStyles(entryPath));
    } else if (entry.name.endsWith('.css') && entry.name !== 'tokens.css' && entry.name !== 'index.css') {
      parts.push(readFileSync(entryPath, 'utf8'));
    }
  }
  return parts.join('\n');
}

const stylesCss = readSlicedStyles();

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
const PX_PATTERN = /\b[0-9.]+px\b/g;

// Ratchet baselines — the audit fails when a count exceeds these. Lower them
// (never raise them) whenever a batch migrates hardcoded values to tokens.
const HARDCODED_COLOR_BASELINE = 1257;
const PX_BASELINE = 2887;

test('tokens.css defines the full design token category set', () => {
  const requiredTokens = [
    // raw color scales
    '--fp-color-gray-50',
    '--fp-color-gray-950',
    '--fp-color-indigo-600',
    '--fp-color-emerald-600',
    '--fp-color-amber-600',
    '--fp-color-rose-600',
    // semantic surface / text / border / accent / feedback
    '--fp-surface-bg',
    '--fp-surface-panel',
    '--fp-text-primary',
    '--fp-text-secondary',
    '--fp-border-default',
    '--fp-border-strong',
    '--fp-accent-primary',
    '--fp-feedback-success',
    // spacing
    '--fp-space-1',
    '--fp-space-8',
    // typography
    '--fp-text-xs',
    '--fp-text-xl',
    '--fp-leading-tight',
    '--fp-leading-loose',
    // radius / shadow / z
    '--fp-radius-sm',
    '--fp-radius-xl',
    '--fp-shadow-1',
    '--fp-shadow-5',
    '--fp-z-base',
    '--fp-z-toast',
    // motion
    '--fp-duration-fast',
    '--fp-duration-slow',
    '--fp-easing-standard',
    '--fp-easing-emphasized'
  ];
  for (const token of requiredTokens) {
    assert.ok(
      tokensCss.includes(`${token}:`),
      `tokens.css must define ${token}`
    );
  }
});

test('tokens.css defines a dark theme token-override block', () => {
  assert.match(
    tokensCss,
    /:root\[data-theme='dark'\]\s*\{/,
    "tokens.css must define a :root[data-theme='dark'] block that flips token values"
  );
  // The dark block must override semantic tokens, not redefine raw scales.
  assert.ok(
    tokensCss.includes('--fp-surface-bg: var(--fp-color-slate-900)'),
    'dark theme should override semantic surface tokens with raw scale values'
  );
});

test('styles.css hardcoded color count stays at or below the ratchet baseline', () => {
  const matches = stylesCss.match(COLOR_PATTERN) ?? [];
  assert.ok(
    matches.length <= HARDCODED_COLOR_BASELINE,
    `src/styles.css has ${matches.length} hardcoded colors, exceeding the ratchet baseline of ${HARDCODED_COLOR_BASELINE}. ` +
      'New theme-aware colors must reference an --fp-* token from src/styles/tokens.css. ' +
      `If you migrated colors to tokens, lower HARDCODED_COLOR_BASELINE to ${matches.length}.`
  );
});

test('styles.css px-literal count stays at or below the ratchet baseline', () => {
  const matches = stylesCss.match(PX_PATTERN) ?? [];
  assert.ok(
    matches.length <= PX_BASELINE,
    `src/styles.css has ${matches.length} px literals, exceeding the ratchet baseline of ${PX_BASELINE}. ` +
      'New spacing/sizing should reference --fp-space-* or --fp-radius-* tokens. ' +
      `If you migrated px literals to tokens, lower PX_BASELINE to ${matches.length}.`
  );
});

test('raw --fp-color-* scale tokens are defined only in tokens.css', () => {
  const rawScaleDefinition = /--fp-color-(?:gray|slate|indigo|emerald|amber|rose)-\d+\s*:/;
  assert.ok(
    !rawScaleDefinition.test(stylesCss),
    'src/styles.css must not define raw --fp-color-* scale tokens; they belong in src/styles/tokens.css'
  );
});

test('styles.css contains no component-level dark theme overrides', () => {
  const darkComponentOverrides = stylesCss.match(/:root\[data-theme='dark'\]\s+[.\w]/g) ?? [];
  assert.equal(
    darkComponentOverrides.length,
    0,
    `src/styles.css must not contain component-level :root[data-theme='dark'] overrides ` +
      `(found ${darkComponentOverrides.length}). Theme-dependent styling flows through tokens in tokens.css.`
  );
});

test('agent user input option buttons keep answer text left aligned', () => {
  const normalized = stylesCss.replace(/\s+/g, ' ');
  assert.match(
    normalized,
    /\.agent-user-input-options button \{[^}]*justify-content: stretch;[^}]*justify-items: stretch;[^}]*text-align: left;/,
    'pending user input option buttons must override shared centered button layout'
  );
  assert.match(
    normalized,
    /\.agent-user-input-options \.fp-button-label \{[^}]*width: 100%;[^}]*justify-items: start;[^}]*text-align: left;/,
    'pending user input option labels must fill the row and align text from the left'
  );
});
