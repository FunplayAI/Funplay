# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

- `npm run dev` — rebuilds native modules for Electron, then starts electron-vite dev. Use this for local app development.
- `npm run build` — runs `tsc --noEmit` and produces production bundles in `out/`. Run this before opening a PR.
- `npm run test` / `npm run test:runtime` — runtime regression suite. The script rebuilds `better-sqlite3` for Node, executes `node --test tests/runtime/*.test.ts` (using `tests/register-ts-loader.mjs` to import TS directly via `--experimental-strip-types`), then rebuilds it back for Electron. **Always go through `npm run test:runtime`** rather than invoking `node --test` directly, otherwise the next `npm run dev` will crash on a NODE_MODULE_VERSION mismatch.
- Run a single test file: `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/<file>.test.ts` (then `npm run rebuild:native:force` to restore Electron bindings).
- `npm run agent:e2e` — deterministic agent end-to-end harness (no live API).
- `npm run agent:e2e:claude-live` — live Claude SDK runtime E2E. Requires `FUNPLAY_E2E_CLAUDE_API_KEY` and `FUNPLAY_E2E_CLAUDE_MODEL`.
- `npm run runtime:maturity-gate` (or `:live`) — orchestrates build + runtime tests + agent E2E. The GitHub Actions workflow is manual-only to avoid burning hosted runner quota; `npm run release:gate` still uses this as a release precondition.
- `npm run dist` (alias for `dist:mac:arm64`) — packages the default macOS arm64 build. `dist:mac:x64` builds the Intel package and runs `ensure:claude-sdk:darwin-x64` first so the x64 Claude Agent SDK native binary is present. `dist:win:x64` builds the Windows x64 artifact.
- `npm run rebuild:native[:force]` / `npm run check:native` — manually rebuild or verify `better-sqlite3` for the current Electron ABI.
- `npm run lint` / `npm run format` / `npm run format:check` — ESLint and Prettier across `electron/`, `shared/`, `src/`, and `tests/`. Not part of `npm run build`; run separately if you want to lint.

## Architecture

### Process layout (electron-vite)

- `electron/main/` — main process services, IPC handlers, persistence, agent runtimes. Entry: `electron/main/index.ts`.
- `electron/preload/index.ts` — `contextBridge` exposing the typed `FunPlayApi` (defined in `shared/types.ts`) to the renderer.
- `src/` — React 19 renderer (`src/App.tsx`, `src/components/...`).
- `shared/` — cross-process types, provider catalog, planner helpers, project session helpers. Anything imported by both main and renderer lives here.
- `index.html` is the renderer entry; `electron.vite.config.ts` wires the three build targets.

### Agent runtime layering

The current agent stack is centered in `electron/main/agent-platform/`. It owns both host-level orchestration and provider/runtime implementations:

- Orchestration modules — `stream-manager.ts`, `task-executor.ts`, `run-registry.ts`, `permission-registry.ts`, `user-input-registry.ts`, `state-adapter.ts`, persistence helpers, and execution-plan state modules. `stream-manager.ts` is the IPC-facing entry from `index.ts`.
- Runtime registry — `runtime-registry.ts` registers three `GenericAgentRuntime` implementations on first use:
  - `nativeRuntime` (`native/runtime.ts` → `native/loop.ts` / `native/tool-loop.ts`) — provider-driven native tool loop, with host-controlled workspace tools, file checkpoints, permission gating, OpenAI-compatible streaming adapters, and context handoff (`native/context-handoff.ts`).
  - `claudeCodeSdkRuntime` (`claude/runtime.ts`) — wraps `@anthropic-ai/claude-agent-sdk` or the legacy CLI path. Active when the resolver in `provider-resolver.ts` recognizes a Claude-side model or when the runtime strategy is forced.
  - `executionPlanRuntime` (`execution-plan-runtime.ts`) — drives multi-step "execute plan" runs.
- Shared tool and safety layer — workspace tools, MCP wiring, file checkpointing, terminal sessions, browser inspection, web research, and permission session storage live under `agent-platform/` and are consumed by runtimes through `tool-registry.ts`, `permission-broker.ts`, and `workspace-tools.ts`.

Resolution lives in `resolveGenericAgentRuntime`: an explicit `runtimeId` is treated as a strict selection; otherwise the runtime strategy or provider determines the choice, with automatic fallback to the native runtime where appropriate.

### Storage

Persistence is SQLite via `better-sqlite3`. The store is split between `electron/main/store.ts` (top-level API) and `electron/main/store-internal/` (schema, row types, project records, runtime runs, file-checkpoint blobs, permission audits, state persistence). Because `better-sqlite3` is a native module, ABI mismatches between Node and Electron are the most common breakage — see the test command notes above.

### Providers and IPC contracts

- Provider definitions and the user-facing catalog live in `shared/provider-catalog.ts` (consumed by the renderer) and are realized in main via `electron/main/provider-service.ts`, `text-generator.ts`, and `openai-compatible-client.ts`. API keys are kept in `provider-secret-store.ts` and never sent to the renderer.
- IPC handlers are grouped by domain under `electron/main/ipc-handlers/` (agent, project, claude, mcp, unity, provider, settings, skills, memory, etc.) and wired up by `register*` calls from `electron/main/index.ts#registerIpcHandlers`. Payloads are validated via Zod schemas in `electron/main/ipc-validation.ts`. The renderer talks to them only through the `FunPlayApi` shape declared in `shared/types.ts`; when adding a handler, update all four touch points (the handler module, `index.ts` registration, `ipc-validation.ts`, and `FunPlayApi` + `electron/preload/index.ts`).

### Packaging notes

`package.json#build` unpacks `@anthropic-ai/claude-agent-sdk*` from the asar bundle (the SDK ships native binaries), excludes `resources/runtime/**` (large preview runtimes that are downloaded on first use; see `scripts/prepare-pptx-runtime.mjs`), and filters source maps, type declarations, docs/tests, and native build sources from packaged dependencies. Auto-update is generic-provider against an Aliyun OSS bucket — see `docs/release-update-flow.md`.

## Repo conventions

- TypeScript is `strict` with `noEmit` (Vite/electron-vite handle compilation; `tsc` is type-check only).
- Keep cross-process types in `shared/` — never import from `electron/main/` inside `src/` or vice versa; go through the preload `FunPlayApi`.
- Design docs live in `docs/` (architecture, agent runtime, AI provider, MCP plugin, UX, roadmap). Many include rationale for current code structure and are useful when extending the runtime or provider layers.
- UI styling is token-driven: `src/styles/tokens.css` is the single source of truth for color/spacing/type/elevation/motion, documented in `docs/design-tokens.md`. Dark theme overrides token *values* only — component CSS must never reference `[data-theme='dark']` (the `npm run ui:smoke` gate enforces this). New theme-aware styling references `--fp-*` tokens.
- Global CSS lives under `src/styles/`: `tokens.css`, then `base/foundation.css`, `components/primitives.css`, and ordered `layers/NN-*.css` slices, all wired through the `src/styles/index.css` barrel (imported once by `src/main.tsx`). The layer slices preserve the original generational cascade order — only append, never reorder. New component styles must be co-located CSS Modules (`<Name>.module.css`); plain `.css` files under `src/components/` are rejected by `npm run ui:smoke`.
- `AGENTS.md` is a condensed companion to this file aimed at non-Claude agents — keep the two in sync when changing commands, the ABI gotcha, or the high-level architecture map.

## Useful environment variables (development)

- `FUNPLAY_CLAUDE_CODE_CLI_PATH` — override the Claude Code CLI executable path.
- `FUNPLAY_CLAUDE_CODE_FORCE_CLI=1` — force the legacy Claude CLI stream path.
- `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` — allow local URL fetches during web tool tests.
- `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` — enable the corresponding web search providers.
- `FUNPLAY_E2E_CLAUDE_API_KEY` + `FUNPLAY_E2E_CLAUDE_MODEL` — required by the live Claude E2E and the maturity gate's live mode.
