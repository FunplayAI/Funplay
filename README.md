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

## Release And Updates

FunPlay publishes desktop updates through [GitHub Releases](https://github.com/FunplayAI/Funplay/releases). Packaged builds use the GitHub provider configured in `package.json#build.publish`; development builds do not use a private update feed override.

For macOS release checks:

```bash
npm run dist:mac:split
npm run release:verify-mac-updates
npm run rebuild:native:force
```

For Windows x64:

```bash
npm run dist:win:x64
npm run rebuild:native:force
```

Release publishing requires `GH_TOKEN` in the publishing environment. macOS signing and notarization still require Apple Developer credentials.

The repository also includes a tag-based GitHub Actions release workflow. Pushing a tag such as `v0.3.0` builds macOS arm64/x64 and Windows x64 artifacts, verifies macOS update metadata, and creates or updates a draft GitHub Release. Required maintainer secrets:

- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `MAC_CSC_LINK` (base64-encoded `.p12` containing a Developer ID Application certificate)
- `MAC_CSC_KEY_PASSWORD`

## Documentation

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

FunPlay is licensed under the [MIT License](LICENSE).
