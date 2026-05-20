# Design Tokens

Last updated: 2026-05-19

The Funplay desktop UI is driven by a single source of truth for color, spacing,
typography, elevation, motion, and sizing: **`src/styles/tokens.css`**. It is
imported from `src/main.tsx` before `src/styles.css`, so every token declaration
is available to every component rule.

This document is a reference for the token catalog. When `tokens.css` changes,
update this file in the same commit.

## Why tokens

- **One place to change a value.** A color or spacing step is defined once.
- **Theme by token, not by selector.** Dark mode overrides *token values* in a
  single `:root[data-theme='dark']` block. Component CSS never reads
  `[data-theme='dark']` directly — see [Dark theme](#dark-theme).
- **Auditable.** `tests/runtime/style-token-audit.test.ts` keeps `styles.css`
  hardcoded color / `px` counts under ratcheting baselines and confirms the
  token category set exists.

## Naming convention

```
--fp-{category}-{role}-{step?}
```

- `category` — `color`, `surface`, `text`, `border`, `accent`, `feedback`,
  `space`, `radius`, `shadow`, `z`, `duration`, `easing`, `control`, …
- `role` — the semantic use within the category (`primary`, `panel`, `success`).
- `step` — optional scale position (`50`, `600`, `1`, `xl`).

Two layers exist:

- **Raw scales** (`--fp-color-gray-600`) — the literal palette. Defined only in
  `tokens.css`.
- **Semantic tokens** (`--fp-surface-panel`, `--fp-text-primary`) — reference a
  raw scale and carry intent. Component CSS should prefer these.

## Raw color scales

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--fp-color-gray-25` | `#fafbfc` | | `--fp-color-indigo-50` | `#eef2ff` |
| `--fp-color-gray-50` | `#f5f6f8` | | `--fp-color-indigo-100` | `#e0e7ff` |
| `--fp-color-gray-100` | `#ecedf2` | | `--fp-color-indigo-200` | `#c7d2fe` |
| `--fp-color-gray-150` | `#e5e7eb` | | `--fp-color-indigo-300` | `#a5b4fc` |
| `--fp-color-gray-200` | `#d4d8e0` | | `--fp-color-indigo-400` | `#818cf8` |
| `--fp-color-gray-300` | `#b4bac6` | | `--fp-color-indigo-500` | `#6366f1` |
| `--fp-color-gray-400` | `#8f97a6` | | `--fp-color-indigo-600` | `#4f46e5` |
| `--fp-color-gray-500` | `#69707d` | | `--fp-color-indigo-700` | `#4338ca` |
| `--fp-color-gray-600` | `#4a5160` | | `--fp-color-indigo-800` | `#3730a3` |
| `--fp-color-gray-700` | `#2f3542` | | `--fp-color-indigo-900` | `#312e81` |
| `--fp-color-gray-800` | `#1f2430` | | `--fp-color-slate-700` | `#182235` |
| `--fp-color-gray-900` | `#151923` | | `--fp-color-slate-800` | `#111827` |
| `--fp-color-gray-950` | `#0b1020` | | `--fp-color-slate-900` | `#0f172a` |

Feedback hues (`50 / 100 / 300 / 500 / 600 / 700` steps):

| Hue | Role | 600 step |
|---|---|---|
| `--fp-color-emerald-*` | success | `#16a34a` |
| `--fp-color-amber-*` | warning | `#d97706` |
| `--fp-color-rose-*` | danger | `#dc2626` |

## Semantic colors

Semantic tokens are what component CSS should consume. Each carries a light
value and (where it changes) a dark override.

| Token | Light | Dark |
|---|---|---|
| `--fp-surface-bg` | `gray-50` | `slate-900` |
| `--fp-surface-panel` | `#ffffff` | `slate-800` |
| `--fp-surface-panel-muted` | `#f7f8fb` | `slate-700` |
| `--fp-surface-overlay` | `rgba(255,255,255,0.82)` | `rgba(15,23,42,0.58)` |
| `--fp-surface-body-fill` | `gray-50` | `gray-950` |
| `--fp-text-primary` | `#15171d` | `#e5e7eb` |
| `--fp-text-secondary` | `gray-500` | `#a6b0c2` |
| `--fp-text-tertiary` | `gray-400` | `#7d8798` |
| `--fp-text-inverse` | `#ffffff` | `#ffffff` |
| `--fp-border-default` | `gray-150` | `rgba(148,163,184,0.18)` |
| `--fp-border-strong` | `gray-200` | `rgba(148,163,184,0.28)` |
| `--fp-border-subtle` | `rgba(148,163,184,0.12)` | (same) |
| `--fp-accent-primary` | `indigo-600` | (same) |
| `--fp-accent-primary-strong` | `indigo-700` | (same) |
| `--fp-accent-primary-soft` | `rgba(79,70,229,0.12)` | `rgba(129,140,248,0.18)` |
| `--fp-feedback-success` | `emerald-600` | (same) |
| `--fp-feedback-warning` | `amber-600` | (same) |
| `--fp-feedback-danger` | `rose-600` | (same) |
| `--fp-feedback-info` | `indigo-500` | (same) |

## Spacing

Base-4 scale. Use for padding, margin, and gap.

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--fp-space-1` | `4px` | | `--fp-space-5` | `20px` |
| `--fp-space-2` | `8px` | | `--fp-space-6` | `24px` |
| `--fp-space-3` | `12px` | | `--fp-space-7` | `32px` |
| `--fp-space-4` | `16px` | | `--fp-space-8` | `48px` |

## Typography

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--fp-text-xs` | `11px` | | `--fp-text-md` | `14px` |
| `--fp-text-sm` | `12px` | | `--fp-text-lg` | `16px` |
| `--fp-text-base` | `13px` | | `--fp-text-xl` | `20px` |

Line heights: `--fp-leading-tight` `1.2`, `--fp-leading-snug` `1.35`,
`--fp-leading-normal` `1.5`, `--fp-leading-loose` `1.7`.

## Radius

| Token | Value |
|---|---|
| `--fp-radius-sm` | `6px` |
| `--fp-radius-md` | `8px` |
| `--fp-radius-lg` | `10px` |
| `--fp-radius-xl` | `12px` |

## Shadow

Elevation layers, low to high.

| Token | Value |
|---|---|
| `--fp-shadow-1` | `0 1px 2px rgba(15,23,38,0.06)` |
| `--fp-shadow-2` | `0 4px 10px rgba(15,23,38,0.08)` |
| `--fp-shadow-3` | `0 8px 20px rgba(15,23,38,0.12)` |
| `--fp-shadow-4` | `0 16px 40px rgba(15,23,38,0.16)` |
| `--fp-shadow-5` | `0 24px 60px rgba(15,23,38,0.22)` (dark: `…rgba(0,0,0,0.36)`) |

## Z-index

| Token | Value | Use |
|---|---|---|
| `--fp-z-base` | `0` | default flow |
| `--fp-z-raised` | `10` | raised cards |
| `--fp-z-overlay` | `100` | sticky overlays |
| `--fp-z-dropdown` | `200` | menus, popovers |
| `--fp-z-modal` | `300` | dialogs |
| `--fp-z-toast` | `400` | notifications |

## Motion

| Duration | Value | | Easing | Curve |
|---|---|---|---|---|
| `--fp-duration-instant` | `0ms` | | `--fp-easing-standard` | `cubic-bezier(0.2,0,0,1)` |
| `--fp-duration-fast` | `100ms` | | `--fp-easing-emphasized` | `cubic-bezier(0.3,0,0.8,0.15)` |
| `--fp-duration-base` | `160ms` | | `--fp-easing-decelerate` | `cubic-bezier(0,0,0,1)` |
| `--fp-duration-slow` | `260ms` | | `--fp-easing-accelerate` | `cubic-bezier(0.3,0,1,1)` |

The `prefers-reduced-motion` contract (Phase U39) neutralizes animation duration
globally; motion tokens still describe intent for non-reduced contexts.

## Control sizing

| Token | Value |
|---|---|
| `--fp-control-height` | `38px` |
| `--fp-control-height-sm` | `32px` |
| `--fp-focus-ring` | `0 0 0 4px var(--fp-accent-primary-soft)` |
| `--fp-chat-column-width` | `1040px` |

## Component-role tokens

Beyond the foundational scales, `tokens.css` defines theme-aware tokens scoped
to specific surfaces — command palette, titlebar, project tabs, workspace
shell, modal close, app-settings panels, elevated cards, and more. Each has a
light value in `:root` and a dark value in `:root[data-theme='dark']`. They
exist so a component can flip with the theme without its rule ever reading
`[data-theme='dark']`. See the `Component-role tokens` section of `tokens.css`
for the full list.

## Dark utility tokens

The `--fp-dark-*` family (surface / border / text / accent / feedback / shadow)
is scaffolding for the `:where()` fallback rules introduced in Phase U45-2e.
In light mode each resolves to `transparent` or `inherit` (a no-op, so
individual light rules win); in dark mode it flips to the intended dark value.
This is how the former 562-selector `:root[data-theme='dark']` bottom cluster
in `styles.css` was eliminated without per-component light rewrites.

## Dark theme

Dark mode is **token-value override only**. The `:root[data-theme='dark']`
block in `tokens.css` reassigns token values; it never targets a component
selector. Component CSS reacts to the theme purely by consuming tokens.

```css
/* tokens.css */
:root              { --fp-surface-panel: #ffffff; }
:root[data-theme='dark'] { --fp-surface-panel: var(--fp-color-slate-800); }

/* styles.css — no [data-theme='dark'] anywhere */
.some-panel { background: var(--fp-surface-panel); }
```

When a component needs a value that differs in dark but has no obvious light
equivalent, use a zero-specificity `:where()` rule referencing an `--fp-dark-*`
token (see [Dark utility tokens](#dark-utility-tokens)).

The desktop UI smoke (`npm run ui:smoke`) **fails the build** if a
`:root[data-theme='dark'] .selector` component override appears in `styles.css`.

## Backward-compat aliases

Legacy names (`--bg`, `--panel`, `--brand`, `--line`, `--text`, `--text-soft`,
`--ui-radius-*`, …) remain defined in `tokens.css` as aliases that point at
`--fp-*` tokens, so older component CSS keeps working during migration.

**Do not use alias names in new code.** Reference `--fp-*` tokens directly. An
alias may be removed once `rg` confirms zero usages outside `tokens.css`.

## Adding or changing a token

1. Edit `src/styles/tokens.css` — add to `:root`, and to
   `:root[data-theme='dark']` if the value changes with the theme.
2. Update this document in the same commit.
3. Run `npm run test:runtime` — `style-token-audit.test.ts` checks the category
   set and the hardcoded-value ratchet.
4. If a migration removed hardcoded colors/`px` from `styles.css`, lower the
   corresponding baseline constant in `style-token-audit.test.ts`.
