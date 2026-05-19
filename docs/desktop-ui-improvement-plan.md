# Desktop UI Improvement Plan

Last updated: 2026-05-11

## Goal

Move the desktop app from feature-complete engineering UI toward a clearer product UI:

- Make global settings, project settings, and current session settings feel distinct.
- Keep the chat surface focused on Agent collaboration.
- Move runtime history, recovery, verification, and tool quality into an explicit Agent Runs surface.
- Keep Provider setup approachable for normal users while preserving advanced protocol controls.
- Reduce visual drift across cards, segmented controls, rows, chips, and settings panels.

## Progress Legend

- Planned
- In progress
- Completed
- Deferred

## Phase U1: Project Settings Information Architecture

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U1-1 | Write the next UI route as an executable plan. | Completed | Added this plan so UI work can move in small verified batches. | Document review |
| U1-2 | Split Agent run history and recovery out of token Usage. | Completed | Added a dedicated Project Settings `Agent Runs` tab for run overview, recovery, verification, tool quality, and recent run history; Usage now focuses on token and provider/model statistics. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U1-3 | Clarify settings scope hierarchy. | Completed | Project Agent settings now show the Global Default -> Project Default -> Current Session precedence with effective provider/model/runtime/mode values. App Agent settings now label its controls as global defaults and points to project/session overrides. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |

## Phase U2: Provider Setup Productization

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U2-1 | Convert Provider setup into preset-first cards. | Completed | Provider cards now show channel, API mode, default model, base URL, API key state, auth style, enabled/default status, and actions. The editor now starts with provider preset cards, keeps name/base URL/API key/model in core configuration, and moves protocol/API mode/auth/headers/env controls into Advanced Protocol Configuration. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U2-2 | Add provider diagnostics as direct repair copy. | Completed | Runtime Doctor now renders a suggested repair order that maps common provider findings to direct actions for auth, API mode, model ID, base URL/network, tool-calling compatibility, quota/rate limits, and default provider state before the raw probe details. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |

## Phase U3: Workspace Product Polish

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U3-1 | Add a concise project status header. | Completed | Agent workspace now has a compact project status bar showing current provider, model, Build/Plan mode, run state, file-change count, and next action before the chat surface. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U3-2 | Normalize card/row/chip visual density. | Completed | Added shared UI density/radius tokens and applied them across provider cards, provider preset cards, app/project setting controls, Agent Runs metrics, runtime doctor guidance, and the Agent workspace status/changes surfaces. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U3-3 | Run desktop walkthrough checks. | Completed | Launched the Electron dev app and used Computer Use state capture to verify the Agent workspace status bar, Project Settings navigation, Assets page state, and App Settings modal state. The walkthrough confirmed the status header is present and does not block chat composer access. | `npm run dev`; Computer Use app-state walkthrough |

## Phase U4: Navigation And Modal Visual QA

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U4-1 | Make workspace navigation visually deterministic across Agent, Project Settings, and Assets. | Completed | Workspace content now exposes `role="main"`, a localized route label, and `data-workspace-section`; sidebar and Project Settings navigation mark the active route with `aria-current="page"`. The desktop walkthrough showed the React/accessibility state switching correctly, while Computer Use screenshots can lag one visual frame. | `tests/runtime/agent-ui-render.test.ts`; `npm run dev`; Computer Use app-state walkthrough |
| U4-2 | Verify App Settings modal visibly overlays the current workspace and keeps Provider setup reachable. | Completed | App Settings now renders through a semantic `role="dialog"` modal with `aria-modal`, labelled title/subtitle ids, and explicit open-state marker; Provider settings can be opened directly and are covered by static render tests. | `tests/runtime/agent-ui-render.test.ts`; `npm run dev`; Computer Use app-state walkthrough |
| U4-3 | Check Project Settings Agent and Provider flows at compact desktop sizes. | Completed | Added compact-window layout rules that turn App Settings and Project Settings sidebars into horizontal scrolling category rails, shrink modal padding, and collapse Provider preset/role-model grids to one column. | CSS review; `tests/runtime/agent-ui-render.test.ts` |
| U4-4 | Keep UI route progress synchronized with automated render tests. | Completed | Added focused renderer tests for active workspace navigation semantics, selected Project Settings page rendering, and App Settings Provider modal state. | `tests/runtime/agent-ui-render.test.ts` |

## Phase U5: Daily Workflow Ergonomics

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U5-1 | Add a repeatable desktop UI smoke entry for route and modal verification. | Completed | Added `npm run ui:smoke`, which verifies route/modal semantic markers, checks matching render-test coverage, and writes an Electron-only walkthrough report that explicitly rejects whole-desktop screenshots as route proof. | `npm run ui:smoke` |
| U5-2 | Make the empty chat state useful for first action selection. | Completed | Empty conversations now show compact task starters for continuing work, organizing assets, running verification, and planning first. Selecting one writes the prompt into the composer for review before sending. | `tests/runtime/agent-ui-render.test.ts` |
| U5-3 | Improve Assets/File discovery when projects have folders but no generated assets. | Completed | Assets empty state now shows scanned folder/file counts, recognized asset count, detected asset directories, and suggested asset folders when no resource directories exist yet. | `tests/runtime/agent-ui-render.test.ts` |
| U5-4 | Keep the next UI batch synchronized with render tests and roadmap audit. | Completed | Added static render coverage for actionable chat empty state and Assets discovery hints; P29 is completed only after this route has test coverage. | `tests/runtime/agent-ui-render.test.ts`; `npm run agent:roadmap-audit` |

## Phase U6: Real Window Regression Loop

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U6-1 | Add an app-scoped Electron UI regression smoke. | Completed | Added `npm run ui:electron-smoke`, which launches a real Electron `BrowserWindow` against the built renderer with a controlled preload API, verifies Agent/Project Settings/Assets/App Settings Provider states through DOM semantics, captures only `BrowserWindow.capturePage()` screenshots, and writes `out/desktop-ui-electron-smoke/latest-report.md`. | `npm run ui:electron-smoke` |
| U6-2 | Cover long-task chat UI states in deterministic render tests. | Completed | Added a long-task transcript fixture covering streaming reply text, completed/running/failed tools, changed-file and edit metadata, permission waiting, user-input waiting, failed stage recovery actions, and pseudo-tool text exclusion. | `tests/runtime/agent-ui-render.test.ts` |
| U6-3 | Verify Provider setup as an end-to-end settings flow. | Completed | Static render tests now cover default-provider state, diagnostic actions, and advanced protocol collapse; the Electron smoke opens App Settings Provider, verifies the default Xiaomi MiMo channel, opens Add Provider, selects the Xiaomi MiMo preset, and checks core Base URL/model plus closed advanced protocol state. | `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U6-4 | Verify file tree, Assets, and inspector handoff. | Completed | Static render tests now cover empty directory rendering and inspector handoff state. The Electron smoke includes empty asset directories plus a previewable `assets/images/player.png`, verifies the Assets card, clicks it, and asserts the right inspector opens the matching project path. | `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U6-5 | Add compact-window assertions to the UI smoke gate. | Completed | `npm run ui:electron-smoke` now resizes the real Electron window to 840x640, asserts App Settings collapses to a single-column layout with advanced Provider settings still closed, Project Settings switches to a horizontal category rail, and the Agent composer remains visible without window clipping. | `npm run ui:electron-smoke` |

## Current Batch

Completed U1-1 through U1-3, U2-1 through U2-2, U3-1 through U3-3, U4-1 through U4-4, U5-1 through U5-4, and U6-1 through U6-5. U6 is complete.

Verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run test:runtime`
- `npm run agent:roadmap-audit`
- `npm run agent:benchmark`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `git diff --check`
- Secret scan for provider/API key patterns found only redacted docs placeholders and fake test keys.
