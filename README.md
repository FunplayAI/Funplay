# Funplay

<p align="center">
  <img src="./Logo.png" alt="Funplay" width="144" />
</p>

<p align="center">
  An AI game development workbench for turning ideas into polished playable games across modern game engines.
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41%2B-47848f?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111111" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
</p>

Funplay is an open-source desktop AI workspace for game creation. It is designed for people who have strong game ideas but do not want to fight engine setup, project structure, asset pipelines, editor menus, build steps, or the hidden complexity of modern game development.

The product vision is direct: describe the game you want, connect the engine and AI providers you trust, and let Funplay help you plan, build, generate assets, inspect runtime state, test changes, and keep the project moving toward a polished playable result.

Unity is the first-class engine workflow today. The architecture is engine-aware and not locked to one editor: MCP, engine status panels, project inspectors, tool contracts, and runtime adapters are shaped so Godot, Unreal, custom web games, and other engine workflows can share the same AI workspace over time.

## What Funplay Helps With

- Turn rough game concepts into scoped development plans.
- Break down unfamiliar engine workflows into approachable steps.
- Create and modify project files with an agent that understands the current workspace.
- Use AI providers for coding, planning, review, asset prompts, and long-running tool workflows.
- Open and inspect engine projects, starting with Unity Editor and Unity MCP workflows.
- Generate and manage game assets, including 2D images, UI, textures, audio, 3D, and animation-oriented jobs.
- Keep tool calls visible through compact summaries, detail overlays, permission checks, and recovery metadata.
- Store projects, sessions, provider settings, generated assets, and agent run history locally.

## Highlights

- Project-first desktop workspace: sessions, files, assets, providers, and engine state live around a real local project.
- Native agent runtime: file reading, patching, terminal, browser inspection, web search, MCP, memory, notifications, and checkpoint tools.
- Multi-provider setup: OpenAI-compatible providers, Anthropic, Google, Bedrock, and custom endpoints.
- Asset Generation Center: provider-backed generation jobs with deterministic output naming and project asset discovery.
- Engine integration layer: Unity workflow support today, with a path toward additional engines through MCP and engine adapters.
- Local-first persistence: SQLite-backed project/session state with secrets kept in the main process.
- Desktop packaging automation for macOS split-architecture builds and Windows installers.

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

## Agent And Engine Architecture

Funplay separates runtime orchestration from provider and engine integrations:

- `electron/main/agent-core/` owns runtime-agnostic orchestration: run registry, controller, permissions, event flow, checkpoints, and transcript ledger behavior.
- `electron/main/agent-platform/` owns provider-specific runtime adapters, tool contracts, MCP integration, engine control tools, and workspace actions.
- `src/` projects Agent Core parts into the desktop transcript, settings pages, asset library, engine panel, and generation center.

The target shape is one agent message stream as the source of truth. UI, operation logs, persistence views, and tool detail panels are projections from that stream rather than competing ledgers.

## Providers, Assets, And Secrets

Funplay supports separate configuration for chat/model providers, asset-generation providers, and MCP servers. API keys are stored by the main process secret store and are not sent to the renderer.

Useful environment variables for development:

- `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` - allow local URL fetches in web tool tests.
- `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` - enable web search providers.

## Development

Start the app locally:

```bash
npm install
npm run dev
```

`npm run dev` rebuilds native Electron dependencies for the correct ABI and starts the Electron Vite development server.

On first launch:

1. Open Application Settings.
2. Add at least one AI provider.
3. Create or open a game project.
4. Choose the runtime, model, permission mode, and engine workflow.
5. Start with a goal such as "make a playable web demo" or "open this Unity project and add the first level loop."

Common development commands:

```bash
npm run dev                 # Start the desktop app in development mode
npm run build               # Type-check and build all Electron targets
npm run test:runtime        # Run runtime tests with native ABI handling
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

## Project Status

Funplay is pre-1.0. The public release line starts at `v0.3.0`, with current stabilization focused on:

- multi-engine agent workflows
- native tool reliability and permission clarity
- provider and asset-generation contracts
- desktop UI polish
- packaging, signing, and update metadata automation

## License

Funplay is licensed under the [MIT License](LICENSE).
