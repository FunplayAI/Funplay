#!/usr/bin/env node
/**
 * U45-2 dark override migration helper.
 *
 * Rewrites every `:root[data-theme='dark'] <selectorList> { <props> }` block in
 * src/styles.css to a zero-specificity `:where(<selectorList>) { <props> }` block
 * whose hardcoded dark values are swapped for `var(--fp-dark-*)` tokens. Light
 * mode is unaffected because `:where()` has 0,0,0,0 specificity — every
 * individual `.X { background: ... }` rule wins in light mode, and the
 * `:where()` fallback only activates where no other rule sets the property,
 * which in dark mode means the previously-hardcoded value (now token-driven)
 * gets applied.
 *
 * Run via:
 *   node scripts/migrate-dark-overrides.mjs            # dry-run, prints diff stats
 *   node scripts/migrate-dark-overrides.mjs --apply    # writes src/styles.css
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stylesPath = resolve(repoRoot, 'src/styles.css');
const apply = process.argv.includes('--apply');

// Map hardcoded dark value -> dark utility token reference. Order matters:
// longer / more-specific patterns first so substring overlaps don't misfire.
const VALUE_TO_TOKEN = [
  // shadows
  ['0 18px 44px rgba(0, 0, 0, 0.32)', 'var(--fp-dark-shadow-popover)'],

  // long composite values
  ['linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(11, 16, 32, 1))', 'var(--fp-workspace-shell-bg)'],

  // surface colors
  ['rgba(15, 23, 42, 0.96)', 'var(--fp-dark-surface-strong)'],
  ['rgba(15, 23, 42, 0.72)', 'var(--fp-dark-surface-overlay-3)'],
  ['rgba(15, 23, 42, 0.58)', 'var(--fp-dark-surface-overlay-2)'],
  ['rgba(15, 23, 42, 0.42)', 'var(--fp-dark-surface-overlay-1)'],
  ['rgba(255, 255, 255, 0.06)', 'var(--fp-dark-surface-glass)'],
  ['#111827', 'var(--fp-dark-surface)'],
  ['#0f172a', 'var(--fp-dark-surface-night)'],
  ['#020617', 'var(--fp-dark-surface-deep)'],

  // borders
  ['rgba(148, 163, 184, 0.18)', 'var(--fp-dark-border-strong)'],
  ['rgba(148, 163, 184, 0.16)', 'var(--fp-dark-border-default)'],
  ['rgba(148, 163, 184, 0.14)', 'var(--fp-elevated-card-border)'],
  ['rgba(148, 163, 184, 0.12)', 'var(--fp-dark-border-subtle)'],
  ['rgba(129, 140, 248, 0.28)', 'var(--fp-dark-border-accent)'],

  // text colors
  ['#e5e7eb', 'var(--fp-dark-text-primary)'],
  ['rgba(226, 232, 240, 0.72)', 'var(--fp-dark-text-secondary)'],
  ['rgba(226, 232, 240, 0.62)', 'var(--fp-dark-text-tertiary)'],
  ['rgba(226, 232, 240, 0.42)', 'var(--fp-dark-text-quaternary)'],
  ['#f8fafc', 'var(--fp-dark-text-bright)'],

  // accent
  ['rgba(129, 140, 248, 0.18)', 'var(--fp-dark-accent-soft-strong)'],
  ['rgba(129, 140, 248, 0.16)', 'var(--fp-dark-accent-soft)'],
  ['#c7d2fe', 'var(--fp-dark-accent-text)'],

  // feedback banners
  ['rgba(120, 53, 15, 0.18)', 'var(--fp-dark-warning-bg)'],
  ['rgba(245, 158, 11, 0.28)', 'var(--fp-dark-warning-border)'],
  ['#fcd34d', 'var(--fp-dark-warning-text)'],
  ['rgba(127, 29, 29, 0.24)', 'var(--fp-dark-error-bg)'],
  ['rgba(248, 113, 113, 0.32)', 'var(--fp-dark-error-border)'],
  ['#fecaca', 'var(--fp-dark-error-text)'],
  ['rgba(20, 83, 45, 0.24)', 'var(--fp-dark-success-bg)'],
  ['rgba(34, 197, 94, 0.24)', 'var(--fp-dark-success-border)'],
  ['#86efac', 'var(--fp-dark-success-text)'],
  ['rgba(99, 102, 241, 0.14)', 'var(--fp-dark-info-bg)'],
  ['#93c5fd', 'var(--fp-dark-info-text)'],
];

function tokenize(props) {
  let out = props;
  for (const [from, to] of VALUE_TO_TOKEN) {
    out = out.split(from).join(to);
  }
  return out;
}

const source = await readFile(stylesPath, 'utf8');

// Match each `:root[data-theme='dark'] <selectorList> { <props> }` block.
// Selector lists may span multiple lines and contain commas / pseudo-classes.
const blockRegex =
  /:root\[data-theme='dark'\]\s+([^{}]+?)\{([^{}]*)\}/g;

let migratedCount = 0;
const result = source.replace(blockRegex, (full, selectorList, body) => {
  // Split selectors on commas; each one may currently be prefixed with
  // `:root[data-theme='dark']` because the original cluster wrote one prefix
  // per selector on its own line. Strip the prefix from continuation entries.
  const cleanedSelectors = selectorList
    .split(',')
    .map((s) =>
      s
        .replace(/:root\[data-theme='dark'\]\s+/g, '')
        .trim()
    )
    .filter(Boolean);

  if (cleanedSelectors.length === 0) return full;

  // Skip the global root token-override block (`:root[data-theme='dark'] { ... }`)
  // — that one lives in tokens.css now but the @media forced-colors block in
  // styles.css still references `:root[data-theme='dark']` for token overrides.
  // The regex requires a selector after `:root[data-theme='dark']`, so the
  // unscoped `:root[data-theme='dark']` block is already excluded.

  migratedCount++;
  const indentedSelectors = cleanedSelectors.map((s) => `  ${s}`).join(',\n');
  const tokenizedBody = tokenize(body.trim());
  return `:where(\n${indentedSelectors}\n) {\n  ${tokenizedBody}\n}`;
});

const beforeCount = (source.match(/:root\[data-theme='dark'\]\s+[.\w]/g) ?? []).length;
const afterCount = (result.match(/:root\[data-theme='dark'\]\s+[.\w]/g) ?? []).length;
console.log(`Migrated ${migratedCount} dark blocks.`);
console.log(`Component-level :root[data-theme='dark'] selectors: ${beforeCount} -> ${afterCount}`);

if (apply) {
  await writeFile(stylesPath, result);
  console.log(`Wrote ${stylesPath}`);
} else {
  console.log('Dry-run only. Pass --apply to write changes.');
}
