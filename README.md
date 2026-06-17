# Funplay

<p align="center">
  <img src="./Logo.png" alt="Funplay" width="144" />
</p>

<p align="center">
  An open-source desktop AI workbench for building playable games with real project files, engine context, and agent tools.
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

Funplay helps game ideas survive contact with the actual project. It combines a local-first Electron workspace, a built-in multi-provider AI agent runtime, engine-aware onboarding, MCP integrations, file editing, terminal tools, browser inspection, asset workflows, and release-grade verification.

The goal is simple: describe the game you want, connect the model and engine tools you trust, and let the agent plan, inspect, edit, run checks, generate assets, and keep the project moving toward something playable.

## What Funplay Helps With

- Turn rough game concepts into scoped implementation plans.
- Create, inspect, and modify local project files with checkpointed agent tools.
- Run commands, read logs, inspect browser previews, search files, and recover from failed edits.
- Use OpenAI-compatible providers, Anthropic, Google, Bedrock, Vertex, and custom endpoints.
- Connect project-bound MCP servers and expose their tools/resources to the agent.
- Work with Unity and Cocos projects through engine-aware diagnostics, bridge installation, open-project actions, and runtime state checks.
- Generate and manage game assets, including image, UI, texture, audio, 3D, and animation-oriented jobs.
- Keep provider settings, secrets, projects, sessions, generated assets, and agent run history local.

## Engine Support

| Engine | Status | Current capabilities |
| --- | --- | --- |
| Unity | Real adapter | Unity Hub/Editor diagnostics, project opening, bridge installation, MCP connectivity, `unity://` resource reads, runtime state refresh. |
| Cocos Creator | Real adapter | Creator 3 project import/create flow, 2D/3D onboarding, `funplay-cocos-mcp` installation, MCP connectivity checks, `cocos://` resource reads. |
| Cocos4 / cocos-cli | Real adapter path | Headless project creation/opening through `cocos-cli`, supervised CLI server flow, prerequisite diagnostics, managed MCP startup. |
| Web / generic | Project inspector | Workspace/file/browser workflows and playable HTML preview guidance; no engine adapter side effects. |
| Godot / Unreal | Contract stubs | Structured unsupported responses with platform, capability, reason, and next action. |

## Agent Runtime

Funplay's native runtime is a project-first tool loop with provider-neutral orchestration:

- Workspace tools: read/search files, write files, apply patches, multi-edit, run commands, persistent terminals, checkpoints.
- Runtime tools: browser inspection, web search/fetch, memory, notifications, media attachments, document reads, project inspection.
- MCP tools: list/call tools, read resources, and materialize project MCP tools directly when policy allows.
- Safety controls: permission broker, command sandboxing, write checkpoints, active verification after workspace or engine side effects, structured tool-result summaries, and replayable operation logs.
- Context controls: model-summary compaction, project evidence, recent-file context, provider capability registry, and multimodal input when the model supports vision.
- Subagents: local project definitions under `.claude/agents` or `.funplay/agents`, read-only investigator mode, worker tool pools, and persisted background run records.

## Repository Layout

```text
electron/main/      Main-process services, IPC handlers, persistence, agent platform
electron/preload/   Secure context bridge exposed as window.funplay
src/                React 19 renderer UI
shared/             Cross-process types and pure shared logic
tests/runtime/      Node runtime unit tests
tests/e2e/          Deterministic agent E2E task fixtures
tests/eval/         Agent evaluation scaffolding
scripts/            Build, smoke, benchmark, release, and native ABI helpers
resources/          Packaged assets and runtime placeholders
release/            electron-builder output (gitignored)
```

Important boundaries:

- Renderer code in `src/` must not import from `electron/main/`.
- Main-process code in `electron/main/` must not import from `src/`.
- Cross-process contracts belong in `shared/` and `electron/preload/index.ts`.
- New IPC requires type updates, preload exposure, main handler wiring, and Zod validation.

## Architecture

Funplay deliberately separates orchestration from platform integrations:

- `electron/main/agent-core/` owns runtime-agnostic state, controller transitions, replay, Agent Core parts, and the single message stream used by UI and persistence.
- `electron/main/agent-platform/native/` owns the built-in provider loop for Anthropic, Google, Bedrock, Vertex, OpenAI-compatible Chat Completions, OpenAI-compatible Responses, and Anthropic Messages-compatible endpoints.
- `electron/main/agent-platform/tools/` owns registered agent tools and their risk, permission, checkpoint, and UI action metadata.
- `electron/main/agent-platform/engine-adapters.ts` defines the engine adapter contract used by `tools/engine-control.ts`.
- `src/` projects Agent Core parts into chat transcripts, process timelines, settings pages, asset views, engine panels, and replayable run history.

The target shape is one authoritative agent event stream. UI, operation logs, persistence, verification reports, and detail panels are projections of that stream, not competing ledgers.

## Providers, MCP, Assets, And Secrets

Funplay supports separate configuration for:

- chat/model providers
- asset-generation providers
- project MCP servers
- engine bridges
- web search providers

API keys are stored by main-process secret stores and are never sent to the renderer. The renderer talks to the app only through the typed `window.funplay` preload bridge.

Useful development environment variables:

- `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` - allow local URL fetches in web-tool tests.
- `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` - enable web search providers.
- `FUNPLAY_COCOS_MCP_LOCAL_SOURCE=/path/to/funplay-cocos-mcp` - install the Cocos bridge from a local checkout during development.

## Development

Install dependencies and start the desktop app:

```bash
npm install
npm run dev
```

`npm run dev` rebuilds native Electron dependencies for the correct ABI and starts Electron Vite.

On first launch:

1. Open Application Settings.
2. Add at least one AI provider.
3. Create or import a project.
4. Choose a workflow: Generic, Unity, or Cocos.
5. For engine projects, complete the onboarding checklist and connect the engine bridge/MCP server.
6. Start with a concrete goal such as "make a playable web prototype", "add a Unity level loop", or "create a Cocos 3D scene and verify the MCP connection."

Common commands:

```bash
npm run dev                 # Start the desktop app in development mode
npm run build               # Rebuild native deps, type-check, and build Electron targets
npm run test                # Run runtime tests with native ABI handling
npm run test:runtime        # Same runtime test suite, explicit script
npm run agent:e2e           # Deterministic scripted-provider agent E2E checks
npm run agent:benchmark     # Agent benchmark gate used by release workflow
npm run ui:smoke            # Static desktop UI smoke checks
npm run ui:electron-smoke   # Real Electron UI smoke scenarios
npm run ui:maturity-gate    # UI maturity gate
npm run runtime:maturity-gate # Runtime maturity gate
npm run release:gate        # Full local release gate
```

Packaging:

```bash
npm run dist:mac:split
npm run release:verify-mac-updates
npm run dist:win:x64
```

`better-sqlite3` must match either the Node ABI or Electron ABI. `npm run test:runtime` handles the switch automatically. If you run a single Node test manually, restore Electron ABI afterward:

```bash
npm run rebuild:native:force
```

## Release Flow

Releases are published from GitHub Actions by pushing a version tag:

1. Bump `package.json` / `package-lock.json`.
2. Update `CHANGELOG.md`.
3. Run `npm run build`, `npm test`, `npm run agent:e2e`, and `npm run release:gate`.
4. Commit, push `main`, create an annotated `vX.Y.Z` tag, and push the tag.
5. The release workflow builds macOS arm64, macOS x64, and Windows x64 artifacts, then publishes a GitHub Release.

Windows update metadata expects `Funplay-Setup-X.Y.Z.exe`; the release workflow also preserves the electron-builder dotted installer name for compatibility.

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

For packaging or release changes, also run:

```bash
npm run release:audit
npm run release:gate
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository boundaries and PR expectations.

## License

Funplay is licensed under the [MIT License](LICENSE).
