# Changelog

All notable changes to Funplay will be documented in this file.

This project follows a pre-1.0 release flow. Minor versions may include breaking changes while the agent runtime, desktop UI, and provider contracts are still stabilizing.

## Unreleased

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
