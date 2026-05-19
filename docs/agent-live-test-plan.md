# Agent Live Test Plan

Last updated: 2026-05-10

## Scope

This plan verifies the real Native Agent path against a live OpenAI-compatible provider and the renderer surfaces that display agent work.

The Xiaomi MiMo endpoint used during local live checks is:

- Base URL: `https://token-plan-cn.xiaomimimo.com/v1`
- Model: `mimo-v2.5-pro`
- API mode: `chat`
- API key: set only through `FUNPLAY_E2E_OPENAI_COMPAT_API_KEY`; never commit it.

The Packy Responses endpoint used during local live checks is:

- Base URL in user settings may be `https://www.packyapi.com`; Funplay normalizes Packy bare hostnames to `https://www.packyapi.com/v1` before requests.
- Model verified in this repo: `gpt-5.2`
- API mode: `responses`
- API key: set only through `FUNPLAY_E2E_OPENAI_COMPAT_API_KEY`; never commit it.

## Order

1. UI full smoke.
2. Multi-provider live subset after provider keys are available.
3. Browser automation coverage.
4. Long-task abort/resume coverage.
5. Weakly constrained natural-language Agent coverage.

## Environment

Run live checks by injecting secrets into the command environment only:

```bash
FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL="https://token-plan-cn.xiaomimimo.com/v1" \
FUNPLAY_E2E_OPENAI_COMPAT_API_KEY="<redacted>" \
FUNPLAY_E2E_OPENAI_COMPAT_MODEL="mimo-v2.5-pro" \
FUNPLAY_E2E_OPENAI_COMPAT_API_MODE="chat" \
node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "live openai-compatible provider" tests/runtime/agent-runtime.test.ts

FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL="https://www.packyapi.com" \
FUNPLAY_E2E_OPENAI_COMPAT_API_KEY="<redacted>" \
FUNPLAY_E2E_OPENAI_COMPAT_MODEL="gpt-5.2" \
FUNPLAY_E2E_OPENAI_COMPAT_API_MODE="responses" \
node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "live openai-compatible provider smoke runs|live openai-compatible provider calls a real read_file tool|live openai-compatible provider writes through guarded workspace tools|live openai-compatible provider respects plan-mode write boundary|live openai-compatible provider runs approved command in plan mode" tests/runtime/agent-runtime.test.ts

npm run agent:browser-smoke
npm run rebuild:native:force
```

## Runtime Coverage

| Area | Test | Expected Result |
|---|---|---|
| Provider connectivity | Live OpenAI-compatible smoke | Real provider returns a streamed final reply. |
| Read tools | Live `read_file` smoke | Model calls `read_file` and replies with the exact file marker. |
| Write tools | Live workspace write smoke | Model creates a directory and writes files through guarded tools. |
| Plan boundary | Live Plan-mode write request smoke | Plan mode withholds write tools; model cannot create requested files or directories. |
| Plan command permission | Live Plan-mode approved command smoke | Plan mode can run a high-risk command only after the permission broker grants it, while still not writing files. |
| Path guard recovery | Live blocked traversal recovery smoke | Build mode blocks an attempted `../` write, feeds the tool error back, then model completes a safe in-project write. |
| Tool error recovery | Live failed edit recovery smoke | A failed `edit_file` result is replayed to the model; it reads context and completes a corrected edit. |
| Persistent terminal | Live terminal lifecycle smoke | Model starts a long-running terminal command, reads output, stops the terminal, and no child process remains. |
| User input and todos | Live `ask_user` + todo smoke | Model updates todos, asks the user for a choice, consumes the answer, and completes the todo list. |
| Read/search/preview suite | Live read-only tool suite | Model scans the file tree, finds files, searches content, summarizes a directory, reads a document, and previews file/patch changes without writing. |
| Checkpoint rollback | Live multi-edit/patch rollback smoke | Model performs `multi_edit`, `patch_file`, checks the diff, reads changed content, rolls back, and verifies original content. |
| Memory tools | Live project memory smoke | Model writes long-term memory, reads recent memory, searches memory, and reads `memory.md`. |
| Subagent delegation | Live read-only subagent smoke | Model delegates a scoped read task to a subagent and uses the returned result. |
| Web/media/browser list | Live web/media/browser-list smoke | Model fetches a local web page, attaches a project file, saves base64 media, and lists browser sessions. |
| Web research plan | Live web search/fetch/write smoke | Model searches public web docs, fetches official sources, synthesizes a cited implementation plan, writes it to the workspace, and reads it back. |
| Browser automation | Electron browser tool smoke | Browser tools open a local page, snapshot DOM, type, click, read console, capture screenshot, navigate, close, and route command-like actions through permission approval. |
| Notification tasks | Live notification tool smoke | Model sends a low-priority notification, schedules a task, lists it, cancels it, and lists cancelled tasks. |
| Multi-step continuation | Live multi-file creation smoke | Model does not stop at progress text; it continues tool calls until files exist. |
| Long complex task | Live long workspace task | Model completes create/write/edit/read across several files and verifies final state. |
| Complex backend generation | Live backend system smoke | Model writes a compact Node ESM backend across package, source, tests, and README files, then source checks pass. |
| Development loop | Live test-driven backend repair smoke | Model runs failing tests first, writes the missing backend, reruns tests, and continues until they pass. |
| Natural resource setup | Live weak prompt resource smoke | Model receives a natural request, creates `assets/images`, `assets/audio`, `assets/fonts`, `assets/misc`, and writes `memory.md`. |
| Natural repair loop | Live weak prompt repair smoke | Model receives only "tests are broken", chooses tools, edits implementation, runs commands, and the external `npm test` assertion passes. |
| Tool-loop termination | Deterministic former-step-cap regression | Native main loops continue beyond the former 50-step cap and stop only on final answer, cancellation, abort, or provider/runtime error. |
| Abort/resume | Deterministic tool-boundary abort/resume regression | A run aborted after a completed tool boundary can resume with structured boundary context and continue without pseudo-tool text. |
| Plan mode | Deterministic Plan tests | Write tools are withheld, command tools remain permission-gated. |
| Protocol history | Deterministic Chat/Responses history tests | Completed tool pairs replay as protocol messages; dangling tool calls are skipped. |

## Renderer Coverage

| Area | Test | Expected Result |
|---|---|---|
| Structured assistant blocks | `agent-ui-render.test.ts` | Tool-only assistant messages do not fall back to pseudo text. |
| Streaming status | `agent-ui-render.test.ts` | Visible status uses `正在思考中...` and does not show legacy compatibility text. |
| Composer controls | `agent-ui-render.test.ts` | Chat composer shows provider and Build/Plan controls, not model/runtime selectors. |
| Permission affordance | `agent-ui-render.test.ts` | Build shows the warning marker; Plan does not. |

## Manual UI Smoke

Run:

```bash
npm run dev
```

Check the app with the live provider configured:

- Chat provider switcher changes only the provider.
- Model and runtime are changed through settings, not inline chat controls.
- Tool calls render as structured activity rows.
- Final assistant body does not contain `[Tool] ...`, `[Previous tool call]`, raw function JSON, or compatibility status text.
- Status copy is `正在思考中...`.
- Build mode can write files.
- Plan mode does not expose write tools.
- Empty directories appear in the project file tree.
- Token totals are visible in Project Settings.

## Current Verification

- `npm run build`
- Agent-only deterministic runtime suite excluding UI render tests — 195 passed, 5 skipped, 0 failed
- `npm run agent:e2e`
- Live Xiaomi MiMo Chat smoke with redacted API key
- Live Xiaomi MiMo `read_file` tool smoke with redacted API key
- Live Xiaomi MiMo `create_directory` + `write_file` tool smoke with redacted API key
- Live Xiaomi MiMo Plan-mode write boundary smoke with redacted API key — completed in 8.3s; no write tools were called and the requested file was not created
- Live Xiaomi MiMo Plan-mode approved command smoke with redacted API key — completed in 9.3s; `run_command` requested high-risk permission, was allowed, returned the expected marker, and left the project directory empty
- Live Xiaomi MiMo blocked path traversal recovery smoke with redacted API key — completed in 17.1s; the attempted `../` write stayed outside the filesystem, then the model wrote the safe in-project file
- Live Xiaomi MiMo failed `edit_file` recovery smoke with redacted API key — completed in 16.1s; the first edit failed, the model read the file, then completed the corrected edit
- Live Xiaomi MiMo persistent terminal lifecycle smoke with redacted API key — completed in 17.1s after fixing terminal stop/dispose to kill the process group; no marker process remained afterward
- Live Xiaomi MiMo `ask_user` + todo smoke with redacted API key — latest full-suite run completed in 11.1s; the model updated todos, asked for a marker choice, consumed the selected option, and completed the todo list
- Live Xiaomi MiMo read/search/preview suite with redacted API key — latest full-suite run completed in 8.8s; the model called file tree, file find, content search, directory summary, document read, diff preview, and patch preview tools without mutating files
- Live Xiaomi MiMo checkpoint rollback smoke with redacted API key — latest full-suite run completed in 28.7s; `multi_edit`, `patch_file`, `checkpoint_diff`, `read_file`, and `checkpoint_rollback` completed and restored the original file
- Live Xiaomi MiMo memory tools smoke with redacted API key — latest full-suite run completed in 10.1s; the model wrote, read recent, searched, and fetched project memory
- Live Xiaomi MiMo subagent smoke with redacted API key — latest full-suite run completed in 11.3s; the model delegated to a read-only subagent and returned the marker from the subtask
- Live Xiaomi MiMo web/media/browser-list smoke with redacted API key — latest full-suite run completed in 18.0s; local `web_fetch`, `media_attach_file`, `media_save_base64`, and `browser_list` completed
- Live Xiaomi MiMo web research plan smoke with redacted API key — completed in 29.9s; the model called `web_search`, fetched two MDN pages, wrote `docs/research-plan.md` with sources, implementation plan, and risks, then read it back
- Live Xiaomi MiMo notification task smoke with redacted API key — latest full-suite run completed in 21.6s; low-priority notify, schedule, list, cancel, and cancelled-list flow completed
- Live Xiaomi MiMo long complex task smoke with redacted API key — latest retest completed in 28.6s with `create_directory`, `write_file`, `edit_file`, and `read_file`
- Live Xiaomi MiMo backend system smoke with redacted API key — latest retest completed in 77.4s with package, source, test, and README files written; `node --check` passed for generated source/test files
- Live Xiaomi MiMo test-driven backend repair smoke with redacted API key — completed in 145.8s; the model ran an initially failing `npm test`, wrote the missing backend implementation, reran tests, and the generated project passed `npm test`
- Live Xiaomi MiMo weak natural resource setup smoke with redacted API key — completed in 23.5s; the model created resource directories and wrote `memory.md`
- Live Xiaomi MiMo weak natural repair smoke with redacted API key — completed in 202.6s; the model fixed a failing project from a natural request and the external `npm test` assertion passed
- Full Xiaomi MiMo live Agent suite — latest full-suite run completed 18 passed, 0 failed, 0 skipped in 370.9s; focused web research and weak natural-language smokes passed separately, bringing current live coverage to 21 passing Agent scenarios
- Live Packy Responses focused subset with redacted API key and `gpt-5.2` — 5 passed, 0 failed, covering streamed final reply, real `read_file`, guarded `create_directory` + `write_file`, Plan-mode write withholding, and Plan-mode approved command execution. `gpt-5.1-codex` was rejected by Packy for this key with `model_not_found`, so the verified Packy model is `gpt-5.2`.
- Focused no-fixed-step-cap regression — 55 tool calls completed and the run stopped on the final no-tool assistant reply, not on the former 50-step boundary
- Focused malformed `update_todo_list` regression — missing or invalid fields no longer crash the native loop
- Focused abort/resume regression — a Native run aborted after a completed `write_file` tool boundary, preserved the file, then resumed with structured `resume_after_last_completed_tool` context
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts`
- `npm run dev` launch smoke; Electron opened the workspace, showed Build provider controls, structured project file tree folders, and was stopped after verification
- `npm run agent:browser-smoke` — Electron browser tools opened a local page, captured DOM, typed, clicked, read console, saved a screenshot, navigated, closed, and verified permission prompts for command-like browser tools

Deferred by user direction: multi-provider live subset waits for additional provider keys.

The first oversized backend-generation live prompt hit an upstream/network `read ETIMEDOUT` after about 179s. The compact backend prompt passed afterward, so the observed failure was treated as provider connection stability rather than a local fixed tool-step cap.

Environment-dependent tools still require separate targeted runs when their backing services are configured: live `image_generate` needs an image API key, live MCP calls need an MCP server endpoint, and multi-provider live checks need the corresponding provider keys. Full browser page automation is covered by `npm run agent:browser-smoke` in an Electron runtime.

After direct Node test runs, `npm run rebuild:native:force` was run to restore the Electron `better-sqlite3` ABI.
