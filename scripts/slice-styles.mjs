#!/usr/bin/env node
/**
 * U46-1 — Slice the monolithic src/styles.css into ordered slice files.
 *
 * src/styles.css is a generational-override stylesheet: later sections (e.g.
 * "desktop workspace v2", "workspace chat-first overrides") deliberately
 * override earlier ones via source order. A semantic reorganization would
 * change the cascade, so this script slices STRICTLY at section boundaries
 * and preserves byte-exact order. Concatenating every slice in barrel order
 * reproduces the original file exactly.
 *
 * Run:
 *   node scripts/slice-styles.mjs           # dry-run: verify cuts are safe
 *   node scripts/slice-styles.mjs --apply   # write slice files + barrel
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stylesPath = resolve(repoRoot, 'src/styles.css');
const stylesDir = resolve(repoRoot, 'src/styles');
const apply = process.argv.includes('--apply');

// Each slice: { start (1-indexed, inclusive), file (relative to src/styles/) }.
// The next slice's start is the previous slice's end + 1. Boundaries were taken
// from the 13 section-divider comments plus the base/components split at the
// end of the `@media (forced-colors)` block (line 216).
const SLICES = [
  { start: 1, file: 'base/foundation.css' },
  { start: 217, file: 'components/primitives.css' },
  { start: 745, file: 'layers/01-app-shell.css' },
  { start: 4684, file: 'layers/02-macos-refinement.css' },
  { start: 4987, file: 'layers/03-desktop-container.css' },
  { start: 5128, file: 'layers/04-workbench-v1.css' },
  { start: 5605, file: 'layers/05-mac-window-fixes.css' },
  { start: 5806, file: 'layers/06-desktop-workspace-v2.css' },
  { start: 7352, file: 'layers/07-standalone-shell.css' },
  { start: 7441, file: 'layers/08-chat-first-overrides.css' },
  { start: 9612, file: 'layers/09-elevated-cards.css' },
  { start: 15016, file: 'layers/10-workbench.css' },
  { start: 15958, file: 'layers/11-dark-completion.css' },
  { start: 15972, file: 'layers/12-card-shell-fallback.css' }
];

const source = await readFile(stylesPath, 'utf8');
const lines = source.split('\n');
const totalLines = lines.length;

// Build segments. Lines are 1-indexed; lines[i] is line i+1.
const segments = SLICES.map((slice, index) => {
  const startLine = slice.start;
  const endLine = index + 1 < SLICES.length ? SLICES[index + 1].start - 1 : totalLines;
  // lines.slice is 0-indexed half-open: [startLine-1, endLine)
  const body = lines.slice(startLine - 1, endLine).join('\n');
  return { ...slice, startLine, endLine, body };
});

// --- Safety check 1: byte-exact reconstruction -----------------------------
const reconstructed = segments.map((s) => s.body).join('\n');
if (reconstructed !== source) {
  console.error('FAIL: reconstructed content does not match the original styles.css.');
  console.error(`  original length=${source.length} reconstructed length=${reconstructed.length}`);
  process.exit(1);
}

// --- Safety check 2: every segment has balanced braces ---------------------
let braceFailures = 0;
for (const segment of segments) {
  // Strip /* ... */ comments so braces inside comments do not skew the count.
  const withoutComments = segment.body.replace(/\/\*[\s\S]*?\*\//g, '');
  const opens = (withoutComments.match(/\{/g) ?? []).length;
  const closes = (withoutComments.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    braceFailures++;
    console.error(
      `FAIL: ${segment.file} (lines ${segment.startLine}-${segment.endLine}) has ` +
        `unbalanced braces: ${opens} '{' vs ${closes} '}' — cut is mid-rule.`
    );
  }
}
if (braceFailures > 0) {
  process.exit(1);
}

console.log(`OK: ${segments.length} segments reconstruct styles.css byte-for-byte; all brace-balanced.`);
for (const segment of segments) {
  const lineCount = segment.endLine - segment.startLine + 1;
  console.log(`  ${segment.file.padEnd(38)} lines ${segment.startLine}-${segment.endLine} (${lineCount})`);
}

if (!apply) {
  console.log('\nDry-run only. Pass --apply to write slice files + barrel.');
  process.exit(0);
}

// --- Apply: write slice files ----------------------------------------------
for (const segment of segments) {
  const outPath = resolve(stylesDir, segment.file);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, segment.body);
}

// --- Apply: write the barrel ------------------------------------------------
const barrel = [
  '/*',
  ' * Funplay stylesheet barrel.',
  ' *',
  ' * tokens.css must load first (slices consume --fp-* tokens). The layer',
  ' * imports below preserve the exact source order of the original',
  ' * src/styles.css — see scripts/slice-styles.mjs. Reordering these imports',
  ' * changes the CSS cascade and is a regression; only append new slices.',
  ' */',
  "@import './tokens.css';",
  "@import './base/foundation.css';",
  "@import './components/primitives.css';",
  ...SLICES.slice(2).map((s) => `@import './${s.file}';`),
  ''
].join('\n');
await writeFile(resolve(stylesDir, 'index.css'), barrel);

// --- Apply: remove the now-sliced monolith ---------------------------------
await rm(stylesPath);

console.log('\nApplied: wrote slice files, src/styles/index.css barrel, removed src/styles.css.');
console.log('Remember to update src/main.tsx to import ./styles/index.css.');
