# Changelog

All notable changes to Funplay will be documented in this file.

This project follows a pre-1.0 release flow. Minor versions may include breaking changes while the agent runtime, desktop UI, and provider contracts are still stabilizing.

## Unreleased

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
