# Security Policy

Funplay is a desktop AI agent workspace with local file, terminal, MCP, browser, model-provider, and asset-generation integrations. Please treat security reports seriously, especially when they involve command execution, project file access, API keys, or cross-process IPC.

## Supported Versions

Funplay is currently pre-1.0. Security fixes target the active `main` branch unless a release branch is explicitly announced.

## Reporting A Vulnerability

Please do not open a public issue for sensitive reports. Use GitHub private vulnerability reporting for this repository.

Send a private report to the project maintainers with:

- A clear description of the vulnerability
- Reproduction steps
- Impact and affected platform
- Relevant logs, screenshots, or proof-of-concept code
- Whether credentials, API keys, local files, or network services are involved

If private vulnerability reporting is unavailable, create a minimal public issue asking for a security contact without including exploit details.

## Scope

High-priority areas include:

- IPC validation and preload bridge exposure
- API key and provider secret storage
- Terminal, file edit, browser, MCP, and asset-generation tools
- Auto-update metadata and release artifact integrity
- Local project file access outside the selected workspace
- Prompt or tool-result paths that could trigger unintended side effects

## Disclosure

The maintainers will acknowledge valid reports, coordinate a fix, and publish remediation notes when appropriate.
