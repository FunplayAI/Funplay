# AGENTS.md

Compact guidance for working in this repo. See `CLAUDE.md` for the full architectural reference.

## Commands

```bash
npm run dev                # Rebuilds better-sqlite3 for Electron, then starts electron-vite dev server
npm run build              # tsc --noEmit + electron-vite build → out/
npm run test               # Alias for test:runtime
npm run test:runtime       # Rebuilds better-sqlite3 for Node, runs tests, rebuilds back for Electron
npm run agent:e2e          # Deterministic agent E2E (no live API)
npm run dist               # macOS arm64 build → release/
```

### Single test file

```bash
node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/<file>.test.ts
npm run rebuild:native:force   # REQUIRED after — restores Electron ABI or next `npm run dev` crashes
```

### Verification order before PRs

`npm run build` (typecheck + bundle) then `npm run test:runtime`.

There is no separate lint or format command — only `tsc --noEmit`.

## Critical gotcha: better-sqlite3 ABI

`better-sqlite3` is a native module and must match the runtime ABI (Electron vs Node). The wrapper scripts (`test:runtime`, `dev`, `rebuild:native:force`) handle this, but:

- **Never run `node --test` directly** without going through `npm run test:runtime` or manually rebuilding afterward.
- If `npm run dev` crashes with `NODE_MODULE_VERSION` mismatch, run `npm run rebuild:native:force`.

## Architecture

Electron app built with electron-vite (three targets: main, preload, renderer).

| Directory | Role | Import boundary |
|---|---|---|
| `electron/main/` | Main-process services, IPC, persistence, agent runtimes | Never import from `src/` |
| `electron/preload/` | `contextBridge` exposing `FunPlayApi` to renderer | — |
| `src/` | React 19 renderer UI | Never import from `electron/main/` |
| `shared/` | Cross-process types, provider catalog, planners | Shared by all |

**Cross-process contract:** Renderer ↔ Main communication goes through `FunPlayApi` in `shared/types.ts` via the preload bridge. When adding an IPC handler, update: `shared/types.ts`, `electron/preload/index.ts`, `electron/main/index.ts`, and `electron/main/ipc-validation.ts` (Zod schemas).

### Agent runtime (two layers)

- `electron/main/agent-core/` — orchestration: run registry, permissions, stream manager, engines. Runtime-agnostic.
- `electron/main/agent-platform/` — provider-specific implementations:
  - **Native runtime** (`native/`) — AI SDK provider loop with workspace tools, checkpoints, permissions.
  - **Claude Code SDK runtime** (`claude/`) — wraps `@anthropic-ai/claude-agent-sdk`.
  - **Execution plan runtime** — multi-step plan execution.
  - Shared tool/permission infrastructure consumed by all runtimes.

### Storage

SQLite via `better-sqlite3`. API in `electron/main/store.ts`, internals in `electron/main/store-internal/`.

### Providers

Provider catalog: `shared/provider-catalog.ts`. Realized in main via `provider-service.ts`, `text-generator.ts`, `openai-compatible-client.ts`. API keys in `provider-secret-store.ts` — never sent to renderer.

## Conventions

- **TypeScript strict, `noEmit`** — Vite handles compilation; `tsc` is type-check only.
- **ESM throughout** (`"type": "module"` in package.json). Preload uses CJS output format (electron-vite config).
- **No comments in code** unless explicitly asked.
- Test runner: Node.js built-in `--test` with a custom TS extension loader (`tests/register-ts-loader.mjs` → `tests/ts-extension-loader.mjs`) that resolves `.ts` imports without a build step.
- IPC validation uses **Zod 4** schemas in `ipc-validation.ts`.
- `resources/runtime/**` is gitignored except `.gitkeep` — large preview runtimes downloaded on first use.

## GitHub Actions

`.github/workflows/runtime-maturity-gate.yml` is manual-only to avoid burning hosted runner quota:
- `npm run runtime:maturity-gate` (dry — build + runtime tests + agent E2E, no live API)
- Optional manual live run: `runtime:maturity-gate:live` adds live Claude SDK E2E (requires secrets)

The manual workflow uses Node 22.

## Environment variables

| Variable | Purpose |
|---|---|
| `FUNPLAY_CLAUDE_CODE_CLI_PATH` | Override Claude Code CLI binary path |
| `FUNPLAY_CLAUDE_CODE_FORCE_CLI=1` | Force legacy CLI stream path |
| `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` | Allow local URL fetches in web tool tests |
| `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` | Enable web search providers |
| `FUNPLAY_E2E_CLAUDE_API_KEY` + `FUNPLAY_E2E_CLAUDE_MODEL` | Live Claude E2E tests |
