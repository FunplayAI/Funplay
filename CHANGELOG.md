# Changelog

All notable changes to Funplay will be documented in this file.

This project follows a pre-1.0 release flow. Minor versions may include breaking changes while the agent runtime, desktop UI, and provider contracts are still stabilizing.

## Unreleased

## 0.4.0 - 2026-06-22

### Added

- Added Godot as a real engine adapter backed by `FunplayAI/funplay-godot-mcp`, including engine-neutral tool routing, project detection, bridge install/open flows, and runtime diagnostics.
- Added guided Godot editor installation on macOS, with stable-release download, extraction, and environment-service actions for users who do not have Godot installed yet.
- Added Spotlight fallback detection for macOS Godot editor installs when standard application paths and command-line discovery do not find the editor.

### Changed

- Refreshed the README preview to a single engine-project workspace screenshot, with separate English and Chinese images.

## 0.3.10 - 2026-06-17

### Added

- Added a Cocos engine-variant path for Creator 3 and Cocos4 projects, including Cocos4 onboarding diagnostics, background cocos-cli installation, headless create/open support, managed MCP server startup, and live `cocos://` resource reading.
- Added native runtime multimodal image attachment handling, richer reasoning/dialect controls, command sandbox plumbing, and stronger subagent definitions/runs persistence.
- Added syntax highlighting for chat code blocks, a more guided provider editor, richer loading/progress feedback, and a characterful creative-tool UI skin.

### Removed

- Removed the Claude Code SDK runtime; the native runtime is now the only agent runtime. Anthropic models remain fully supported through the regular Anthropic API provider.
- Removed the `@anthropic-ai/claude-agent-sdk` dependency and its packaging entries, the Claude CLI detection/login/session-import surface, and the `FUNPLAY_CLAUDE_CODE_*` / `FUNPLAY_E2E_CLAUDE_*` development environment variables.

### Changed

- Existing sessions configured for the Claude Code runtime migrate automatically to the native runtime; persisted Claude session metadata is cleaned up by a store migration.
- Refactored the renderer app shell into focused stores, action factories, and hooks for project/session/composer/runtime state while keeping the component-size ratchet honest.
- Refined chat reply typography, inline code, tables, blockquotes, dark-theme depth, turn separation, and soft line-break handling.

### Fixed

- Fixed agent `find_files` missing files beyond the 1200-entry listing cap.
- Hardened Unity and Cocos MCP lifecycle handling, including transport-death detection, Cocos MCP port rediscovery, deterministic bridge installation, offline install behavior, launch readiness waits, dashboard deduplication, and bounded health probes.
- Fixed provider setup, asset generation, onboarding, composer, MCP, web search, memory, and modal interaction-safety issues found in the UI review batches.

## 0.3.9 - 2026-06-10

### Changed

- Improved assistant reply streaming with smoother text pacing and a hybrid Markdown preview while responses are still rendering.
- Refined native agent tool-execution status copy so internal implementation wording is no longer shown in the user-facing transcript.
- Upgraded Markdown file previews to use the shared React Markdown/GFM renderer with better table, quote, list, and code styling.

### Fixed

- Fixed completed assistant replies being duplicated when provider step snapshots repeated previously recorded text.
- Fixed chat text selection being cleared by idle runtime refreshes, auto-scroll, or stable completed-message re-renders.
- Fixed Cocos project launch checks so already-open projects are detected more reliably and are not opened a second time.
- Fixed Cocos engine actions to skip opening another Cocos Creator instance when the current project is already connected through MCP.

## 0.3.8 - 2026-06-08

### Changed

- Parallelized macOS release packaging across arm64 and x64 jobs while preserving split update metadata.
- Added first-class Cocos Creator integration with Funplay Cocos MCP binding, bridge installation, CLI diagnostics, 2D/3D project creation, and current-project connectivity checks.
- Standardized engine MCP names as `Unity MCP - Project` and `Cocos MCP - Project`, including display fallbacks for legacy built-in bindings.
- Simplified project Skills settings by hiding the Claude Code filesystem Skills registry panel.

### Fixed

- Fixed Windows GitHub Release publishing so updater metadata-referenced installer assets are present even when builder output uses a different filename style.
- Fixed Cocos onboarding so MCP connectivity only completes after the online server confirms the current project path, and so already-open Cocos projects are not relaunched.

## 0.3.7 - 2026-06-02

### Added

- Added exponential backoff with jitter for native OpenAI-compatible HTTP retries.
- Added provider onboarding gating so the chat view directs users to configure an AI provider before starting agent work.
- Added pure JavaScript zip reading for Windows-compatible packaged runtime and document flows.
- Added refreshed 2026 provider presets in the provider catalog.

### Changed

- Improved cross-platform path validation and shell spawning for Windows environments.
- Improved provider base URL handling so pasted full endpoint URLs are normalized more reliably.
- Improved native reasoning handling by stripping inline `<think>` blocks from chat content and streaming reasoning separately.
- Improved MiniMax and compatible tool schema handling by always sending valid object parameter schemas.

### Fixed

- Fixed interrupted agent runs so the conversation turn is preserved for resume and replay.

## 0.3.6 - 2026-06-01

### Added

- Added native agent E2E verification coverage with real write-and-verify tasks and stronger active verification reporting.
- Added an agent eval framework with parity-oriented task fixtures for native and Claude-backed runtime comparisons.
- Added native tool-loop step budget handling, final summarization prompts, provider chunk timeout defaults, and optional model-assisted context handoff summaries.
- Added OpenAI-compatible tool-call repair for malformed arguments, prefixed tool names, and common naming variations.

### Changed

- Hardened native agent write execution so workspace side effects are followed by blocking verification before reporting success.
- Split Project Settings into focused components and extracted MCP management logic for a leaner app shell.
- Tightened UI smoke checks with realistic-color screenshot companions and fail-fast detection for stale renderer bundles.
- Improved dark card legibility, file tree density, and two-column settings layout fill behavior.

### Fixed

- Fixed Claude runtime lint regressions around constant bindings.

## 0.3.5 - 2026-05-28

### Added

- Added a unified React Markdown renderer for chat replies with GFM tables, task lists, inline links, local file path actions, and safer handling for prose fences.
- Added stronger native provider retry and timeout normalization so transient provider failures can be classified and retried more consistently.
- Added richer provider runtime events for native model retries and tool stream state, giving the controller and UI better execution evidence.
- Added expanded runtime tests for agent execution recovery, chat Markdown rendering, and tool transcript ordering.

### Changed

- Increased native subagent default step budget and added forced final summarization when a subagent reaches its step budget.
- Refined OpenAI-compatible and AI SDK provider steps to preserve partial context, retry only safe failures, and report clearer timeout states.
- Reworked chat tool details into a lighter Codex-style inline disclosure instead of heavy floating debug panels.
- Refined chat Markdown typography, code blocks, plain text examples, tables, quotes, and divider spacing in light and dark themes.
- Improved the project tab engine indicators and chat engine status entry to use real engine logo styling.
- Kept the desktop workspace in horizontal split layout at narrower window sizes so the chat pane no longer overlaps or visually swallows the left sidebar.

### Fixed

- Fixed pasted/local media attachment tools rejecting valid absolute file paths outside the project root.
- Fixed file preview selection remaining highlighted after the preview panel is closed.
- Fixed session rows staying visually selected when the user switches to Project Settings or Assets.
- Fixed Unity onboarding environment checks getting stuck on the first entry until navigating back.
- Fixed live chat status copy and spacing, including removal of redundant running-state helper text.
- Fixed Markdown examples being over-rendered as CODE cards when they are prose snippets rather than source code.

## 0.3.4 - 2026-05-27

### Added

- Added pasted image and file attachment support for chat composer input, including deterministic attachment staging and duplicate-paste protection.
- Added AI Provider model list fetching for create/edit flows when Base URL and API key are configured.
- Added real engine logo assets and compact engine connection display for Unity, Cocos, Godot, and Unreal entry points.
- Added runtime language instructions so native and Claude-backed agents answer in the selected app language.
- Added Funplay HTML preview capability guidance so agents prefer the in-app preview instead of sending users to an external browser by default.
- Added release audit checks to keep DMG packaging free of hidden background and volume icon files.
- Added packaged app verification for embedded update metadata and app version consistency.

### Changed

- Redesigned the first-run welcome and onboarding screens around the AI game development workbench workflow.
- Tightened the chat transcript into a Codex-style reading flow: user prompts stay as compact right-side bubbles, assistant replies read like documents, and tool work appears as lightweight step rows.
- Collapsed completed tool processes into compact summaries before the final answer text, with details behind disclosure controls.
- Refined live assistant status spacing, elapsed-time display, and tool-step spacing while streaming.
- Improved Markdown rendering so prose examples in unlabeled fences do not become heavy code cards.
- Simplified macOS DMG layout to show only the Funplay app and Applications shortcut, even when Finder hidden files are visible.
- Updated the application icon assets to use a white rounded background instead of a transparent Dock-tinted backdrop.
- Kept the asset library on the last selected tab instead of resetting to All Assets.

### Fixed

- Fixed imported projects using the new-project form name instead of the selected folder name.
- Fixed external media attachment preview tools rejecting valid absolute local paths.
- Fixed chat management/system events such as project entry, session deletion, and session rename from being written into the visible conversation.
- Fixed duplicate image attachments that could appear from a single paste.
- Fixed packaged runtime dependency checks for additional runtime files required by updater and provider code.
- Fixed update release notes rendering raw GitHub HTML by normalizing release notes to readable text.
- Fixed automatic update checks falling back to the public GitHub Releases feed if a packaged app is missing `app-update.yml`.
- Fixed macOS split release builds leaving stale local release artifacts before rebuilding.

## 0.3.3

### Changed

- Refined first-run onboarding, project import flow, Unity environment setup, provider configuration, desktop packaging, and release notes formatting.

## 0.3.2

### Fixed

- Fixed packaged runtime dependency verification on Windows by normalizing `app.asar` entry separators before checking required runtime files.

## 0.3.1

### Fixed

- Fixed packaged macOS and Windows apps missing runtime `node_modules/*/src` JavaScript entry files required by transitive dependencies such as `@opentelemetry/api`.

### Added

- Added a packaged runtime dependency verification step to release builds so missing `app.asar` runtime entries fail before artifacts are uploaded.

## 0.3.0

### Added

- Open-source project governance files and release hardening checklist.
- Desktop UI smoke and maturity gates for light/dark app-scoped scenarios.
- Asset generation provider configuration and generation job flows.
- Split-architecture macOS release metadata validation.

### Changed

- Agent runtime architecture continues moving toward Agent Core parts as the primary ledger.
- Provider, MCP, and asset provider settings use a unified list/detail information architecture.
- Chat tool activity uses compact disclosure-style summaries after completion.

### Removed

- Legacy execution-plan runtime surface is being retired in favor of the unified agent loop.
