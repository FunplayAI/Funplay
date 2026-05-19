# Agent Maturity Roadmap

Last updated: 2026-05-11

## Goal

Evolve Funplay Agent from a working tool-calling runtime into a product-grade development partner:

- Understand natural project goals with minimal prompt scaffolding.
- Plan, execute, verify, and repair work without pretending incomplete work is done.
- Persist enough structured state to resume safely after interruption, restart, provider failure, or user pause.
- Keep permissions, provider failures, token usage, and file changes visible and auditable.
- Improve through repeatable deterministic and live benchmarks rather than anecdotal manual testing.

## Principles

1. Main path first: mature the Native runtime before adding new side paths.
2. Structured state over text parsing: UI, resume, evals, and audits consume typed parts/events.
3. Permissions only at execution points: planning and model text do not grant authority.
4. Verification is part of completion: final answers should summarize what was verified.
5. Provider differences live in capability profiles and conformance tests.
6. Live tests are small, realistic, and intentionally scoped to avoid accidental spend.

## Roadmap

| ID | Phase | Status | Outcome |
|---|---|---|---|
| M1 | Stateful Agent Core | Completed | Runs persist structured events, tool boundaries, checkpoints, usage, and resumable state. |
| M2 | Provider Conformance | Completed | Common providers are tested against capability profiles and supplied live providers produce actionable diagnostics. |
| M3 | Tool Reliability | Completed | File, terminal, browser, web, MCP, and media tools return structured results and recovery hints. |
| M4 | Work Verification UX | Completed | Chat and Project Settings show concise typed progress, changed files, validation results, permission impact, and recovery entry points. |
| M5 | Context And Memory | Completed | Project facts, user preferences, decisions, and temporary task state are separated and auditable. |
| M6 | Task Planning Engine | Completed | Complex jobs run as checkpointed steps with retries, subagents, and explicit success criteria. |
| M7 | Benchmark Gate | Completed | Deterministic, mocked-provider, live-provider, and product-task suites track completion quality. |
| M8 | Funplay Domain Agent | Completed | Game-project workflows include assets, playable checks, browser screenshots, and Unity/MCP paths. |

## Execution Plan

### M1: Stateful Agent Core

| Requirement | Status | Notes |
|---|---|---|
| Persist structured runtime event logs. | Completed | `runtime_runs.events_json` stores status, timeline, tool use/result, tool boundary, usage, and final outcome events. |
| Replay run event logs from export. | Completed | `AgentReplayLog` now includes `events` alongside timeline, usage, and recovery metadata. |
| Persist text/thinking deltas as bounded structured events. | Completed | Text and thinking deltas are coalesced into bounded event previews with event counts. |
| Resume from stable event cursor. | Completed | Runtime records now compute `resumeCursor` from the latest completed tool-boundary event and include it in replay/resume context. |
| Add exactly-once event semantics. | Completed | Duplicate OpenAI-compatible tool call ids replay cached tool results and do not re-execute side effects. |

### M2: Provider Conformance

| Requirement | Status | Notes |
|---|---|---|
| Build provider capability matrix tests. | Completed | `provider-conformance.test.ts` verifies retained OpenAI-compatible presets, streaming tool support, provider quirks, token parameters, and generic custom compatibility. |
| Add mocked bad-response fixtures. | Completed | `openai-compatible-client.test.ts` covers malformed tool args, split SSE network chunks, empty final text, and unsupported API modes; malformed tool args are replayed as tool errors without executing side effects. |
| Add live provider subsets. | Completed | Xiaomi MiMo Chat and Packy Responses live subsets have passed focused smoke/tool/write/permission checks; additional domestic/international providers remain key-gated. |
| Improve provider doctor output. | Completed | Native diagnostics now classify unsupported API modes, malformed tool args, tool schema/tool_choice errors, empty responses, and network resets; Provider doctor exposes OpenAI-compatible API mode, streaming tool, tool_choice/schema, and token parameter hints. |

### M3: Tool Reliability

| Requirement | Status | Notes |
|---|---|---|
| Normalize tool outputs into structured fields. | Completed | `WorkspaceToolActionResult` preserves `summary` and now carries typed `changedFiles`, `command`, `terminal`, `browser`, and `artifacts` metadata for file writes/edits/patches, commands, terminals, and browser verification tools. |
| Make file edits patch-first. | Completed | File-write/edit/patch/rollback tool results now expose structured edit metrics: strategy, patch-first flag, preflight status, replacement/hunk counts, failure kind, and recovery hint; the deterministic benchmark includes focused tool reliability coverage. |
| Harden terminal lifecycle. | Completed | Process-group cleanup is done; terminal tool results now expose service kind, detected ports, output chunk/byte counts, and log tail metadata for dev servers and test runners. |
| Promote browser automation to validation primitive. | Completed | Electron browser smoke validates structured browser session, console, screenshot, and artifact metadata; runtime runs now aggregate browser tool results into task-level verification checks with session, console, screenshot, tool-use, and artifact metadata. |
| Add MCP timeout and schema guardrails. | Completed | MCP resource/tool calls now use a bounded host timeout, validate resource URI/tool names, cap serialized args, and emit structured MCP metadata with schema guard status, timeout, args size, and content part count. |

### M4: Work Verification UX

| Requirement | Status | Notes |
|---|---|---|
| Render event-driven progress. | Completed | Streaming chat renders typed runtime activity items as a compact event trail instead of relying on inferred process strings. |
| Show changed files and verification results at completion. | Completed | Chat tool activity renders structured changed-file, edit metric, browser verification, MCP, and artifact summaries from message parts. Project Usage settings aggregate persisted verification checks, browser checks, runtime event counts, tool failures, and retry counts. |
| Make permission requests explain impact. | Completed | Permission requests carry sanitized tool/path/command/cwd/reason/policy/checkpoint metadata, and composer/transcript cards render the impact without dumping large file contents. |
| Add resume/recover entry points. | Completed | Project Settings Usage lists resumable failed/interrupted runs and starts `resumeAgentRun` from the recovery card. |

### M5: Context And Memory

| Requirement | Status | Notes |
|---|---|---|
| Classify memory by kind. | Completed | `funplay_memory_remember` and memory search now support `user_preference`, `project_fact`, `decision`, and `task_state`; saved memories get structured `#memory/...` tags and summaries expose `memoryKinds`. |
| Make memory writes reviewable. | Completed | App Settings Memory now shows classified memory chips, category filtering, file editing, and clearing so durable memory can be inspected and corrected by users. |
| Build project context index. | Completed | `buildGenericWorkspaceContext` now includes a structured project index with package manager, manifests, scripts, validation commands, dependencies, entrypoints, config files, and git recent files; Native and Claude prompts receive the index. |
| Make context compression auditable. | Completed | Native and Claude context handoffs now store structured audit metadata for preserved decisions, constraints, and unfinished tasks, and append a deterministic audit section to compacted summaries. |

### M6: Task Planning Engine

| Requirement | Status | Notes |
|---|---|---|
| Convert complex tasks into persisted steps. | Completed | Runtime runs already persist `task_graph_json`; task nodes now carry dependencies, success criteria, timeline evidence, and checkpoint-aware rollback metadata that survives interruption/resume. |
| Add success criteria per task. | Completed | Task graph nodes now persist success criteria with `pending/passed/failed/skipped` status and evidence from timeline entries and tool results. |
| Add controlled subagent orchestration. | Completed | Subagent tool use is now recorded in the persisted task graph with read-only mode, single/parallel/background orchestration, max-step bounds, scope, expected output, status, and result preview. |
| Add rollback strategy per step. | Completed | Execute/verify/handoff nodes now carry checkpoint/manual rollback strategies and accumulate changed-file metadata from tool results. |

### M7: Benchmark Gate

| Requirement | Status | Notes |
|---|---|---|
| Create deterministic quality benchmarks. | Completed | `npm run agent:benchmark` runs stateful-core, replay artifacts, provider conformance/protocol fixtures, tool reliability, UI render, and dry E2E checks with JSON/Markdown reports. |
| Create live small-task benchmark suite. | Completed | Current MiMo smokes cover tools, web research, long tasks, and weak natural tasks; Packy Responses covers focused native Agent smoke/write/permission checks. |
| Track completion metrics. | Completed | Benchmark reports now include machine-readable completion rate, failed benchmark IDs, required duration, slowest benchmark, dry maturity tier, manual/live intervention flags, and patch-first edit metric availability. Replay logs include token and tool retry metrics derived from persisted runtime events. |
| Gate PRs by maturity tiers. | Completed | `runtime:maturity-gate` now requires the deterministic `agent:benchmark` nested report to meet the configured dry maturity tier (`dry-pass` by default), and the benchmark includes `agent:roadmap-audit` to prevent completed-route status drift; live Claude remains scheduled/manual with secrets. |

### M8: Funplay Domain Agent

| Requirement | Status | Notes |
|---|---|---|
| Recognize game project structures. | Completed | Added `inspect_game_project`, a read-only domain tool that detects Web game, Unity, asset workspace, playable entrypoints, package scripts, config files, and asset directories. |
| Validate playable browser builds. | Completed | The inspector emits the browser validation workflow (`run_command`/`terminal_start`, `browser_open`, `browser_console`, `browser_screenshot`), building on the existing structured browser verification tools and smoke tests. |
| Add asset workflow support. | Completed | The inspector summarizes resource directories and image/audio/font/misc counts so Agent can set up or audit asset workflows before editing. |
| Add Unity MCP workflow. | Completed | Unity project structure detection now points Agent toward read-only MCP resources first and guarded `call_mcp_tool` only for user-requested Unity-side actions. |

## Immediate Next Steps

1. Keep deterministic maturity gates green on every runtime change.
2. Add more live provider subsets as additional keys are supplied.
3. Use benchmark failures and replay exports to choose the next maturity backlog instead of adding parallel runtime paths.

## Completion Audit

`npm run agent:roadmap-audit` verifies this completed route stays closed:

- Every M-phase row in this roadmap must remain `Completed`.
- Every implementation row in `docs/agent-architecture-improvement-plan.md` must be `Completed`, `Superseded`, or `Deferred`.
- `npm run agent:benchmark` runs the audit as a required benchmark before reporting `dry-pass`.
