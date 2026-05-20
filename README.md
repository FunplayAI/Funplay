# FunPlay

<p align="center">
  <img src="./Logo.png" alt="FunPlay" width="144" />
</p>

<p align="center">
  Project-first AI agent desktop workspace for game prototyping, Unity automation, and multi-provider runs.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41%2B-47848f?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

FunPlay 是一个面向游戏原型和 Unity 工作流的 AI Agent 桌面工作台。

它把 Electron 桌面壳、React 19 界面、SQLite 持久化、多个模型提供方、以及可见的 agent 运行轨道整合在一起，让你可以围绕一个真实项目来做上下文、工具调用、权限控制、checkpoint 和回放，而不是只做一个聊天框。

## What You Get

| Area | What it covers |
| --- | --- |
| Project-first chat | Projects, sessions, file trees, and prompt streams stay bound to local workspace context. |
| Agent runtimes | Native runtime, Claude Code SDK runtime, and execution-plan runs. |
| Model providers | OpenAI-compatible, Anthropic, Google, and Bedrock-backed providers. |
| Workspace tools | File read/write, patching, terminal, browser inspection, web search, memory, notifications, and rollback checkpoints. |
| Unity automation | MCP-based Unity inspection and automation flows. |
| Observability | Runtime status, usage totals, tool boundaries, recovery metadata, and replay logs. |
| Local storage | SQLite persistence through `better-sqlite3`, with project/session state kept on device. |

## Quick Start

```bash
npm install
npm run dev
```

`npm run dev` rebuilds native dependencies for Electron and starts the desktop app.

## First Launch

1. Start the app with `npm run dev`.
2. Open the Providers screen and add the model providers you want to use.
3. Create or open a project.
4. Pick a session runtime, permission mode, and model.
5. Start chatting with the project-aware agent.

## Build And Test

```bash
npm run build
npm run test:runtime
```

Useful extra commands:

```bash
npm run agent:e2e
npm run runtime:maturity-gate
npm run dist
npm run dist:win:x64
```

## Repository Layout

```text
src/                    React renderer UI
electron/main/           Main-process services, IPC, persistence, runtimes
electron/preload/        Secure bridge exposed to the renderer
shared/                  Cross-process types and shared planner/provider logic
tests/                   Runtime and E2E tests
scripts/                 Build, E2E, and release-gate helpers
docs/                   Active architecture and improvement notes
resources/               App icons and downloadable runtime assets
```

## Configuration

Common development environment variables:

- `FUNPLAY_CLAUDE_CODE_CLI_PATH` - override the Claude Code CLI executable path.
- `FUNPLAY_CLAUDE_CODE_FORCE_CLI=1` - force the legacy Claude CLI stream path.
- `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` - allow local URL fetches in web tool tests.
- `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` - enable web search providers.
- `FUNPLAY_E2E_CLAUDE_API_KEY` + `FUNPLAY_E2E_CLAUDE_MODEL` - enable live Claude SDK E2E.

Provider API keys stay in the main process secret store and are not sent to the renderer.

## Documentation

- [Architecture and improvement plan](docs/agent-architecture-improvement-plan.md)
- [Claude Code working notes](CLAUDE.md)
- [Runtime asset notes](resources/runtime/README.md)

## Development Notes

- Keep shared IPC contracts and cross-process types in `shared/`.
- Keep main-process logic in `electron/main/`.
- Keep renderer components in `src/`.
- Run `npm run build` before opening a pull request.
- Use `npm run test:runtime` instead of raw `node --test` so native dependencies are rebuilt for the right ABI.

## Status

FunPlay is under active development. The current implementation is strongest in:

- desktop project/session management
- agent runtime orchestration
- Unity-oriented tooling
- usage and replay observability
- checkpoint and rollback handling

## License

No license has been published yet. Treat the repository as source-available until a license file is added.
