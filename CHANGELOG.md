# Changelog

All notable changes to Funplay will be documented in this file.

This project follows a pre-1.0 release flow. Minor versions may include breaking changes while the agent runtime, desktop UI, and provider contracts are still stabilizing.

## Unreleased

### Changed

- Simplified macOS DMG layout to show only the Funplay app and Applications shortcut, even when Finder hidden files are visible.
- Redesigned the empty welcome screen around the game development workbench workflow with clearer project entry points and capability summaries.

### Added

- Added release audit checks to keep DMG packaging free of hidden background and volume icon files.

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
