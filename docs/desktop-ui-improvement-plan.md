# Desktop UI Improvement Plan

Last updated: 2026-05-18

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

Completed U1-1 through U1-3, U2-1 through U2-2, U3-1 through U3-3, U4-1 through U4-4, U5-1 through U5-4, U6-1 through U6-5, U7-1 through U7-5, U8-1 through U8-5, U9-1 through U9-5, U10-1 through U10-5, U11-1 through U11-5, U12-1 through U12-5, U13-1 through U13-5, U14-1 through U14-5, U15-1 through U15-4, U16-1 through U16-4, U17-1 through U17-5, U18-1 through U18-4, U19-1 through U19-5, U20-1 through U20-4, U21-1 through U21-4, U22-1 through U22-4, U23-1 through U23-4, U24-1 through U24-4, U25-1 through U25-4, U26-1 through U26-4, U27-1 through U27-4, U28-1 through U28-4, U29-1 through U29-4, U30-1 through U30-4, U31-1 through U31-4, U32-1 through U32-4, U33-1 through U33-4, U34-1 through U34-4, U35-1 through U35-4, U36-1 through U36-4, U37-1 through U37-4, U38-1 through U38-4, U39-1 through U39-4, U40-1 through U40-4, U41-1 through U41-4, U42-1 through U42-4, U43-1 through U43-4, and U44-1 through U44-4. UI platform maturity for the current desktop scope is complete, including the global command surface, shared dialog focus contract, reduced-motion contract, high-contrast forced-colors contract, real-window interactive accessibility audit, real-window layout stability audit, and real-window chat/session/composer regression coverage.

## Next Route (U45-U52)

After UI platform maturity, the next desktop UI route targets the remaining systemic risks surfaced by repo measurement: a 16k-line single stylesheet with ~60 design tokens and 30+ ad-hoc namespaces, a 2,232-line `App.tsx` with 65 hooks, three 700-1,400 line chat components, an inline `localize(language, zh, en)` i18n path with no key catalog, "engineering panel" presentation for Agent Runs / Token Usage / Runtime Doctor / Permission Audits, and the absence of pixel-level visual regression coverage. The route is sequenced as U45 design token centralization, U46 CSS slicing and scoping, U47 App composition and state layering, U48 i18n engineering, U49 desktop native affordances, U50 diagnostics productization, U51 visual regression baseline, and U52 motion and density tokens. P0 priority is U45 + U46 + U47; the rest depend on those three to land cleanly.

## Phase U7: Component System Foundation

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U7-1 | Select the UI component foundation for the desktop client. | Completed | Chose Base UI primitives plus Funplay-owned styling because the app needs an Electron Agent workbench aesthetic, React 19 compatibility, accessibility, keyboard-safe overlays, and gradual migration without Tailwind lock-in. | Component library research; npm metadata check |
| U7-2 | Add the first UI platform dependencies. | Completed | Added Base UI as the headless primitive layer, lucide-react for command icons, react-resizable-panels for workbench panes, cmdk for future command palette, and TanStack Virtual for long chat/file/tool lists. | `npm install`; `npm run build` |
| U7-3 | Create `src/components/ui` wrappers and design tokens. | Completed | Added Funplay-owned Button, IconButton, Select, Switch, TextField, Badge, Surface, MetricTile, and shared class composition helpers with global control/surface tokens. | `npm run build`; `tests/runtime/agent-ui-render.test.ts` |
| U7-4 | Migrate Web Search settings as the first real page. | Completed | Web Search settings now uses the new component system for command buttons, provider/cache selects, API key fields, switches, metrics, and quality report state. | `npm run build`; `tests/runtime/agent-ui-render.test.ts`; `npm run ui:smoke` |
| U7-5 | Prepare the next migration order. | Completed | Next batches should migrate Provider Settings, MCP Management, App Settings modal chrome, then Agent Chat composer/tool groups. | Document review |

## Phase U8: Provider Settings Component Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U8-1 | Add a focused Provider Settings migration batch. | Completed | Scoped this batch to Provider settings cards, diagnostics actions, and Provider editor action buttons before touching MCP or Agent Chat. | Document review |
| U8-2 | Migrate Provider Settings cards to shared UI primitives. | Completed | Replaced ad hoc prototype buttons/status tags with shared Button, Badge, and Surface components while preserving existing provider data layout. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U8-3 | Migrate Runtime Doctor actions and status display. | Completed | Runtime Doctor now uses shared buttons and badges for diagnostic commands, severity state, and repair actions. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U8-4 | Migrate Provider editor modal actions. | Completed | Provider editor Save/Cancel now use shared Button while leaving the high-density advanced form layout intact for a later form-control pass. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U8-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U9: MCP Management Component Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U9-1 | Add a focused MCP Management migration batch. | Completed | Scoped this batch to project/global MCP settings actions, server row controls, and diagnostic actions before touching MCP modal form internals. | Document review |
| U9-2 | Migrate project MCP management actions and row controls. | Completed | Replaced project MCP header/runtime actions and per-server edit/delete/toggle controls with shared Button, IconButton, and ToggleSwitch components. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U9-3 | Migrate global MCP registry actions and row controls. | Completed | Used the same shared primitives in the global registry page so project/global MCP management stays visually consistent. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U9-4 | Migrate raw diagnostic send action. | Completed | Raw Diagnostics now uses the shared Button component while keeping method and JSON inputs stable for this batch. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U9-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U10: App Settings Modal Chrome Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U10-1 | Add a focused App Settings chrome migration batch. | Completed | Scoped this batch to modal navigation, global Agent controls, and high-frequency action buttons before touching Memory and notification list internals. | Document review |
| U10-2 | Migrate App Settings navigation and modal close affordance. | Completed | Replaced plain text category rows and the raw close button with shared icon/button primitives while preserving semantic dialog and `aria-current` state. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U10-3 | Migrate global appearance, language, and Agent controls. | Completed | Theme/language/runtime/mode choices now use shared Button styling, and developer mode uses the shared SwitchField component. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U10-4 | Migrate App Settings high-frequency action buttons. | Completed | Replaced Claude refresh/login/import, Memory refresh/save/clear, notification refresh/cancel, and update actions with shared Button variants. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U10-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U11: Agent Chat Composer And Tool Group Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U11-1 | Add a focused Agent Chat migration batch. | Completed | Scoped this batch to composer controls, running status affordances, and tool group headers before changing transcript virtualization or message persistence. | Document review |
| U11-2 | Migrate composer command controls to shared UI primitives. | Completed | Composer attachment, permission, provider, send, queued prompt, slash-menu upload, and provider menu actions now use shared Button/IconButton affordances where appropriate. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U11-3 | Migrate running status and task checklist controls. | Completed | Running status stop action, permission confirmation actions, user-input options, and submit/cancel controls now use shared Button density while preserving the existing animation and task checklist layout. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U11-4 | Migrate tool group headers and compact actions. | Completed | Live/completed tool group headers and compact media result actions now use shared Button variants without adding detail drawers back. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U11-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U12: Workspace Controls Component Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U12-1 | Add a focused workspace controls migration batch. | Completed | Scoped this batch to file tree, inspector, HTML preview, Assets controls, and lightweight project navigation actions without touching runtime orchestration. | Document review |
| U12-2 | Migrate file tree and inspector action controls. | Completed | Project navigation, file search, file tree folder/file rows, inspector close/reset/save, source/preview tabs, and HTML preview mode tabs now use shared Button/IconButton variants while keeping dense file browsing behavior. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U12-3 | Migrate preview and asset action controls. | Completed | HTML dev preview start/stop, binary/PDF/document open/reveal actions, and Assets category tabs now use shared Button variants. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U12-4 | Reduce legacy `prototype-*` action usage in U12-scoped workspace surfaces. | Completed | Removed old prototype button usage from `WorkspacePanels`, `file-preview-components`, and Assets category controls; larger surfaces such as Onboarding, Skills, and session-change modals stay for later batches. | `rg "prototype-(primary|secondary|danger|ghost)" src/components/layout/WorkspacePanels.tsx src/components/layout/file-preview-components.tsx src/components/pages/AssetsPage.tsx`; `npm run build` |
| U12-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U13: Project Workflow Action Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U13-1 | Add a focused project workflow action migration batch. | Completed | Scoped this batch to Skills, Agent Runs recovery, current-run changes, checkpoint restore/delete confirmations, and MCP plugin save/cancel actions. | Document review |
| U13-2 | Migrate Skills action controls to shared UI primitives. | Completed | Filesystem registry refresh, catalog sync/import/edit, custom Skill save/cancel, and project Skill enable/edit/delete actions now use shared Button variants with lucide icons. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U13-3 | Migrate recovery and destructive modal actions. | Completed | Current-run restore/close, restore checkpoint confirmation, delete project confirmation, Agent Runs resume, and current-session model actions now use shared Button/IconButton controls. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U13-4 | Migrate MCP plugin modal submit actions. | Completed | MCP plugin Save/Cancel now use shared Button variants while keeping the dense transport and policy form unchanged for a later form-control pass. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U13-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U14: Welcome And Onboarding Action Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U14-1 | Add a focused Welcome and Onboarding action migration batch. | Completed | Scoped this batch to app entry actions, project setup wizard footer actions, environment-check actions, and browse/back/next controls. | Document review |
| U14-2 | Migrate Welcome entry actions to shared controls. | Completed | Create, open existing, and recent-project open actions now use shared Button variants with lucide icons while keeping recent project rows as custom list buttons. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U14-3 | Migrate Onboarding wizard action controls. | Completed | Setup footer, browse, environment actions, step navigation, environment completion, and final enter/adjust controls now use shared Button variants. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U14-4 | Add render coverage for onboarding branches. | Completed | Static render tests now cover Welcome plus Onboarding setup, environment, and completion branches and reject legacy `prototype-*` action classes. | `tests/runtime/agent-ui-render.test.ts` |
| U14-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U15: Shared Card Surface Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U15-1 | Add a focused shared card surface migration batch. | Completed | Scoped this batch to the reusable `Card` shell used across Project Settings and MCP panels, without changing page-specific card layouts. | Document review |
| U15-2 | Migrate `Card` away from legacy `prototype-card` markup. | Completed | `InfoComponents.Card` now renders the shared `Surface` primitive with `fp-info-card` title/body classes, preserving existing density and visual styling. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U15-3 | Add render coverage for the shared card shell. | Completed | Project Usage and Agent Runs render tests now assert `fp-info-card` and reject `prototype-card` markup. | `tests/runtime/agent-ui-render.test.ts` |
| U15-4 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U16: Shell Modal And List Naming Cleanup

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U16-1 | Add a focused shell/modal/list naming cleanup batch. | Completed | Scoped this batch to the remaining `prototype-*` class names emitted by React components, while preserving CSS aliases during the transition. | Document review |
| U16-2 | Rename component-emitted shell, modal, and list classes. | Completed | App shells now emit `fp-app-shell`, modal shells emit `fp-modal`, and shared lists emit `fp-info-list`; CSS selectors include the new names and retain old aliases for safety. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U16-3 | Add render coverage for shell and modal naming. | Completed | Static render tests now assert `fp-app-shell` and `fp-modal`, and reject `prototype-shell`/`prototype-modal` in rendered markup. | `tests/runtime/agent-ui-render.test.ts` |
| U16-4 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U17: Project Form Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U17-1 | Add shared form primitives for project UI migration. | Completed | Extended the shared form layer with wrapper class support, `TextAreaField`, and `CheckboxField`, matching the existing `fp-field`/control styling. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U17-2 | Migrate Project Skills form controls. | Completed | Custom Skill name, trigger, description, instructions, and enabled toggle now use shared TextField/TextAreaField/CheckboxField controls. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U17-3 | Migrate project settings and destructive confirmation fields. | Completed | Current-session model override now uses shared TextField, and Delete Project source-file option uses shared CheckboxField. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U17-4 | Add render coverage for shared form controls. | Completed | Static render tests now assert `fp-field`, `fp-textarea`, and `fp-checkbox-field`, while rejecting old `skill-form-row`/`settings-field` markup in migrated surfaces. | `tests/runtime/agent-ui-render.test.ts` |
| U17-5 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U18: MCP Plugin Form Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U18-1 | Add a focused MCP plugin form migration batch. | Completed | Scoped this batch to the MCP plugin editor modal fields and left Provider editor fields for a separate batch. | Document review |
| U18-2 | Migrate MCP plugin modal fields to shared form primitives. | Completed | Preset, name, stdio command/args/cwd/env, HTTP base URL, tool policy selects, tool override JSON, enabled toggle, and notes now use SelectField, TextField, TextAreaField, and CheckboxField. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U18-3 | Add render coverage for migrated MCP form controls. | Completed | MCP plugin modal tests now assert shared select/textarea/checkbox controls and reject the old app-settings checkbox row in that modal. | `tests/runtime/agent-ui-render.test.ts` |
| U18-4 | Verify and record the batch. | Completed | Static UI tests, build, runtime tests, UI smoke, Electron smoke, and diff checks passed. | Verification commands |

## Phase U19: Provider Editor Form Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U19-1 | Add a focused Provider editor form migration batch. | Completed | Scoped this batch to Provider editor core fields, advanced protocol fields, role model mapping, and notes while keeping preset cards and model chips stable. | Document review |
| U19-2 | Migrate Provider core fields to shared form primitives. | Completed | Name, Base URL, API Key, default model, upstream model, model datalists, and helper copy now render through shared `TextField` controls. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U19-3 | Migrate Provider advanced fields to shared form primitives. | Completed | Protocol/API mode/auth style selects, SDK proxy and timeout toggles, numeric limits, headers/env overrides, Anthropic role model mapping, and notes now use shared SelectField/TextField/TextAreaField/CheckboxField controls. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U19-4 | Add render coverage for migrated Provider form controls. | Completed | Provider editor tests now assert shared input/select/textarea/checkbox controls and reject the old app-settings checkbox row in the Provider editor. | `tests/runtime/agent-ui-render.test.ts` |
| U19-5 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U20: Onboarding Form Controls Cleanup

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U20-1 | Add a focused Onboarding form cleanup batch. | Completed | Scoped this batch to the remaining onboarding setup/environment fields before removing CSS aliases. | Document review |
| U20-2 | Migrate Onboarding setup and Unity environment fields. | Completed | Project name now uses shared TextField, Unity editor selection uses shared SelectField, and the project path browse row uses `fp-field`/`fp-input` styling with the shared browse Button. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U20-3 | Add render coverage for Onboarding shared form controls. | Completed | Onboarding render tests now assert shared field/input/select output and reject legacy `class="field"` markup. | `tests/runtime/agent-ui-render.test.ts` |
| U20-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U21: Legacy CSS Alias Cleanup

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U21-1 | Add a focused legacy CSS alias cleanup batch. | Completed | Scoped this batch to selector aliases no React component emits anymore: `prototype-*`, old form rows, and old settings field selectors. | `rg "className=\"field\"|className=\"settings-field\"|className=\"skill-form-row\"|className=\"app-settings-check-row\"|prototype-" src/components` |
| U21-2 | Remove obsolete aliases from the stylesheet. | Completed | Removed unused legacy selector aliases from `src/styles.css` while preserving the active `fp-*`, workspace, modal, onboarding, and app settings selectors. | `npm run build` |
| U21-3 | Add smoke coverage for alias regression. | Completed | Desktop UI smoke now reads `src/styles.css` and fails if legacy prototype/form selector aliases reappear. | `npm run ui:smoke` |
| U21-4 | Verify and record the batch. | Completed | Build, UI smoke, Electron smoke, runtime tests, component selector audit, and diff checks all pass. | Verification commands |

## Phase U22: MCP Raw Diagnostics Form Cleanup

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U22-1 | Add a focused MCP diagnostics form cleanup batch. | Completed | Scoped this batch to the Raw Diagnostics form that still emitted `field compact` after CSS aliases were removed. | Component selector audit |
| U22-2 | Migrate Raw Diagnostics fields to shared form primitives. | Completed | Raw MCP method selection now uses shared SelectField, Params JSON uses shared TextAreaField, and the visible helper lists the allowed diagnostic methods because Base UI Select options render through a portal. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U22-3 | Harden smoke coverage for legacy class emissions. | Completed | Desktop UI smoke now scans every `src/components/**/*.ts(x)` source for old prototype/form class emissions, not just the stylesheet aliases. | `npm run ui:smoke` |
| U22-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, component selector audit, and diff checks all pass. | Verification commands |

## Phase U23: Memory Center Form Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U23-1 | Add a focused Memory center form migration batch. | Completed | Scoped this batch to App Settings Memory search, filters, tags, and editor controls without touching Agent chat input or file-tree search. | Document review |
| U23-2 | Migrate Memory search and editor controls. | Completed | Memory search now uses shared TextField, Memory file content uses shared TextAreaField, and tag/kind filter chips use shared Button variants while retaining compact horizontal-scroll behavior. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U23-3 | Add render coverage for Memory shared controls. | Completed | Added App Settings Memory render coverage for shared field/input/textarea/button output and selected Memory file state. | `tests/runtime/agent-ui-render.test.ts` |
| U23-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U24: Session Management Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U24-1 | Add a focused Session Management controls batch. | Completed | Scoped this batch to the left sidebar session toolbar, search, rename, and row action menus without changing session persistence or chat routing. | Document review |
| U24-2 | Migrate session toolbar, search, rename, and menu controls. | Completed | Session search now uses shared TextField, create/search/menu affordances use shared IconButton controls with lucide icons, rename uses shared form styling, and session menu actions use shared Button variants. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U24-3 | Add render coverage for shared session controls. | Completed | Added static render coverage asserting shared toolbar/search/action controls and rejecting legacy raw toolbar button markup in the session panel. | `tests/runtime/agent-ui-render.test.ts` |
| U24-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U25: App Shell Titlebar Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U25-1 | Add a focused App Shell titlebar controls batch. | Completed | Scoped this batch to top-level file tree, project tab, update, current-run changes, and app settings controls without changing routing or panel state. | Document review |
| U25-2 | Migrate titlebar and project tab controls to shared primitives. | Completed | Titlebar icon affordances now use shared IconButton/Button controls with lucide icons, project tabs use shared Button styling, and tab close/new-project controls are aligned with the same component layer. | `tests/runtime/agent-ui-render.test.ts` |
| U25-3 | Add render coverage for shared App Shell controls. | Completed | Titlebar render tests now assert shared Button/IconButton output for update, file tree, changes, settings, project tab, close, and new-project controls while rejecting raw legacy button class emissions. | `tests/runtime/agent-ui-render.test.ts` |
| U25-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U26: Workspace File Search And Source Editor Form Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U26-1 | Add a focused workspace file form migration batch. | Completed | Scoped this batch to the left file-search field and right source-editor textarea without changing file tree routing, preview mode, save behavior, or syntax highlighting. | Document review |
| U26-2 | Migrate file search and source editor controls. | Completed | File search now uses shared TextField styling, and the source editor textarea now uses TextAreaField while preserving the transparent overlay, caret, scroll synchronization, and code-highlight layer. | `tests/runtime/agent-ui-render.test.ts` |
| U26-3 | Add render coverage for the shared source editor textarea. | Completed | File inspector edit-mode render coverage now asserts `fp-textarea file-editor-textarea` output and rejects raw textarea-only class emission. | `tests/runtime/agent-ui-render.test.ts` |
| U26-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U27: Runtime Doctor Export Field Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U27-1 | Add a focused Runtime Doctor export field batch. | Completed | Scoped this batch to the read-only provider diagnostics export field without changing probe, repair, or export generation behavior. | Document review |
| U27-2 | Migrate the diagnostics export textarea. | Completed | Runtime Doctor exported JSON now renders through shared TextAreaField styling while preserving the existing read-only export class and scrollable JSON presentation. | `tests/runtime/agent-ui-render.test.ts` |
| U27-3 | Add render coverage for the shared export field. | Completed | Runtime Doctor render coverage now asserts `fp-textarea runtime-doctor-export` output and rejects raw textarea-only class emission. | `tests/runtime/agent-ui-render.test.ts` |
| U27-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U28: Onboarding Selection Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U28-1 | Add a focused Onboarding selection-control batch. | Completed | Scoped this batch to setup source cards, platform cards, dimension cards, environment step cards, and the path field without changing project creation, import, or environment detection behavior. | Document review |
| U28-2 | Migrate Onboarding cards and path field to shared controls. | Completed | Onboarding cards and wizard steps now use shared Button styling, and the project path input now uses shared TextField styling inside the existing browse row. | `tests/runtime/agent-ui-render.test.ts` |
| U28-3 | Add render coverage for shared Onboarding controls. | Completed | Onboarding render coverage now asserts shared setup card, platform card, path field, and wizard-step output while rejecting raw legacy card button emissions. | `tests/runtime/agent-ui-render.test.ts` |
| U28-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U29: List Card Button Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U29-1 | Add a focused list-card button batch. | Completed | Scoped this batch to card/list rows where the whole row is clickable: MCP plugin cards, MCP server rows, Welcome recent projects, Assets cards, and Session rows. | Document review |
| U29-2 | Migrate list-card buttons to shared Button primitives. | Completed | Clickable list rows now use shared Button styling while preserving existing row classes, status badges, previews, selection state, and callbacks. | `tests/runtime/agent-ui-render.test.ts` |
| U29-3 | Add render coverage for shared list-card controls. | Completed | Render coverage now asserts shared output for MCP row/card buttons, Welcome recent projects, Assets cards, and Session rows while rejecting raw class-only button emissions. | `tests/runtime/agent-ui-render.test.ts` |
| U29-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U30: Project Settings Remaining Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U30-1 | Add a focused Project Settings remaining-controls batch. | Completed | Scoped this batch to the Project Settings category nav, model chips, runtime segment, reasoning segment, and Agent mode segment. | Component source audit |
| U30-2 | Migrate Project Settings remaining raw buttons to shared primitives. | Completed | Project Settings category nav, model chips, runtime segment, reasoning segment, and Agent mode segment now render through shared Button styling while preserving active/disabled semantics and dense settings layout. | `tests/runtime/agent-ui-render.test.ts` |
| U30-3 | Add render coverage for migrated Project Settings controls. | Completed | Static tests assert shared nav/chip/segment output and reject raw Project Settings button emissions. | `tests/runtime/agent-ui-render.test.ts` |
| U30-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U31: Settings Modal Residual Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U31-1 | Add a focused settings modal residual-controls batch. | Completed | Scoped this batch to Provider preset cards, Provider model suggestion chips, and Memory file rows still emitted by settings modals. | Component source audit |
| U31-2 | Migrate settings modal residual raw buttons to shared primitives. | Completed | Provider preset cards, Provider model suggestions, and Memory file rows now render through shared Button styling while keeping active state, titles, and dense list/card layout. | `tests/runtime/agent-ui-render.test.ts` |
| U31-3 | Add render coverage for migrated settings modal controls. | Completed | Static tests assert shared Provider preset/model and Memory file-row output while rejecting raw class-only button emissions. | `tests/runtime/agent-ui-render.test.ts` |
| U31-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U32: Chat Surface Residual Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U32-1 | Add a focused Chat surface residual-controls batch. | Completed | Scoped this batch to MessageList empty/history/scroll actions plus ChatComposer slash menu, attachment chips, and menu dismiss affordance; transcript inline links and code actions stay for the next batch. | Component source audit |
| U32-2 | Migrate Chat surface residual raw buttons to shared primitives. | Completed | Empty suggestions, hidden-history loading, scroll-to-bottom, slash commands, attachment chips, and menu dismiss now render through shared Button styling while preserving the existing compact chat layout. | `tests/runtime/agent-ui-render.test.ts` |
| U32-3 | Add render coverage for migrated Chat surface controls. | Completed | Static tests assert shared chat control output and reject raw class-only button emissions for the migrated surfaces. | `tests/runtime/agent-ui-render.test.ts` |
| U32-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U33: Transcript Inline Controls Migration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U33-1 | Add a focused transcript inline-controls batch. | Completed | Scoped this batch to chat inline path/link/file buttons, message copy/rewind controls, tool-result expansion, code-copy, and changed-file metadata actions. | Component source audit |
| U33-2 | Migrate transcript inline controls to shared primitives. | Completed | Transcript inline links, copy/rewind, tool-result expansion, code-copy, and changed-file metadata actions now use shared Button styling with inline/layout CSS overrides to preserve chat text flow. | `tests/runtime/agent-ui-render.test.ts` |
| U33-3 | Add render coverage for migrated transcript controls. | Completed | Static tests assert shared transcript controls and reject raw class-only button emissions for migrated surfaces. | `tests/runtime/agent-ui-render.test.ts` |
| U33-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, and diff checks all pass. | Verification commands |

## Phase U34: Final Residual Control Cleanup And Audit

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U34-1 | Add a final residual-control cleanup batch. | Completed | Scoped this batch to ChatComposer textarea primitives, notification toast dismiss controls, and a final source audit for raw controls outside shared UI primitives. | Component source audit |
| U34-2 | Migrate final residual controls to shared primitives. | Completed | ChatComposer now uses shared TextAreaControl for composer and user-input textareas; notification toast dismissal now uses shared IconButton. | `tests/runtime/agent-ui-render.test.ts` |
| U34-3 | Add final audit coverage for residual controls. | Completed | Static tests cover shared composer textareas and notification dismiss controls; source audit now shows raw form elements only inside shared UI primitives. | `tests/runtime/agent-ui-render.test.ts`; `rg "<button|<input|<select|<textarea" src/components -n` |
| U34-4 | Verify and record the completed UI route. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, final raw-control audit, and diff checks all pass. | Verification commands |

## Phase U35: Modal Focus And Keyboard Platform Behavior

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U35-1 | Add a focused modal keyboard maturity batch. | Completed | Scoped this batch to the shared ModalShell used by App Settings, Provider editor, and MCP plugin editor. | Component source audit |
| U35-2 | Implement modal focus ownership and keyboard close behavior. | Completed | ModalShell now focuses the first interactive control on open, traps Tab navigation inside the dialog, supports Escape close when `onClose` exists, and restores prior focus on unmount. | `npm run ui:electron-smoke` |
| U35-3 | Add real-window verification for modal focus behavior. | Completed | Electron smoke asserts modal focus starts inside the dialog, stays inside after Tab, and closes with Escape. Static render tests also assert the dialog can own focus with `tabindex="-1"`. | `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U35-4 | Verify and record the batch. | Completed | Focused render test, build, UI smoke, Electron smoke, runtime tests, raw-control audit, and diff checks all pass. | Verification commands |

## Phase U36: UI Platform Maturity Gate

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U36-1 | Add a dedicated UI platform maturity gate. | Completed | Added `npm run ui:maturity-gate` to validate shared UI exports, raw-control boundaries, modal keyboard behavior, Electron smoke evidence, render-test coverage, and legacy selector removal. | `npm run ui:maturity-gate` |
| U36-2 | Persist maturity-gate reports for review. | Completed | The gate writes `out/desktop-ui-maturity-gate/latest-report.md` with passed checks and evidence summary. | Generated report |
| U36-3 | Verify the maturity gate against the current route. | Completed | `npm run ui:maturity-gate` passes alongside focused render tests, build, UI smoke, Electron smoke, runtime tests, raw-control audit, and diff checks. | Verification commands |
| U36-4 | Mark UI platform maturity complete for the current desktop scope. | Completed | The roadmap now records U1-U36 complete, with shared UI primitive boundaries, real-window regression coverage, modal keyboard behavior, and a dedicated maturity gate. | Document review |

## Phase U37: Global Command Palette Platform Surface

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U37-1 | Add a desktop-grade global command entry point. | Completed | AppShell now exposes a command-palette titlebar affordance with `Meta+K Control+K` keyboard shortcuts. | `tests/runtime/agent-ui-render.test.ts` |
| U37-2 | Cover core workspace and shell actions. | Completed | The command palette includes Agent workspace, Project Settings, Assets, file tree, inspector, current-run changes, App Settings, New Project, and project-switch actions. | `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U37-3 | Verify real-window keyboard focus and command execution. | Completed | Electron smoke opens the command palette with the shortcut, verifies focus lands in search, executes the Assets command, and asserts the palette closes after navigation. | `npm run ui:electron-smoke` |
| U37-4 | Fold command palette coverage into the UI maturity gate. | Completed | `npm run ui:maturity-gate` now checks AppShell command-palette primitives, shortcut wiring, action ids, and Electron command execution evidence. | `npm run ui:maturity-gate` |

## Phase U38: Shared Dialog Focus Contract

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U38-1 | Extract dialog focus behavior into a shared UI platform hook. | Completed | Added `useDialogFocus` under `src/components/ui` for initial focus, Tab trapping, Escape handling, and prior-focus restoration. | `npm run build` |
| U38-2 | Migrate settings modal focus behavior to the shared hook. | Completed | `ModalShell` now delegates focus ownership to `useDialogFocus` while preserving semantic dialog attributes and `tabIndex={-1}` fallback focus. | `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U38-3 | Migrate command palette focus behavior to the shared hook. | Completed | The command palette now uses the same focus contract as settings modals, including search initial focus, Tab containment, Escape close, and restore-on-close behavior. | `npm run ui:electron-smoke` |
| U38-4 | Gate shared dialog focus coverage. | Completed | `npm run ui:maturity-gate` checks the shared hook, ModalShell adoption, command palette adoption, render evidence, and Electron Tab-trap evidence. | `npm run ui:maturity-gate` |

## Phase U39: Reduced Motion Accessibility Contract

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U39-1 | Define a global reduced-motion contract for desktop UI. | Completed | Added a top-level `prefers-reduced-motion: reduce` rule that neutralizes global animation/transition duration and scroll behavior. | `npm run build`; `npm run ui:smoke` |
| U39-2 | Cover high-activity Agent and shell animations. | Completed | Reduced-motion coverage explicitly includes command palette entrance, tool detail transitions, Agent live spinner/dots/task pulse, run indicators, processing spinners, update spinner, and shared button spinner. | `npm run ui:smoke` |
| U39-3 | Verify reduced motion inside a real Electron window. | Completed | Electron smoke now emulates `prefers-reduced-motion: reduce` via DevTools protocol and asserts the command palette computes without entrance animation. | `npm run ui:electron-smoke` |
| U39-4 | Gate reduced-motion regressions. | Completed | `npm run ui:maturity-gate` checks the CSS contract, Electron reduced-motion emulation, computed command-palette animation evidence, and U39 roadmap completion marker. | `npm run ui:maturity-gate` |

## Phase U40: High Contrast Forced-Colors Contract

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U40-1 | Declare platform color-scheme support. | Completed | Root theme CSS now declares `color-scheme: light`, dark theme declares `color-scheme: dark`, and root accent color follows the shared brand token. | `npm run build`; `npm run ui:smoke` |
| U40-2 | Add a high-contrast forced-colors contract. | Completed | Added `forced-colors: active` rules that map surfaces, controls, selected command/nav states, disabled states, overlays, and focus outlines to system colors. | `npm run ui:smoke` |
| U40-3 | Verify high contrast in a real Electron window. | Completed | Electron smoke now emulates `forced-colors: active` together with reduced motion, asserts the media query matches, and records command-palette computed border/background evidence. | `npm run ui:electron-smoke` |
| U40-4 | Gate high-contrast regressions. | Completed | `npm run ui:maturity-gate` checks color-scheme declarations, forced-colors CSS, Electron emulation, computed style evidence, and U40 roadmap completion marker. | `npm run ui:maturity-gate` |

## Phase U41: Real-Window Interactive Accessibility Audit

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U41-1 | Add a focused real-window accessibility maturity batch. | Completed | Scoped this batch to visible interactive elements in the Electron smoke states, avoiding broad visual redesign while adding a platform-level semantic guardrail. | Document review |
| U41-2 | Audit visible interactive controls for accessible names. | Completed | Electron smoke now collects visible buttons, links, form controls, role-based controls, and tabbable elements across Agent, command palette, Project Settings, Assets, App Settings, Provider editor, and compact states; the smoke fails if any visible control lacks an accessible name. | `npm run ui:electron-smoke` |
| U41-3 | Persist accessibility evidence in the smoke report. | Completed | The Electron smoke report now includes an Accessibility Audit section with unnamed-control counts per checked state. | Generated report |
| U41-4 | Gate accessibility audit regressions. | Completed | `npm run ui:maturity-gate` now checks the real-window accessibility audit implementation, failure copy, report section, and U41 roadmap completion marker. | `npm run ui:maturity-gate` |

## Phase U42: Real-Window Layout Stability Audit

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U42-1 | Add a focused real-window layout stability batch. | Completed | Scoped this batch to viewport-level horizontal overflow, critical shell/floating-surface clipping, and shared button-label overflow in the same Electron states used by the UI smoke. | Document review |
| U42-2 | Audit visible route states for overflow and clipping. | Completed | Electron smoke now fails when a checked state creates page-level horizontal overflow, clips command palette/dialog/composer surfaces outside the viewport, or lets a shared button label escape its button bounds. | `npm run ui:electron-smoke` |
| U42-3 | Persist layout evidence in the smoke report. | Completed | The Electron smoke report now includes a Layout Stability Audit section with issue counts per checked state. | Generated report |
| U42-4 | Gate layout audit regressions. | Completed | `npm run ui:maturity-gate` now checks the layout audit implementation, failure copy, report section, and U42 roadmap completion marker. | `npm run ui:maturity-gate` |

## Phase U43: Chat Scroll And Session Visibility Regression

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U43-1 | Reproduce and fix the non-scrollable chat transcript. | Completed | Real-window smoke now uses a long transcript fixture and verifies `.agent-scroll-region` overflows, owns `overflow-y: auto`, and changes `scrollTop`. The layout fix constrains the chat shell height so the transcript scrolls instead of expanding to content height. | `npm run build`; `npm run ui:electron-smoke` |
| U43-2 | Reproduce and fix the blank session-management row. | Completed | Session row content was clipped because the shared Button wrapper became the only child inside a two-column grid. The session main button now uses a block shell and a flex label row so the title and latest summary receive real width. | `npm run ui:electron-smoke` |
| U43-3 | Harden real-window assertions for both regressions. | Completed | Electron smoke now asserts the visible session title text, title width, latest summary text, title color, and long-chat scroll metrics before continuing through the route smoke. | `npm run ui:electron-smoke` |
| U43-4 | Gate chat/session regression coverage. | Completed | `npm run ui:maturity-gate` now checks the chat-scroll assertion, scroll failure copy, session-title visibility assertion, and U43 roadmap completion marker. | `npm run ui:maturity-gate` |

## Phase U44: Chat Composer Bottom Anchoring Regression

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U44-1 | Reproduce and fix the top-floating composer regression. | Completed | The chat workbench height chain now gives the body, chat pane, workspace shell, and primary column a definite full-height layout so empty conversations cannot collapse the message area above the composer. | `npm run build`; `npm run ui:electron-smoke` |
| U44-2 | Restore deterministic chat layout while preserving transcript scrolling. | Completed | `.agent-chat-shell` now uses a two-row grid (`minmax(0, 1fr)` transcript and `auto` composer), while the scroll layer owns the remaining height and the composer layer stays in the bottom row. | `npm run ui:electron-smoke` |
| U44-3 | Add real-window empty-chat composer anchoring coverage. | Completed | Electron smoke now includes an empty session, switches to it, and asserts the composer bottom remains within the chat shell bottom tolerance while the scroll layer keeps meaningful height. | `npm run ui:electron-smoke` |
| U44-4 | Gate composer anchoring regressions. | Completed | `npm run ui:maturity-gate` now checks the composer anchoring assertion, failure copy, empty-chat state coverage, and U44 roadmap completion marker. | `npm run ui:maturity-gate` |

## Phase U45: Design Tokens Centralization

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U45-1 | Extract a centralized token file. | Completed | Added `src/styles/tokens.css` as the single source of truth for color (gray/slate/indigo/emerald/amber/rose raw scales + semantic surface/text/border/accent/feedback), spacing (8-step base-4), type (6-step), leading (4-step), radius (4-step), shadow (5-layer), z (6-layer), duration (4-step), easing (4-step), and control sizing. Imported from `src/main.tsx` before `styles.css`. The legacy semantic names (`--bg`, `--panel`, `--brand`, etc.) remain available as backward-compat aliases that reference `--fp-*` tokens. `src/styles.css` `:root` and `:root[data-theme='dark']` blocks are trimmed to non-token properties only. | `npm run build`; `npm run ui:smoke`; `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U45-2 | Convert dark theme to token-value overrides only. | Completed | Replaced every component-level `:root[data-theme='dark'] .selector` override in `src/styles.css` with theme-aware tokens defined in `src/styles/tokens.css`. Inventory at phase start: 656 occurrences. Final state: **0** component-level dark selectors in `styles.css`; only the root token-override block and the `@media (forced-colors: active)` block reference `[data-theme='dark']`, and both set token values rather than targeting specific components. Migration proceeded as Waves 2a–2g detailed below. | `npm run build`; `npm run ui:smoke`; `npm run ui:electron-smoke`; `tests/runtime/agent-ui-render.test.ts` |
| U45-2a | Wave 1: body, generic form controls, command palette. | Completed | Added `--fp-body-background`, `--fp-input-bg`, and the `--fp-command-palette-*` token family (backdrop, surface, border, shadow, divider, keycap-bg, keycap-border, icon-bg, item-selected-bg, item-selected-ring) with light/dark values in `tokens.css`. Rewrote `body`, generic `input/select/textarea`, `.command-palette-backdrop`, `.command-palette-dialog`, `.command-palette-search`, `.command-palette-search kbd`, `.command-palette-item-icon`, and `.command-palette-item[aria-selected='true']` in `styles.css` to consume the tokens. Removed 7 dark override blocks (10 selector occurrences). `:root[data-theme='dark']` count: 656 -> 646. | `npm run build`; `npm run ui:smoke`; `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U45-2b | Wave 2: titlebar and project tabs cluster. | Completed | Added the `--fp-titlebar-*` family (bg, text, border, icon-bg/text idle and active, update-toggle states for idle/active/downloaded/downloaded-hover/progress, update-dot ring) and the `--fp-project-tab-*` family (shell-bg idle/hover/active with rings, text idle/active, 5 badge variants for running/queued/approval/failed/resumable, dot idle/active, status-processing text, add-button bg/text, close-button bg/text idle/hover). Rewrote 9 titlebar light rules and 16 project-tab light rules to use tokens. Removed 22 dark override blocks (26 selector occurrences). `:root[data-theme='dark']` count: 646 -> 620. | `npm run build`; `npm run ui:smoke`; `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U45-2c | Wave 3: workspace gradient + isolated panel surfaces. | Completed | Added `--fp-workspace-shell-bg`, `--fp-provider-meta-pill-bg/text`, `--fp-registry-note-bg`, `--fp-modal-close-{bg,text,bg-hover,text-hover}`, `--fp-app-settings-panel-bg`, and `--fp-app-settings-inline-editor-bg` with light/dark values. Rewrote `.desktop-workspace`, `.standalone-shell-content`, `.provider-settings-meta span`, `.mcp-registry-note`, `.modal-close-button` and `:hover`, `.app-settings-sidebar`, `.app-settings-section`, `.app-settings-inline-editor` in `styles.css`. Removed 6 dark override blocks (9 selector occurrences). `:root[data-theme='dark']` count: 620 -> 611. | `npm run build`; `npm run ui:smoke`; `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U45-2e | Wave 5: bulk migration of bottom dark cluster via `:where()` fallback. | Completed | Added a comprehensive "dark utility" token set in `tokens.css` covering surface (`--fp-dark-surface*` 8 variants), border (`--fp-dark-border-*` 4 variants), text (`--fp-dark-text-*` 5 variants), accent (`--fp-dark-accent-*` 3 variants), feedback banner (warning/error/success/info), and shadow tokens, each with light value `transparent` / `inherit` and the original hardcoded dark value. Added `scripts/migrate-dark-overrides.mjs` which mechanically rewrites every `:root[data-theme='dark'] X { props }` block to a zero-specificity `:where(X) { props with --fp-dark-* tokens }` block. Because `:where()` has 0,0,0,0 specificity, individual light rules (e.g. `.card { background: #fff }`) keep winning in light mode (their token light value resolves to transparent / inherit, which is then overridden by the higher-specificity individual rule). In dark mode, no other rule sets these properties (the `[data-theme='dark']`-prefixed overrides are gone), so the `:where()` fallback's dark token values take effect. Ran with `--apply` to migrate **295 dark blocks (562 selectors)** in one shot. | `node scripts/migrate-dark-overrides.mjs --apply`; `npm run build`; `npm run ui:smoke`; `npm run ui:electron-smoke`; `tests/runtime/agent-ui-render.test.ts` |
| U45-2g | Final smoke gate forbidding component-level dark overrides. | Completed | `scripts/desktop-ui-smoke.mjs` now hard-fails when `src/styles.css` contains any `:root[data-theme='dark']` selector followed by a component class/element (regex `:root\[data-theme='dark'\]\s+[.\w]`). The gate also asserts that `src/styles/tokens.css` exists and contains the raw color scale, body background, elevated card token, and the dark token-override block — guarding both the prohibition and the positive infrastructure. New theme-dependent component styling must reference an existing `--fp-*` token (preferred) or use a `:where()` fallback that does. Future contributors get an immediate, actionable error if they reintroduce a dark component rule. | `npm run ui:smoke` |
| U45-2d | Wave 4: 17-selector elevated-card consolidation. | Completed | Added `--fp-elevated-card-bg` (light: rgba(255,255,255,0.7), dark: rgba(15,23,42,0.58)), `--fp-elevated-card-bg-empty` (light: transparent, dark: rgba(15,23,42,0.58)), `--fp-app-update-panel-bg`, `--fp-provider-advanced-section-bg`, `--fp-web-search-quality-row-bg`, `--fp-provider-preset-card-bg`, `--fp-elevated-card-border` (light: rgba(15,23,42,0.08), dark: rgba(148,163,184,0.14)), and `--fp-elevated-card-border-line` (light: var(--line), dark: rgba(148,163,184,0.14)). Eight white-card selectors (`.claude-runtime-status`, `.claude-session-row`, `.runtime-run-row`, `.web-search-quality-panel`, `.web-search-toggle-row label:not(.fp-switch-field)`, `.memory-file-row`, `.memory-editor-panel`, `.notification-task-row`) rewritten to consume `--fp-elevated-card-bg/--fp-elevated-card-border` with their light alpha normalized to 0.7 (previously 0.68 / 0.7 / 0.72). Four special-case selectors (`.app-update-panel`, `.provider-advanced-section`, `.web-search-quality-row`, `.provider-preset-card`) updated with their own bg tokens and the line-border token. Five empty selectors (`.claude-install-row`, `.runtime-summary-tile`, `.runtime-card`, `.runtime-capability-panel`, `.runtime-run-panel`) gained a single consolidated rule using `--fp-elevated-card-bg-empty`. The 17-selector dark override block deleted. `:root[data-theme='dark']` count: 611 -> 594. | `npm run build`; `npm run ui:smoke`; `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U45-3 | Add a token audit test. | Completed | Added `tests/runtime/style-token-audit.test.ts` (6 tests, auto-included in `npm run test:runtime`). It asserts `tokens.css` defines the full token category set (raw color scales, semantic surface/text/border/accent/feedback, spacing, type, leading, radius, shadow, z, motion) and a dark token-override block; holds `src/styles.css` hardcoded-color and `px`-literal counts under ratcheting baselines (1257 colors / 2887 px — the test fails only on INCREASE, and baselines are lowered as U46 migrates rules to tokens); verifies raw `--fp-color-*` scale tokens are defined only in `tokens.css`; and reconfirms zero component-level `:root[data-theme='dark']` overrides in `styles.css`. A strict zero-hardcoded assertion is impractical on the 16k-line legacy stylesheet, so the ratchet baseline mirrors the U45-2g pattern. | `tests/runtime/style-token-audit.test.ts`; `npm run test:runtime` |
| U45-4 | Document tokens. | Completed | Added `docs/design-tokens.md` covering the naming convention, raw-vs-semantic layering, full tables for raw color scales / semantic colors (with light + dark values) / spacing / typography / line-height / radius / shadow / z-index / motion / control sizing, a summary of component-role and `--fp-dark-*` utility tokens, the dark-theme token-override model with a code example, the backward-compat alias policy, and an "adding or changing a token" workflow. Cross-linked from `CLAUDE.md` repo conventions. | Document review |

## Phase U46: CSS Slicing and Scoping

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U46-1 | Slice the 16k-line stylesheet. | Completed | **Plan deviation (documented):** `src/styles.css` turned out to be a *generational-override* stylesheet — its 13 section comments (`V1 主工作台`, `desktop workspace v2`, `workspace chat-first overrides`, `Dark theme completion pass`, …) confirm later sections deliberately override earlier ones via source order. A semantic `base/components/patterns/routes` reorganization would reshuffle same-specificity rules and change the cascade. Instead, `scripts/slice-styles.mjs` slices the file **strictly at section boundaries in source order** into `src/styles/base/foundation.css` (lines 1-216: reset, base elements, reduced-motion, forced-colors), `src/styles/components/primitives.css` (217-744: shared `.fp-*` primitives), and `src/styles/layers/01-12-*.css` (the 12 generational layers). The script verifies byte-exact reconstruction and per-segment brace balance. `src/styles/index.css` is the ordered `@import` barrel (tokens.css first); `src/main.tsx` imports it. The monolith is removed. Smoke/maturity-gate/audit consumers updated to read the concatenated slices. | `node scripts/slice-styles.mjs`; `npm run build`; `npm run ui:smoke`; `npm run ui:electron-smoke`; `tests/runtime/agent-ui-render.test.ts` |
| U46-2 | Adopt CSS Modules for new components. | Completed | Established the convention (documented in `CLAUDE.md`): new component styles are co-located CSS Modules (`<Name>.module.css`) referencing `--fp-*` tokens. Existing global classes are kept; no bulk rename. Enforced by U46-3. | `CLAUDE.md` review; `npm run ui:smoke` |
| U46-3 | Gate legacy global / non-module CSS re-introduction. | Completed | `npm run ui:smoke` rejects any plain (non-`*.module.css`) stylesheet added under `src/components/` — a global-scope leak. Combined with the U45-2g dark-override gate, new component CSS is funneled into either a token, a layer slice, or a co-located CSS Module. | `npm run ui:smoke` |
| U46-4 | Add CSS slice integrity coverage to the smoke gate. | Completed | `npm run ui:smoke` now fails if the monolithic `src/styles.css` reappears, if `src/styles/index.css` does not `@import` every slice file, or if the barrel imports `tokens.css` after the `base/` slice. The smoke report documents the slice structure. This guards against regression to a monolith and against orphaned / dangling slices. | `npm run ui:smoke` |

## Phase U47: App Composition and State Layering

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U47-1 | Extract four domain controllers from `App.tsx`. | Planned | Introduce `WorkspaceController`, `SessionController`, `UpdateController`, and `OnboardingController` that own their respective hook clusters; `App.tsx` becomes a router/shell only. Target: `App.tsx` <= 400 lines. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| U47-2 | Introduce a renderer state store. | Planned | Adopt zustand for cross-page selection state (current project, current session, runtime status, update banner, app settings open state). `useSyncExternalStore`-compatible; no Redux or context-prop drilling. | `tests/runtime/agent-ui-render.test.ts` |
| U47-3 | Split `ConversationMessage.tsx`. | Completed | Broke the 1,423-line file into a dependency-ordered set of `chat/transcript/` modules: `message-plain-text.ts` (pure text extraction — `getMessagePlainText`, agent-core/block plain text, tool-result summary), `chat-markdown.tsx` (`renderChatContent`, code block, markdown/table parsing), `message-process.tsx` (agent-core part rendering, process timeline, context/todo/permission-impact blocks), and `message-blocks.tsx` (`renderChatMessageBlocks`, `ChatContentBlockView`). `ConversationMessage.tsx` keeps the four top-level transcript components and re-exports `getMessagePlainText`, so `MessageList.tsx` and the render test imports stay stable. The split followed the traced dependency graph (plain-text -> markdown -> process -> blocks -> components, acyclic); a dead duplicate `readStringField` was dropped. `ConversationMessage.tsx`: 1423 -> 317 lines. | `npx tsc --noEmit`; `npm run build`; `tests/runtime/agent-ui-render.test.ts`; `tests/runtime/app-component-size.test.ts`; `npm run ui:electron-smoke` |
| U47-4 | Split `tool-activity.tsx`. | Planned | Break the 1,258-line file into `chat/tool/{ActivityGroup, ActivityRow, ResultMeta, Citation, Trail, Formatters}.tsx`. | `tests/runtime/agent-ui-render.test.ts` |
| U47-5 | Split `AgentChatView.tsx`. | Planned | Break the 932-line file into `chat/agent/{Header, Stream, Empty, Queue, Composer}.tsx`. Preserve scroll anchoring (U43) and composer bottom anchoring (U44). | `tests/runtime/agent-ui-render.test.ts`; `npm run ui:electron-smoke` |
| U47-6 | Gate component size. | Completed | Added `tests/runtime/app-component-size.test.ts` (3 tests, auto-run by `npm run test:runtime`). Every `src/**/*.tsx` must stay <= 600 lines; the oversized files inherited before U47 are listed in a `BASELINES` ratchet that may only shrink — a second test fails if a baseline goes stale (file shrank below it) so the ratchet is tightened in the same commit. `App.tsx` carries an explicit `APP_TARGET` (400) recording the U47-1 goal. After U47-3, `ConversationMessage.tsx` dropped out of `BASELINES` entirely. | `tests/runtime/app-component-size.test.ts`; `npm run test:runtime` |

## Phase U48: i18n Engineering

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U48-1 | Adopt a real i18n library. | Planned | Replace the inline `localize(language, zh, en)` helper with lingui (preferred) or i18next. Lingui's compile-time extraction and ICU MessageFormat handle plurals, dates, and numbers. Bundle budget: <= 25KB gzipped. | `npm run build` |
| U48-2 | Codemod existing callsites. | Planned | Write a one-shot script that rewrites every `localize(language, zh, en)` to `t('key', { ... })` and seeds the catalog (`src/i18n/locales/{zh-CN,en-US}.po`) from the original literals. | `tests/runtime/agent-ui-render.test.ts` |
| U48-3 | Audit i18n callsites. | Planned | `tests/runtime/i18n-call-audit.test.ts` rejects new `localize(` callsites with inline strings and enforces catalog completeness for both locales. | `tests/runtime/i18n-call-audit.test.ts` |
| U48-4 | RTL layout dry-run. | Planned | Add a hidden `dir="rtl"` mode to the Electron smoke that verifies layout does not clip, mirror-break icons, or invert direction-sensitive controls (file tree chevrons, scrollbars, command palette kbd hints). | `npm run ui:electron-smoke` |

## Phase U49: Desktop Native Affordances

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U49-1 | macOS integrated titlebar. | Planned | Switch to `titleBarStyle: 'hiddenInset'`, add a custom drag region inside `AppShell`, and apply vibrancy material on macOS. Windows keeps the existing chrome path. | `npm run ui:electron-smoke` |
| U49-2 | Native context menus. | Planned | Wire `Menu.buildFromTemplate` through IPC for session rows, file tree rows, chat messages, and Agent Run rows. Right-click in the renderer requests a native menu and dispatches the chosen action back through `FunPlayApi`. | `npm run ui:electron-smoke` |
| U49-3 | Native file drag-in. | Planned | Compose attachments via the existing `prompt-attachment-service` when external files are dropped onto the chat composer or Assets page. Reject unsupported mime types with a toast. | `npm run ui:electron-smoke` |
| U49-4 | Dock badge and Tray. | Planned | Reflect active Agent run count on the macOS Dock badge and add an optional Tray icon with a quick session list and a "stop current run" action. | `npm run ui:electron-smoke` |
| U49-5 | Toast fallback to system Notification. | Planned | When the renderer window is not focused, route notifications through `electron.Notification` (with action buttons where supported) instead of the in-app `NotificationToastStack`. | `npm run ui:electron-smoke` |

## Phase U50: Diagnostics Productization

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U50-1 | Runtime Doctor status cards. | Planned | Replace the linear repair-order list with grouped status cards (auth, model, network, quota, tool-calling, default state) showing current state, one-click fix action, and last-seen trend. | `tests/runtime/agent-ui-render.test.ts` |
| U50-2 | Agent Runs filter and timeline. | Planned | Add filter (by task, by tool, by provider, by cost) and an optional time-axis view alongside the existing table. | `tests/runtime/agent-ui-render.test.ts` |
| U50-3 | Token usage stacked breakdown. | Planned | Visualize token usage as stacked area/bar by provider, model, and role. Use recharts or visx (both React 19 compatible). | `tests/runtime/agent-ui-render.test.ts` |
| U50-4 | Permission audits story flow. | Planned | Render permission audits as a chronological story (who -> what -> when -> reverted) rather than an audit table, with filterable scopes. | `tests/runtime/agent-ui-render.test.ts` |

## Phase U51: Visual Regression Baseline

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U51-1 | Capture pixel screenshots in the Electron smoke. | Planned | For each major route (Agent, Project Settings, Assets, App Settings, Provider editor, Onboarding, Welcome) capture screenshots across (default, compact) x (light, dark) x (default, forced-colors). Store baselines under `out/desktop-ui-electron-smoke/baseline/`. | `npm run ui:electron-smoke` |
| U51-2 | Wire pixel diff. | Planned | Use pixelmatch or odiff with a 0.5% threshold to absorb antialiasing variance. The smoke fails when any baseline diff exceeds the threshold and writes the diff image to the report. | `npm run ui:electron-smoke` |
| U51-3 | Baseline change workflow. | Planned | Baseline updates require an explicit `npm run ui:electron-smoke -- --update-baseline` and are recorded in the smoke report. `npm run ui:maturity-gate` checks that no PR auto-updates the baseline without that flag. | `npm run ui:maturity-gate` |

## Phase U52: Motion and Density Tokens

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| U52-1 | Motion token system. | Planned | Define `--fp-duration-{instant,fast,base,slow}` and `--fp-easing-{standard,emphasized,decelerate,accelerate}` tokens. Replace existing literal animation durations and easings. The reduced-motion contract (U39) continues to override these to `0ms`. | `npm run build`; `npm run ui:smoke` |
| U52-2 | First-class density modes. | Planned | Introduce `comfortable`, `compact`, and `dense` modes through a root `data-density` attribute that scales spacing/control tokens. Fold the existing compact-window adaptation into this system. | `npm run ui:electron-smoke` |
| U52-3 | Per-user density preference. | Planned | Persist the density choice via `useUiPreferences` and expose a control in App Settings -> Appearance. | `tests/runtime/agent-ui-render.test.ts` |

Latest U18 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U19 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U20 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U21 verification completed:

- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`
- `rg "className=\"field\"|className=\"settings-field\"|className=\"skill-form-row\"|className=\"app-settings-check-row\"|prototype-" src/components`
- `rg "prototype-|\\.field|app-settings-check-row|settings-field|skill-form-row" src/styles.css`

Latest U22 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`
- ``rg 'className=("field\\b|\\{`field\\b)|prototype-|settings-field|skill-form-row|app-settings-check-row' src/components``

Latest U23 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U24 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U25 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U26 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U27 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U28 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U29 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U30 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U31 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U32 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U33 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `git diff --check`

Latest U34 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run test:runtime`
- `rg "<button|<input|<select|<textarea" src/components -n`
- `git diff --check`

Latest U35/U36 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run ui:maturity-gate`
- `npm run test:runtime`
- `rg "<button|<input|<select|<textarea" src/components -n`
- `git diff --check`

Latest U37 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run ui:maturity-gate`
- `npm run test:runtime`
- `rg "<button|<input|<select|<textarea" src/components -n`
- `git diff --check`

Latest U38 verification completed:

- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run build`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run ui:maturity-gate`
- `npm run test:runtime`
- `rg "<button|<input|<select|<textarea" src/components -n`
- `git diff --check`

Latest U39 verification completed:

- `npm run build`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run ui:maturity-gate`
- `npm run test:runtime`
- `rg "<button|<input|<select|<textarea" src/components -n`
- `git diff --check`

Latest U40 verification completed:

- `npm run build`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run ui:smoke`
- `npm run ui:electron-smoke`
- `npm run ui:maturity-gate`
- `npm run test:runtime`
- `rg "<button|<input|<select|<textarea" src/components -n`
- `git diff --check`
