# Funplay

<p align="center">
  <img src="./Logo.png" alt="Funplay" width="144" />
</p>

<p align="center">
  A project-first desktop AI workspace for game prototyping, Unity automation, and multi-provider agent runs.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41%2B-47848f?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111111" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
</p>

Funplay is an open-source desktop app for building and iterating on game projects with AI agents. It combines a local project workspace, chat sessions, file tools, terminal execution, MCP integrations, asset generation, provider management, and release-ready desktop packaging.

The goal is not to be another generic chat client. Funplay is built around a real project folder and a visible agent run loop, so model output, tool calls, permissions, project files, checkpoints, and generated assets all stay tied to the work you are doing.

## Highlights

- Project-first sessions with local file tree context and persistent conversation history.
- Native agent runtime with file, patch, terminal, browser, web search, MCP, memory, notification, and checkpoint tools.
- Claude Code SDK runtime support for users who want Claude Code-style project automation.
- OpenAI-compatible, Anthropic, Google, Bedrock, and custom provider configuration.
- Asset Generation Center for image, UI, texture, audio, 3D, animation, and provider-backed generation jobs.
- Unity-oriented engine panel and MCP workflows for opening projects, checking editor state, and driving Unity tools.
- Compact agent transcript UI with tool summaries, detail overlays, markdown/code rendering, and running-state recovery.
- Local-first persistence through SQLite. Provider secrets stay in the main process and are not exposed to the renderer.

## Quick Start

```bash
npm install
npm run dev
```

`npm run dev` rebuilds native Electron dependencies for the correct ABI and starts the Electron Vite development server.

On first launch:

1. Open Application Settings.
2. Add at least one AI provider.
3. Create or open a project.
4. Start a session and choose the runtime, model, and permission mode.

## Common Commands

```bash
npm run dev                 # Start the desktop app in development mode
npm run build               # Type-check and build all Electron targets
npm run test:runtime        # Run runtime tests with the right native ABI handling
npm run ui:smoke            # Renderer UI smoke checks
npm run ui:electron-smoke   # Electron UI smoke scenarios
npm run ui:maturity-gate    # UI maturity gate
npm run agent:e2e           # Deterministic agent E2E checks
```

Packaging:

```bash
npm run dist:mac:split
npm run release:verify-mac-updates
npm run dist:win:x64
```

If you run a single Node test manually, rebuild native modules for Electron afterward:

```bash
npm run rebuild:native:force
```

## Repository Layout

```text
electron/main/      Main-process services, IPC handlers, storage, agent runtimes
electron/preload/   Secure context bridge exposed to the renderer
src/                React renderer UI
shared/             Cross-process types, provider catalog, shared planners
tests/              Runtime and deterministic agent tests
scripts/            Build, smoke, benchmark, and release helper scripts
resources/          Icons and runtime asset placeholders
```

Important boundaries:

- Renderer code in `src/` must not import from `electron/main/`.
- Main-process code in `electron/main/` must not import from `src/`.
- Cross-process contracts belong in `shared/` and the preload bridge.
- New IPC requires type updates, preload exposure, main handler wiring, and Zod validation.

## Agent Architecture

Funplay has two major runtime layers:

- `electron/main/agent-core/` owns runtime-agnostic orchestration: run registry, controller, permissions, event flow, checkpoints, and transcript ledger behavior.
- `electron/main/agent-platform/` owns provider-specific runtime adapters, including the native runtime, Claude Code runtime wiring, provider event adapters, and tool infrastructure.

The current direction is a single Agent Core parts/message stream as the source of truth. UI, operation logs, persistence views, and tool detail panels are projections from that stream rather than separate ledgers.

## Providers And Secrets

Model and asset providers are configured inside the app. API keys are stored by the main process secret store and are not sent to the renderer.

Useful environment variables for development:

- `FUNPLAY_CLAUDE_CODE_CLI_PATH` - override the Claude Code CLI executable path.
- `FUNPLAY_CLAUDE_CODE_FORCE_CLI=1` - force the legacy Claude CLI stream path.
- `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` - allow local URL fetches in web tool tests.
- `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` - enable web search providers.
- `FUNPLAY_E2E_CLAUDE_API_KEY` + `FUNPLAY_E2E_CLAUDE_MODEL` - enable live Claude SDK E2E checks.

## Release And Updates

Funplay publishes desktop builds through [GitHub Releases](https://github.com/FunplayAI/Funplay/releases). The packaged app uses the GitHub provider configured in `package.json#build.publish`.

The tag-based GitHub Actions release workflow builds macOS arm64/x64 and Windows x64 artifacts, verifies macOS update metadata, uploads release assets, and publishes a public GitHub Release after all gates pass.

Required maintainer secrets:

- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `MAC_CSC_LINK` - base64-encoded `.p12` containing a Developer ID Application certificate
- `MAC_CSC_KEY_PASSWORD`

Release configuration checks:

```bash
npm run release:audit
npm run release:gate
```

## Contributing

Small, focused pull requests are easiest to review. Before opening a PR, run:

```bash
npm run build
npm run test:runtime
```

For UI changes, also run:

```bash
npm run ui:smoke
npm run ui:electron-smoke
npm run ui:maturity-gate
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository boundaries and PR expectations.

## Security

Funplay can access local files, run terminal commands, call external model providers, connect to MCP servers, and automate engine workflows. Please report security issues privately.

See [SECURITY.md](SECURITY.md) for the reporting process and high-priority security areas.

## Status

Funplay is pre-1.0 and moving quickly. The public release line starts at `v0.3.0`, with the main stabilization work focused on:

- agent runtime reliability
- provider and tool contract consistency
- desktop UI polish
- asset generation workflows
- packaging, signing, update metadata, and release automation

## License

Funplay is licensed under the [MIT License](LICENSE).
