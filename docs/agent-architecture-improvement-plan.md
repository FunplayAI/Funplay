# Agent Architecture Improvement Plan

Last updated: 2026-05-15

## Goal

Turn the architecture review into an executable backlog for Funplay's local agent platform. The first implementation pass focuses on items that reduce ambiguity in runtime behavior, close an existing observability gap, and keep the architecture documentation aligned with the codebase.

## Progress Legend

- Not started
- In progress
- Completed
- Deferred
- Superseded

## Phase 1: Runtime Correctness And Observability

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P1-1 | Align architecture documentation with the current `agent-platform/` layout and remove stale `agent-core/` references. | Completed | Updated `CLAUDE.md` to reflect the current directory structure and runtime files. | `npm run build`; `npm run test:runtime` |
| P1-2 | Make explicit runtime selection fail clearly when the selected runtime is unavailable, while keeping automatic strategy fallback behavior. | Completed | `resolveGenericAgentRuntime` now treats `runtimeId` as strict while strategy/provider auto resolution may still fallback to native. | `tests/runtime/provider-runtime.test.ts` |
| P1-3 | Wire runtime usage telemetry into prompt streams. | Completed | Stream manager now records usage and dispatches `usage` stream events from runtime `onUsage`. | `tests/runtime/stream-manager-persistence.test.ts` |
| P1-4 | Persist per-run usage totals in `runtime_runs.usage_json`. | Completed | Runtime run rows, status mapping, and run-registry updates now carry accumulated usage totals. | `tests/runtime/stream-manager-persistence.test.ts` |
| P1-5 | Emit usage from Claude runtime result events and Native direct/legacy model calls where available. | Completed | Claude result events and Native direct/legacy model calls now normalize and forward usage when providers return it. | `npm run test:runtime` |
| P1-6 | Add focused runtime tests for strict runtime selection and usage persistence. | Completed | Added regression coverage for strict runtime selection, stream usage events, and persisted usage totals. | `npm run test:runtime` |
| P1-7 | Preserve usage telemetry in the OpenAI-compatible streaming tool loop. | Completed | OpenAI-compatible Native tool-loop steps now normalize and dispatch provider usage before returning the final assistant reply, so project token statistics update under streaming tool calls. | Focused `stream-manager-persistence.test.ts`; `npm run test:runtime` |

## Phase 2: Policy And Safety Hardening

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P2-1 | Replace regex-heavy write intent heuristics with a structured tool policy decision path. | Completed | Added `tool-policy.ts` typed policy decisions consumed by Native and Claude runtimes before write permission handling and high-risk tool exposure. | `tests/runtime/tool-policy.test.ts`; `npm run test:runtime` |
| P2-2 | Make Claude write modes explicit in runtime status and user-facing diagnostics. | Completed | Added `stage:claude_write_mode` with host-controlled vs external-audited mode, rollback/checkpoint capability flags, and policy evidence. | `tests/runtime/agent-runtime.test.ts`; `npm run test:runtime` |
| P2-3 | Expand checkpoint and rollback tests for interrupted write runs. | Completed | Added denied Claude write coverage and interrupted Native write rollback coverage; extended external-audited write test to assert write-mode telemetry. | `tests/runtime/agent-runtime.test.ts`; `tests/runtime/stream-manager-persistence.test.ts` |

## Phase 3: Runtime Orchestration Refactor

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P3-1 | Split `stream-manager.ts` into lifecycle, event dispatch, permission coordination, and resume modules. | Completed | Extracted stream lifecycle, event dispatch, permission/user-input coordination, and resume helpers while keeping public exports stable. | `npm run build`; `npm run test:runtime` |
| P3-2 | Introduce a reusable runtime event dispatcher abstraction. | Completed | Added `stream-event-dispatcher.ts` to centralize runtime callback conversion into `PromptStreamEvent` plus timeline/tool/usage persistence hooks. | Stream manager runtime tests |
| P3-3 | Add run replay/debug export coverage for usage, tool boundaries, and recovery metadata. | Completed | Replay logs now include usage totals, tool boundary list, and recovery metadata alongside the existing self-contained run record. | `tests/runtime/agent-run-artifacts.test.ts` |

## Phase 4: Renderer Maintainability

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P4-1 | Break large renderer surfaces into feature-owned hooks and components. | Completed | Added `useAgentRuntimeActivity` to own stream-session subscription, active stream derivation, selected session stream lookup, and runtime status polling outside `src/App.tsx`. | `npm run build`; `npm run test:runtime` |
| P4-2 | Add a compact run observability panel for timeline, tools, usage, and recovery. | Superseded | Initial side-panel UI was removed by P9-1 after the product direction changed; the stream session manager still retains usage events for renderer state. | Superseded by P9-1 and P9-2 |

## Phase 5: Provider Runtime Simplification

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P5-1 | Replace direct OpenAI SDK routing for OpenAI-compatible providers with Funplay-owned protocol adapters. | Completed | Removed the direct `@ai-sdk/openai` dependency and made OpenAI-compatible providers use `openai-compatible-client.ts` adapters instead of AI SDK language models. | `npm run build`; `npm run test:runtime` |
| P5-2 | Make OpenAI-compatible tool calls streaming-only in the native runtime. | Completed | `runOpenAiCompatibleNativeToolLoop` now always requests streamed tool steps for Chat Completions and Responses modes; the non-streaming tool-step API and runtime branch were removed. | `tests/runtime/openai-compatible-client.test.ts`; `tests/runtime/agent-runtime.test.ts`; `npm run test:runtime` |
| P5-3 | Preserve DeepSeek/OpenAI-compatible reasoning and tool-call continuity across streamed Chat Completions turns. | Completed | Chat streaming now accumulates `reasoning_content`, streamed `tool_calls`, and replays assistant reasoning plus tool call ids before tool results on the next request. | `tests/runtime/openai-compatible-client.test.ts` |
| P5-4 | Add Responses API streaming tool-call support. | Completed | Responses SSE parsing now reconstructs `response.output_item.*` and `response.function_call_arguments.*` events into raw `output` items so subsequent tool results can preserve Responses protocol history. | `tests/runtime/openai-compatible-client.test.ts`; `tests/runtime/agent-runtime.test.ts` |
| P5-5 | Remove the legacy JSON decision loop from native runtime execution. | Completed | Deleted the legacy loop/parser modules, removed all runtime fallbacks to JSON decision parsing, and set native runtime capability `legacyJsonLoop` to `false`; disabled native tool calling now falls back only to ordinary model reply. | `tests/runtime/provider-runtime.test.ts`; `tests/runtime/agent-runtime.test.ts`; `npm run test:runtime` |
| P5-6 | Prevent OpenAI-compatible history flattening from leaking internal tool protocol markers into model replies. | Completed | Historical tool-call inputs are now omitted when compatibility flattening is required; historical tool results keep only neutral task-continuation context without `[Previous tool call]` or `[Previous tool result]` markers. | Focused `agent-runtime.test.ts`; `npm run build` |
| P5-7 | Remove OpenAI-compatible non-streaming JSON completion fallback paths. | Completed | OpenAI-compatible Chat Completions and Responses text requests now always send `stream: true`; Packy-specific JSON retry and cross-protocol chat fallback chains were removed. Streaming transports still tolerate ordinary JSON response bodies when a provider ignores `stream: true`, but that no longer triggers an extra non-streaming request. | `tests/runtime/openai-compatible-client.test.ts`; `npm run build`; `npm run test:runtime` |

## Phase 6: Provider Protocol Capability Matrix

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P6-1 | Move OpenAI-compatible protocol quirks out of runtime branches and into explicit provider/preset capability metadata. | Completed | Added `openAiCompatible` preset profile metadata for Chat/Responses support, streaming tool calls, `reasoning_content`, token parameter rules, `tool_choice` modes, and native web-search availability. | `npm run build`; `npm run test:runtime` |
| P6-2 | Make Chat Completions token-limit parameter selection provider-aware instead of relying only on model-name heuristics. | Completed | `ChatCompletionsAdapter` now resolves `max_tokens` vs `max_completion_tokens` from the provider profile, with `auto` retained only for mixed OpenAI-family compatibility. | `tests/runtime/openai-compatible-client.test.ts`; `npm run test:runtime` |
| P6-3 | Fail unsupported Chat/Responses mode combinations clearly before making provider requests. | Completed | OpenAI-compatible client now rejects provider/profile combinations such as Xiaomi MiMo + Responses API with a direct configuration error. | `tests/runtime/openai-compatible-client.test.ts`; `npm run test:runtime` |
| P6-4 | Normalize OpenAI-compatible tool schemas for stricter Chat Completions providers. | Completed | Tool parameter schemas now preserve valid object schemas while filling missing `properties` and `required: []`, keep empty parameter objects for MiMo, skip MiMo's optional `tool_choice`, and keep OpenAI-compatible direct replies on the streaming Chat Completions path instead of silently falling back to non-streaming JSON. | Focused `openai-compatible-client.test.ts`; focused `agent-runtime.test.ts`; `npm run build` |
| P6-5 | Centralize OpenAI-compatible provider request transforms. | Completed | Added `openai-compatible-profile-transforms.ts` so schema normalization, Moonshot/Kimi `$ref` and tuple-item cleanup, Gemini-style schema cleanup, DashScope `enable_thinking`, Zhipu `thinking`, assistant reasoning field replay, and case-insensitive tool-name repair are handled outside the runtime loop. | `tests/runtime/openai-compatible-client.test.ts`; `tests/runtime/provider-catalog.test.ts`; `npm run build`; `npm run test:runtime` |
| P6-6 | Infer safe upstream model transforms for OpenAI-compatible aggregators. | Completed | OpenRouter, SiliconFlow, and custom compatible endpoints now infer non-destructive Kimi/Moonshot schema cleanup, Gemini schema cleanup, and `reasoning_content` replay from upstream model ids such as `deepseek/*`, `moonshotai/*`, `qwen/*`, `z-ai/glm-*`, and `google/gemini-*`; vendor-only request switches like DashScope `enable_thinking` and Zhipu `thinking` remain scoped to their direct provider profiles. | `tests/runtime/openai-compatible-client.test.ts`; `npm run build`; `npm run test:runtime` |
| P6-7 | Retry transient OpenAI-compatible network resets before local fallback. | Completed | Streaming Chat Completions and Responses requests now retry pre-response fetch failures such as `ECONNRESET` and TLS socket resets before surfacing an error; exhausted transient resets are classified as temporary provider network interruptions instead of base URL misconfiguration. | Focused `openai-compatible-client.test.ts`; focused `claude-cli-config.test.ts`; `npm run build`; `npm run test:runtime` |
| P6-8 | Execute textual tool markers from weak OpenAI-compatible tool-call responses as guarded tools. | Completed | Following opencode's structured-part separation, the OpenAI-compatible adapter layer now treats line-start `[Tool] registered_tool_name { ... }` markers as a compatibility repair only when the tool is registered, parses the JSON input, strips the marker from assistant text, and returns structured tool calls for the native loop to execute through the same permission/path-guarded tool adapter. | Focused `openai-compatible-client.test.ts`; focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |

## Phase 7: Provider Preset Curation

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P7-1 | Reduce optional provider presets to common domestic/overseas channels plus one generic OpenAI-compatible preset. | Completed | Removed niche/advanced presets from the selectable catalog and retained OpenAI, OpenRouter, Anthropic, Gemini, DeepSeek, Alibaba Qwen, Kimi, Zhipu GLM, SiliconFlow, Xiaomi MiMo, and Custom OpenAI-Compatible. | `tests/runtime/provider-catalog.test.ts`; `npm run build`; `npm run test:runtime` |
| P7-2 | Add provider profile metadata for newly retained domestic OpenAI-compatible channels. | Completed | Added Qwen DashScope, Kimi, Zhipu GLM, and SiliconFlow base URLs, defaults, token parameter rules, and capability profile metadata. | `tests/runtime/provider-catalog.test.ts`; `npm run test:runtime` |
| P7-3 | Keep settings UI preset descriptions aligned with the curated catalog. | Completed | Updated localized provider preset descriptions and API key hints for the retained preset list. | `npm run build` |

## Phase 8: Safe Default Runtime Policy

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P8-1 | Make Native the default agent runtime strategy. | Completed | Changed `DEFAULT_AGENT_SETTINGS.runtimeStrategy` from `auto` to `native` so fresh installs and missing persisted settings start on the Funplay-owned native tool loop; legacy persisted `auto/full-access` defaults migrate to the new safe default. | `tests/runtime/provider-runtime.test.ts`; `tests/runtime/store-migrations.test.ts`; `npm run build`; `npm run test:runtime` |
| P8-2 | Make ask-first the default agent permission mode. | Superseded | This intermediate default was replaced by P8-8 after the product direction moved to opencode-style Build/Plan modes. | Superseded by P8-8 |
| P8-3 | Align settings UI ordering and copy with the new safe defaults. | Superseded | The previous three-option permission UI was replaced by the Build/Plan selector. | Superseded by P8-8 and P9-5 |
| P8-4 | Prevent ask-first mode from being described as read-only inside Native tool-loop prompts. | Superseded | The visible Ask First mode was removed; legacy persisted `ask` values are normalized to Build. | Superseded by P8-8 |
| P8-5 | Expose Native side-effect tools in ask-first mode while keeping execution permission-gated. | Superseded | The ask-first exposure policy was replaced by Build full-access plus Plan read-only writes with command confirmation. | Superseded by P8-8 |
| P8-6 | Collapse legacy session modes into a single Agent mode with permission-based limits. | Completed | Removed the Project Settings session-mode switch, stopped accepting session `mode` overrides over IPC, stripped legacy session mode values from normalized session records, and made Native/Claude paths treat all conversations as Agent mode while permission modes control tool access. | Focused `agent-runtime.test.ts`; `tests/runtime/claude-sdk-options.test.ts`; `npm run build` |
| P8-7 | Make built-in workspace tool registration deterministic. | Completed | Split the tool registry storage into `tool-registry-core.ts` and changed built-in tool modules to statically register through the core, removing the previous async `void import()` race and adding `create_directory` to registry metadata coverage. | Focused `agent-runtime.test.ts`; `npm run test:runtime` |
| P8-8 | Replace the three-level permission selector with an opencode-style Build/Plan model. | Completed | Build is now the default and maps to full development access. Plan maps to read-only project writes: write tools are not exposed, stale Ask First settings are normalized to Build, and command/browser tools remain visible but require permission broker approval before execution. | `tests/runtime/provider-runtime.test.ts`; `tests/runtime/store-migrations.test.ts`; focused `agent-runtime.test.ts`; focused `workspace-tools.test.ts`; `npm run build`; `npm run test:runtime` |
| P8-9 | Stop retrying OpenAI-compatible tool-loop failures as no-tool chat replies. | Completed | Removed the automatic direct-reply retry for provider tool-schema errors so a failed tool loop surfaces as a provider/runtime failure instead of prompting the model to say it cannot write. | Focused `agent-runtime.test.ts`; `npm run test:runtime` |
| P8-10 | Tighten Xiaomi MiMo tool schema compatibility. | Completed | MiMo now keeps empty function `parameters` objects with `required: []` instead of omitting them, and chat tool result messages include the tool name when available for stricter OpenAI-compatible providers. | `tests/runtime/openai-compatible-client.test.ts`; `npm run test:runtime` |
| P8-11 | Continue unfinished multi-file write turns instead of accepting progress text as final. | Completed | OpenAI-compatible Native tool loop now detects final-looking text such as “现在写 game.js” after file write tools completed, suppresses that partial progress reply, and asks the model to continue with protocol-level write tools before it can give the final answer. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |
| P8-12 | Move the Native OpenAI-compatible main path toward an opencode-style state machine. | Completed | The OpenAI-compatible Native loop now keeps explicit step parts for assistant text, tool use, tool result, and guarded continuation; only a no-tool final step can become the user-visible final reply, while tool-step text is preserved for protocol history but not streamed as final content. Historical completed tool-use/tool-result pairs are replayed as protocol tool messages for both Chat Completions and Responses, while dangling tool-use blocks are skipped. Native Plan mode no longer locally falls back on write-intent preflight; write tools are withheld and permission remains enforced at tool execution. Completed tool-use blocks now preserve original tool input for renderer/history replay. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |
| P8-13 | Remove the fixed Native main-loop tool step cap. | Completed | Removed the old 50-step cap from the OpenAI-compatible and AI SDK Native main tool loops. The loop now ends on provider stop/final answer, user cancellation, abort, or provider/runtime error instead of an arbitrary tool-call count. Subagent helper loops keep their explicit bounded max-step policy. | Focused `agent-runtime.test.ts`; live Xiaomi MiMo backend task; `npm run build` |
| P8-14 | Preserve unfinished todo state across continuation turns and avoid reasoning-token truncation before tool calls. | Completed | Native tool loops now restore the latest structured `update_todo_list` snapshot from session history, continuation requests inherit unfinished write intent from recent tool state, incomplete todo continuation no longer has a low fixed retry cap, and main tool-loop output budget follows the opencode-style 32k default with context-window capping for smaller models. | Focused `tool-policy.test.ts`; focused `agent-runtime.test.ts`; `npm run build` |

## Phase 9: Renderer UX Simplification

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P9-1 | Remove the run observability side-panel UI from the chat workspace. | Completed | Deleted `RunObservabilityPanel`, removed the chat workspace action/side-stack wiring, and kept only the session changes side panel. | `npm run build` |
| P9-2 | Consolidate project token statistics into Project Settings. | Completed | Added a Project Settings Usage tab that aggregates persisted per-run usage totals by project, token direction, run status, and provider/model. | `npm run build` |
| P9-3 | Make the chat permission selector warning affordance match actual risk. | Completed | The composer permission selector now renders the exclamation warning icon only for Build; Plan uses non-warning presentation. | `npm run build` |
| P9-4 | Show empty directories in the project file tree. | Completed | Project file listing now emits typed directory entries, the renderer tree treats directory entries as folders even without child files, and file/search/asset consumers skip directories where file content is required. | Focused `project-file-preview.test.ts`; `npm run build` |
| P9-5 | Remove Ask First from visible settings and chat controls. | Completed | Global settings, project settings, and the chat composer now expose only Build and Plan. Legacy Ask First values are accepted only as migration input and normalized to Build. | `npm run build`; `npm run test:runtime` |

## Phase 10: Agent Live Quality Gates

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P10-1 | Add a live development-loop smoke that validates command execution, failure handling, code writing, and retesting in one run. | Completed | Added a Xiaomi MiMo live test that starts with an intentionally failing Node ESM backend test suite. The Agent must run `npm test`, implement the missing backend through workspace write tools, rerun `npm test`, and continue until the generated project passes. | Live `agent-runtime.test.ts` dev-loop smoke; external `npm test` assertion |
| P10-2 | Add live permission and filesystem boundary smoke coverage. | Completed | Added Xiaomi MiMo live tests for Plan-mode write withholding and Build-mode path traversal recovery. Plan mode must not create requested files, while Build mode must surface a blocked `../` write as a tool error and continue with a safe in-project write. | Live `agent-runtime.test.ts` plan-boundary and path-guard smokes |
| P10-3 | Add live tool-error recovery coverage for failed edits. | Completed | Added a Xiaomi MiMo live test where the Agent must call `edit_file` with a known-bad `oldText`, receive the tool error, read the file, then perform a corrected edit before returning a final answer. | Live `agent-runtime.test.ts` edit-recovery smoke |
| P10-4 | Add live persistent terminal lifecycle coverage. | Completed | Added a Xiaomi MiMo live test where the Agent must start a long-running terminal command, read a marker from terminal output, and stop the terminal. The test exposed that terminal stop/dispose killed only the shell; persistent terminals now run in their own process group and stop/dispose signals the whole group. | Live `agent-runtime.test.ts` terminal smoke; focused `workspace-tools.test.ts` terminal test |
| P10-5 | Add live Plan-mode command permission coverage. | Completed | Added a Xiaomi MiMo live test where Plan mode exposes `run_command`, routes it through the high-risk permission broker, executes only after approval, and still leaves write tools unavailable and the project directory unchanged. | Live `agent-runtime.test.ts` Plan command smoke |
| P10-6 | Expand live Native tool-surface coverage beyond file and command basics. | Completed | Added Xiaomi MiMo live tests for `ask_user`/todo updates, read/search/summary/diff-preview tools, `multi_edit` + `patch_file` + checkpoint rollback, project memory tools, read-only subagent delegation, local `web_fetch`, media attach/save, browser session listing, and notification task scheduling/cancellation. | Full live `agent-runtime.test.ts` suite: 18 passed, 0 failed |
| P10-7 | Add live web research and plan-writing coverage. | Completed | Added a Xiaomi MiMo live test where the Agent must use `web_search` against public official docs, fetch two MDN source pages, synthesize a cited implementation plan, write it to `docs/research-plan.md`, and read the file back. | Focused live `agent-runtime.test.ts` research-plan smoke |
| P10-8 | Re-run full UI smoke for the simplified Agent surface. | Completed | Revalidated the renderer path where chat exposes provider plus Build/Plan controls, hides inline model/runtime selectors, renders structured tool parts, and uses the unified thinking copy. | `agent-ui-render.test.ts`; prior `npm run dev` launch smoke |
| P10-9 | Add multi-provider live subsets as keys become available. | Completed | Xiaomi MiMo Chat and Packy Responses focused subsets now pass. Remaining domestic/international provider subsets are treated as key-gated expansion, not open roadmap debt. Packy bare base URLs are normalized to `/v1`, and `gpt-5.2` is the verified Packy Responses model for the supplied key. | Focused live `agent-runtime.test.ts` Packy subset; focused live Xiaomi MiMo suite |
| P10-10 | Add browser automation coverage in an Electron runtime. | Completed | Added `scripts/agent-browser-smoke.mjs` and `npm run agent:browser-smoke`. The smoke opens a local page, snapshots DOM, types, clicks, reads console output, captures a screenshot, navigates, closes, and verifies Plan-mode permission requests for command-like browser tools. | `npm run agent:browser-smoke` |
| P10-11 | Add long-task abort/resume coverage at a completed tool boundary. | Completed | Added a deterministic Native regression where the run aborts after a completed `write_file`, verifies the file was written, then resumes with `resume_after_last_completed_tool` context replayed into the provider messages. | Focused `agent-runtime.test.ts` abort/resume regression |
| P10-12 | Add weakly constrained natural-language Agent coverage. | Completed | Added Xiaomi MiMo live tests that avoid step-by-step tool scripts: one natural resource setup request creates asset folders and `memory.md`; one "tests are broken" repair request chooses tools, writes implementation, runs commands, and passes external `npm test`. | Focused live `agent-runtime.test.ts` weak natural smokes |

## Phase 11: Product-Grade Agent Maturity

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P11-1 | Create a product-grade Agent maturity roadmap. | Completed | Added `docs/agent-maturity-roadmap.md`, splitting the next evolution into stateful core, provider conformance, tool reliability, work verification UX, context/memory, task planning, benchmark gates, and Funplay-specific domain workflows. | Document review |
| P11-2 | Persist a structured runtime event log for every Agent run. | Completed | Added `runtime_runs.events_json`, `AgentRuntimeEvent`, run-registry event recording, tool use/result persistence, usage/timeline/tool-boundary events, final outcome events, and replay-log export of the event stream. | Focused `stream-manager-persistence.test.ts`; focused `store-migrations.test.ts`; focused `agent-run-artifacts.test.ts` |
| P11-3 | Capture bounded text and thinking deltas in the runtime event log. | Completed | Text and thinking stream deltas now persist as coalesced bounded `text_delta` and `thinking_delta` events, preserving accumulated previews and event counts without letting token-level deltas flood the event log. | Focused `stream-manager-persistence.test.ts`; `npm run agent:benchmark` |
| P11-4 | Resume from a stable event cursor. | Completed | Runtime records now compute a `resumeCursor` from the latest completed tool-boundary event, export it in replay logs, and include it in Native/Claude resume context. | Focused `stream-manager-persistence.test.ts`; focused `agent-run-artifacts.test.ts`; `npm run agent:benchmark` |
| P11-5 | Add a deterministic Agent benchmark harness. | Completed | Added `scripts/agent-benchmark.mjs` and `npm run agent:benchmark`; the harness prepares Node native ABI, runs stateful-core, replay, UI render, and dry E2E checks, writes JSON/Markdown reports, and restores Electron ABI. | `npm run agent:benchmark` |
| P11-6 | Add exactly-once event semantics and duplicate tool-result protection. | Completed | The Native OpenAI-compatible main loop now caches completed tool results by `toolUseId`; if a provider repeats the same tool call id, the loop replays the cached result, emits a duplicate-tool stage, and does not execute the side-effecting tool again. | Focused `agent-runtime.test.ts` duplicate tool-call regression |

## Phase 12: Provider Conformance Hardening

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P12-1 | Add offline provider capability conformance tests and include them in the Agent benchmark gate. | Completed | Added `tests/runtime/provider-conformance.test.ts` for retained OpenAI-compatible presets, streaming tool-call support, domestic provider quirks, token parameter selection, and custom generic compatibility; `npm run agent:benchmark` now runs provider conformance plus protocol fixtures. | Focused `provider-conformance.test.ts`; `npm run agent:benchmark` |
| P12-2 | Add mocked bad-response fixtures for OpenAI-compatible streaming providers. | Completed | Added SSE network-chunk split parsing coverage, malformed tool-argument preservation, unsupported mode checks, and empty-response diagnostics. Malformed tool arguments now become structured recoverable tool errors and Native does not execute the side-effecting tool. | Focused `openai-compatible-client.test.ts`; focused `agent-runtime.test.ts` |
| P12-3 | Improve provider doctor diagnostics for known configuration and protocol failures. | Completed | Native diagnostics now classify unsupported OpenAI-compatible API modes, malformed tool arguments, tool schema/tool_choice failures, empty responses, and transient network errors. Runtime doctor now includes a Native OpenAI-compatible protocol probe with API mode, streaming tool-call, tool_choice/schema transform, reasoning, and token-parameter hints. | Focused `provider-conformance.test.ts`; `npm run agent:benchmark` |

## Phase 13: Tool Reliability Hardening

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P13-1 | Normalize core workspace tool outputs into structured fields while preserving text summaries. | Completed | Extended `WorkspaceToolActionResult` with typed `changedFiles`, `command`, `terminal`, `browser`, and `artifacts` fields. File write/edit/multi-edit/patch/rollback tools now emit changed-file metadata; `run_command` emits exit/stdout/stderr/timeout metadata; persistent terminal tools emit session/status/cursor metadata; browser tools emit session/title/viewport/screenshot/console/artifact metadata. | Focused `workspace-tools.test.ts`; `npm run agent:browser-smoke`; `npm run build`; `npm run agent:benchmark` |

## Phase 14: Benchmark Metrics

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P14-1 | Add machine-readable maturity metrics to deterministic Agent benchmark reports. | Completed | `npm run agent:benchmark` now writes `metrics` with benchmark count, passed/failed count, completion rate, failed benchmark IDs, required duration, slowest benchmark, dry maturity tier, and manual/live intervention flags; Markdown reports surface the key metrics. | `npm run agent:benchmark` |

## Phase 15: Packy Responses Compatibility

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P15-1 | Make Packy Responses work when users enter the bare Packy hostname. | Completed | OpenAI-compatible client now normalizes `https://www.packyapi.com` to `https://www.packyapi.com/v1` before constructing `/responses`, matching Packy Codex/Responses configuration. | Focused `openai-compatible-client.test.ts` |
| P15-2 | Validate Packy Responses as a live native Agent provider. | Completed | Packy Responses with `gpt-5.2` passed focused live checks for streamed final reply, `read_file`, guarded writes, Plan-mode write withholding, and Plan-mode approved command execution. The supplied key rejected `gpt-5.1-codex` with `model_not_found`, so docs record `gpt-5.2` as the verified model. | Focused live `agent-runtime.test.ts` Packy subset |

## Phase 16: Browser Verification Reports

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P16-1 | Promote browser tool output into task-level verification reports. | Completed | Shared tool-result metadata now flows through Native tool results, stream events, runtime event logs, content blocks, and persisted run records. Browser tool results are aggregated into `AgentVerificationReport` checks keyed by browser session, including session/title/viewport, console count, screenshot path, tool-use IDs, and browser screenshot artifacts. | Focused `agent-run-artifacts.test.ts`; `npm run build` |

## Phase 17: Edit Recovery Metrics

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P17-1 | Add structured patch-first edit metrics to workspace tool results. | Completed | `WorkspaceToolActionResult` now carries `edit` metrics for `write_file`, `edit_file`, `multi_edit`, `preview_patch`, `patch_file`, and `checkpoint_rollback`: strategy, patch-first flag, preflight status, changed-file/replacement/hunk counts, failure kind, and recovery hint. The Native adapter, stream events, content blocks, and runtime event logs preserve the field. | Focused `workspace-tools.test.ts`; `npm run build` |
| P17-2 | Include edit reliability in deterministic Agent benchmarks. | Completed | `npm run agent:benchmark` now includes a focused `tool-reliability` benchmark and reports whether patch-first edit metrics are available in machine-readable and Markdown output. | Focused `workspace-tools.test.ts`; `npm run build` |

## Phase 18: Replay Metrics

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P18-1 | Add token and tool retry metrics derived from persisted runtime events. | Completed | Replay exports now include `metrics` with event count, usage event count, token totals, average tokens per turn, tool call/result counts, failed tool results, repeated tool-result retry count, and API/context recovery counts. | Focused `agent-run-artifacts.test.ts`; `npm run build` |

## Phase 19: Completion UX

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P19-1 | Render structured tool result metadata in chat completion UI. | Completed | Chat tool activity now surfaces changed files, edit metrics, browser verification details, and artifacts from structured message parts instead of requiring users to inspect raw tool output text. | Focused `agent-ui-render.test.ts`; `npm run build` |
| P19-2 | Surface run-level verification and tool quality metrics in project settings. | Completed | Project Usage settings now aggregate persisted verification checks, browser verification checks, runtime event count, failed tool results, and repeated tool-result retry count alongside token usage. | Focused `agent-ui-render.test.ts`; `npm run build` |

## Phase 20: Terminal Lifecycle Metadata

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P20-1 | Add terminal lifecycle metadata for long-running dev and test commands. | Completed | Persistent terminal results now include session name, PID, service kind, detected ports, output chunk/byte counts, and a bounded log tail. `terminal_start`, `terminal_read`, `terminal_write`, and `terminal_stop` preserve the metadata in structured tool results. | Focused `workspace-tools.test.ts`; `npm run build` |

## Phase 21: MCP Guardrails

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P21-1 | Add MCP timeout and schema guardrails to workspace tools. | Completed | MCP resource/tool calls now run under a host timeout, validate resource URIs and tool names, cap serialized args, block oversized payloads before network execution, and emit structured MCP metadata including schema guard status, timeout, args size, and content part count. | Focused `agent-runtime.test.ts`; `npm run build` |

## Phase 22: Context And Memory Classification

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P22-1 | Classify durable project memory by semantic kind. | Completed | Added `ProjectMemoryEntryKind` with `user_preference`, `project_fact`, `decision`, and `task_state`; Native and Claude/MCP memory tools accept memory-kind filters and write classified `#memory/...` tags while memory summaries expose `memoryKinds`. | Focused `agent-runtime.test.ts`; `npm run build` |
| P22-2 | Make classified memory writes reviewable in settings. | Completed | App Settings Memory now displays memory-kind chips, category filters, and classified summary counts alongside the existing edit/clear workflow. | `npm run build` |
| P22-3 | Build a structured project context index for Agent prompts. | Completed | `buildGenericWorkspaceContext` now derives package manager, manifests, scripts, validation commands, dependencies, entrypoints, config files, and recent git files. Native and Claude prompts include the index, and Native workspace observation emits a concise index summary. | Focused `agent-runtime.test.ts`; `npm run build` |
| P22-4 | Make context compression auditable. | Completed | Native and Claude context summaries now include structured audit metadata for decisions, constraints, and unfinished tasks, and append a deterministic audit section to compacted summaries so preserved continuity can be inspected. | Focused `agent-runtime.test.ts`; `npm run build` |

## Phase 23: Task Planning Engine

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P23-1 | Add success criteria and rollback strategy metadata to persisted task graphs. | Completed | `AgentTaskGraphNode` now persists success criteria and rollback strategy fields. Timeline entries update criterion status/evidence, and tool results propagate changed-file metadata into execute/verify rollback strategies. | `tests/runtime/agent-run-artifacts.test.ts`; `npm run build` |
| P23-2 | Record controlled subagent orchestration in task graphs. | Completed | Subagent tool use now persists read-only task records on the plan node, including single/parallel/background mode, scope, expected output, max-step bounds, status, and result preview. | `tests/runtime/agent-run-artifacts.test.ts`; `npm run build` |

## Phase 24: Benchmark Gate

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P24-1 | Gate CI by deterministic Agent maturity tier. | Completed | `runtime-maturity-gate.mjs` now runs `npm run agent:benchmark` as a required dry gate and fails if the nested benchmark report does not meet the configured required tier (`dry-pass` by default, overrideable with `--required-tier=` or `FUNPLAY_MATURITY_REQUIRED_TIER`). | `node --check scripts/runtime-maturity-gate.mjs`; `npm run agent:benchmark` |

## Phase 25: Work Verification UX And Domain Agent Completion

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P25-1 | Render typed runtime activity instead of inferred process strings. | Completed | Streaming chat now renders `activityItems` as a compact runtime event trail sourced from structured stream events, while tool details remain driven by typed tool-use/tool-result parts. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P25-2 | Show permission request impact from structured metadata. | Completed | Permission requests now carry sanitized impact metadata for tool, path, command, cwd, reason, permission policy, and checkpoint policy; composer and transcript permission cards render this without exposing large file contents. | `tests/runtime/stream-session-manager.test.ts`; `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P25-3 | Add a user-visible resume/recovery entry point. | Completed | Project Settings Usage now lists resumable interrupted/failed Agent runs with session, prompt/error preview, resume strategy, and a Resume action wired to `resumeAgentRun`. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P25-4 | Add Funplay game-project domain inspection. | Completed | Added `inspect_game_project`, a read-only domain tool that detects Web game, Unity, asset workspace, playable entrypoints, package scripts, config files, asset directories, browser validation workflow, and Unity MCP workflow hints. | Focused `workspace-tools.test.ts`; focused `agent-runtime.test.ts`; `npm run build` |

## Phase 26: Roadmap Completion Audit

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P26-1 | Add a deterministic audit for roadmap completion state. | Completed | Added `npm run agent:roadmap-audit`, which verifies every M-phase in the maturity roadmap is `Completed`, every P-phase implementation row is `Completed`, `Superseded`, or `Deferred`, and every completed specialty roadmap row for Agent Core v2, Skills v2, Agent Platform v3, and Desktop UI remains closed. `npm run agent:benchmark` includes this audit as a required benchmark. | `npm run agent:roadmap-audit`; `npm run agent:benchmark` |

## Phase 27: Desktop UI Information Architecture

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P27-1 | Create the next desktop UI improvement route. | Completed | Added `docs/desktop-ui-improvement-plan.md` covering settings hierarchy, Agent Runs, provider setup productization, workspace status, visual density, and screenshot walkthroughs. | Document review |
| P27-2 | Split Agent run history out of token Usage. | Completed | Project Settings now has a dedicated `Agent Runs` tab for run overview, recovery, verification, tool quality, and recent run history. The Usage tab now focuses on token and provider/model statistics. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P27-3 | Clarify Global, Project, and Session settings precedence. | Completed | Project Agent settings now render a compact scope hierarchy for Global Default -> Project Default -> Current Session, including effective provider/model/runtime/mode values. App Agent settings labels its controls as global defaults. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P27-4 | Make Provider setup preset-first and operationally scannable. | Completed | Provider cards now expose channel, API mode, base URL, model, key state, auth style, and default/enabled status. Provider editing starts with preset cards, keeps common fields in Core Configuration, and moves protocol/API/auth/header/env controls into Advanced Protocol Configuration. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P27-5 | Render provider diagnostics as direct repair guidance. | Completed | Runtime Doctor now shows a suggested repair order before raw probe details, mapping common auth, API mode, model, base URL/network, tool-calling, quota, and default-provider findings to plain next actions. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P27-6 | Add a concise Agent workspace project status header. | Completed | The Agent workspace now shows provider, model, Build/Plan mode, run status, file-change count, and next action in a compact status bar above the chat surface. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P27-7 | Normalize settings and runtime surface visual density. | Completed | Added shared density/radius tokens and applied them to provider cards, provider preset cards, app/project settings controls, Agent Runs metrics, Runtime Doctor guidance, and Agent workspace status/change surfaces. | `tests/runtime/agent-ui-render.test.ts`; `npm run build` |
| P27-8 | Run a desktop UI walkthrough on the Electron app. | Completed | Launched the dev Electron app and used Computer Use state capture to verify the Agent workspace status bar, Project Settings navigation, Assets page state, and App Settings modal state. | `npm run dev`; Computer Use app-state walkthrough |

## Phase 28: Desktop UI Visual QA Hardening

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P28-1 | Complete the navigation and modal visual QA batch. | Completed | Added and completed U4 in the desktop UI plan. Workspace routes now expose explicit section state, active sidebar/settings navigation uses `aria-current`, App Settings is a semantic dialog, compact settings layouts degrade cleanly, and static renderer tests cover the key route/modal semantics. | `tests/runtime/agent-ui-render.test.ts`; `npm run dev`; Computer Use app-state walkthrough |

## Phase 29: Desktop UI Daily Workflow Ergonomics

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P29-1 | Complete the daily workflow UI ergonomics batch. | Completed | Added and completed U5 in the desktop UI plan. The batch added `npm run ui:smoke`, actionable empty chat task starters, Assets empty-state discovery hints, and renderer tests for the new daily workflow surfaces. | `npm run ui:smoke`; `tests/runtime/agent-ui-render.test.ts` |

## Phase 30: Desktop UI Real Window Regression Loop

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P30-1 | Complete the real-window UI regression route. | Completed | Completed U6 in the desktop UI plan: app-scoped Electron smoke with controlled preload and `BrowserWindow.capturePage()` artifacts, long-task chat fixtures, Provider setup coverage, file/Assets/inspector handoff, and compact-window assertions for App Settings, Project Settings, and Agent composer accessibility. | `npm run ui:electron-smoke`; `tests/runtime/agent-ui-render.test.ts` |

## Phase 31: Inline Agent Work Transcript

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P31-1 | Render Agent work process inline in the chat transcript. | Completed | The chat transcript now follows the opencode-style parts model: assistant text is split by stream activity offsets, tool cards render at the exact text boundary where the tool ran, multiple tools at the same boundary merge into one compact summary row, and completed messages can replay persisted process text plus tool boundaries instead of hiding work in a separate observability panel. | Focused `stream-session-manager.test.ts`; focused `agent-ui-render.test.ts`; focused `agent-runtime.test.ts`; `npm run build` |
| P31-2 | Preserve per-tool activity boundaries through streaming and completion. | Completed | Stream sessions now update activity items by stable per-tool ids instead of replacing every tool event at the same offset, and the conversation process transcript persists ordered tool/stage activity metadata for final message replay. OpenAI-compatible Native tool steps expose visible assistant step text to the process stream while keeping pseudo tool markers out of the assistant body. | Focused `stream-session-manager.test.ts`; focused `agent-runtime.test.ts`; `npm run build` |
| P31-3 | Keep inline tool activity compact by removing nested detail expanders. | Completed | Tool activity rows no longer render the secondary `查看细节` / `View details` expander with raw JSON input or duplicated full output. The visible surface keeps the compact summary, result preview, changed-file/edit/browser/artifact metadata, and merged same-boundary tool groups. | Focused `agent-ui-render.test.ts`; `npm run build` |

## Phase 32: Provider Settings Feedback

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P32-1 | Clear stale Provider test messages before a new test starts. | Completed | The Provider manager now removes the selected provider's previous test result immediately when Test is clicked, then writes back only the latest matching request result. Per-provider request ids prevent a slower previous test response from overwriting a newer test. | `npm run build` |

## Phase 33: Agent Completion Guardrails

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P33-1 | Continue Native tool loops when the model stops with an incomplete todo list. | Completed | Native tool loops now parse `update_todo_list` results and treat remaining `in_progress` / `pending` items as unfinished work instead of a valid final stop. Both AI SDK-backed Native providers and OpenAI-compatible Native providers replay the tool history with a continuation prompt, bounded by a guardrail limit, so provider `finishReason=other` cannot silently complete a half-done implementation. | Focused `agent-runtime.test.ts`; `npm run build` |

## Phase 34: Provider Transient Failure Recovery

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P34-1 | Retry retryable OpenAI-compatible HTTP gateway failures. | Completed | OpenAI-compatible Chat Completions and Responses streaming transports now retry retryable HTTP failures such as Cloudflare 502/503/504 responses, `retryable: true`, and `cloudflare_error: true` before surfacing the provider error. Cloudflare gateway errors are classified as temporary provider overload/unavailability instead of base URL misconfiguration, and Cloudflare `error_name` is preserved as the diagnostic code when available. | Focused `openai-compatible-client.test.ts`; focused `provider-conformance.test.ts`; `npm run build` |
| P34-2 | Align Packy Responses request shape with Codex Desktop. | Completed | Packy live probes showed the previous Funplay minimal Responses body and Codex-style structured body both return `200 text/event-stream`, so the Cloudflare 502 is not a deterministic URL/body-shape failure. To reduce proxy compatibility variance, Responses text messages now use typed `message` items with `input_text` / `output_text` parts, set `store:false`, and disable parallel tool calls in OpenAI-compatible Responses tool loops, matching the Codex Desktop wire shape more closely. | Live Packy probes with redacted bearer token; focused `openai-compatible-client.test.ts` |

## Phase 35: OpenAI-Compatible Completion Repairs

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P35-1 | Tolerate weak provider todo arguments and keep incomplete todo state authoritative. | Completed | `update_todo_list` now accepts provider alias input such as `todos` JSON strings or arrays while still advertising the canonical `items` schema. The OpenAI-compatible tool-loop snapshot parser handles the same alias, so malformed MiMo todo calls no longer collapse into an empty todo list and lose continuation state. | Focused `agent-runtime.test.ts`; `npm run test:runtime`; `npm run build` |
| P35-2 | Continue after empty OpenAI-compatible final steps when unfinished work is known. | Completed | The OpenAI-compatible Native loop now checks unfinished todo snapshots before throwing on an empty no-tool final step. If todo items remain pending or in progress, it replays history with a continuation prompt; if tools completed but the model still returns empty final text, it completes with a bounded host fallback instead of interrupting the conversation. | Focused `agent-runtime.test.ts`; `npm run test:runtime`; `npm run build` |
| P35-3 | Treat inspection-only write promises as unfinished work. | Completed | The partial-write continuation guard no longer requires a prior file-write tool. If the model says it is about to write referenced files after only read/inspection tools, the loop suppresses that false final reply and asks for protocol-level write tools before allowing a final answer. Known Xiaomi MiMo tool-schema `map` errors are also excluded from transient HTTP retries to avoid repeated identical failing requests. | Focused `agent-runtime.test.ts`; `npm run test:runtime`; `npm run build` |
| P35-4 | Do not surface empty no-tool final steps as Provider failures. | Completed | OpenAI-compatible Native tool loops now follow opencode's stop semantics: an empty no-tool final step is a completed assistant stop with no visible text, not a Provider/runtime failure. Tool calls still keep the loop alive; only a real no-tool stop ends the turn. | Focused `agent-runtime.test.ts`; `npm run test:runtime`; `npm run build` |

## Phase 36: Opencode-Style Task List Compatibility

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P36-1 | Make the visible task-list tool behave like opencode `todowrite` without breaking persisted Funplay history. | Completed | Kept `update_todo_list` as the canonical persisted tool name, but made it product-facing as `任务清单`, accepted opencode-style `todos` input with optional priority and `cancelled` status, preserved old `items` calls, made Native incomplete-todo continuation treat only `pending` / `in_progress` as unfinished, rendered task-list activity as its own inline transcript category instead of exposing raw tool names, and now replays interrupted pending/running historical tool parts as protocol-level error outputs instead of dropping them. | Focused `agent-ui-render.test.ts`; focused `agent-runtime.test.ts`; `npm run test:runtime`; `npm run build` |

## Phase 37: Edit Tool Failure Recovery

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P37-1 | Recover from stale `oldText` and empty `multi_edit` calls in the Native OpenAI-compatible loop. | Completed | The Native loop now rejects empty `multi_edit` input before any workspace write, records the failure as a structured tool result, and injects a bounded edit-recovery continuation when `edit_file`, `multi_edit`, or `patch_file` preflight fails. The recovery prompt requires the model to re-read the latest file snippet, avoid reusing stale `oldText`, and prefer `preview_patch` plus `patch_file` when context is uncertain. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |

## Phase 38: Claude-Style MCP Tool Materialization

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P38-1 | Materialize enabled MCP server tools as protocol-level Agent tools. | Completed | Native runtime now discovers enabled MCP servers with `tools/list` and turns each MCP tool into a direct `mcp__server__tool` tool definition with sanitized stable naming, original JSON schema exposure, MCP metadata preservation, and execution through the existing guarded `call_mcp_tool` path. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |
| P38-2 | Handle MCP permissions at the exact tool execution point. | Completed | Materialized MCP tools infer read-only vs high-risk write-like behavior from tool names; read-only tools run without prompts, while write-like or unknown MCP tools use the same ask/full-access/read-only permission broker as other Native tools. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |
| P38-3 | Keep generic MCP discovery as fallback while preferring direct tools. | Completed | Native prompts now tell the model to call direct `mcp__server__tool` tools first, using `list_mcp_tools`, `list_mcp_resources`, and `call_mcp_tool` only for rediscovery, resources, or fallback. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run test:runtime` |

## Phase 39: MCP Connection And Tool Refresh Platform

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P39-1 | Add a project-safe MCP connection manager shared by health checks, tool discovery, resource reads, and tool calls. | Completed | Added a main-process MCP connection manager that normalizes endpoints, initializes once per server lifecycle, sends `notifications/initialized` once per connection, tracks status/server info/last error/initialize count, supports explicit reconnect, and routes Unity health plus MCP client operations through the same connection cache. Bypassing health-cache now refreshes health/resource state without forcing another MCP initialize. | Focused `unity-onboarding.test.ts`; `npm run build` |
| P39-2 | Refresh materialized MCP tools between Agent tool turns. | Completed | Native OpenAI-compatible and AI SDK tool loops now re-run MCP `tools/list` at tool-turn boundaries, diff dynamic tool names, emit a structured refresh stage when tools are added or removed, and rebuild the provider tool schema so newly connected or changed MCP tools become available without restarting the conversation. | Focused `agent-runtime.test.ts`; `npm run build` |

## Phase 40: MCP Full Capability Surface

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P40-1 | Expose the broader MCP server capability surface beyond tools and static resources. | Completed | Added typed MCP client support for paginated `prompts/list`, `prompts/get`, paginated `resources/templates/list`, and optional `completion/complete`, all routed through the shared connection manager. Optional prompts, resource templates, and completion calls return neutral empty results when the server does not advertise the relevant capability, so metadata refresh does not fail on tools-only servers. | Focused `unity-onboarding.test.ts`; `npm run build` |
| P40-2 | Surface MCP capability metadata in project/global MCP settings. | Completed | Project MCP settings and global MCP Registry now show capability badges derived from server capabilities and discovered counts, plus Prompt/resource-template summaries alongside tool/resource summaries. Refresh clears stale metadata before loading the new server state. | `npm run build` |

## Phase 41: MCP Elicitation Bridge

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P41-1 | Bridge MCP `elicitation/create` requests into Funplay's existing Agent user-input flow. | Completed | The MCP JSON-RPC transport now recognizes server-initiated client requests during a tool call. `elicitation/create` is converted into the existing pending user-input UI, enum schemas become selectable options, cancelled inputs return `action: cancel`, accepted inputs return `action: accept` with structured content, and the MCP tool call resumes with the final tool result after the client response is posted back. | Focused `unity-onboarding.test.ts`; `npm run build` |

## Phase 42: MCP Transport Expansion

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P42-1 | Add a transport-aware MCP client foundation with stdio server support. | Completed | Extended MCP plugin configuration with `stdio` transport, command, args, cwd, and env fields; persisted the launch config in SQLite; added a stdio JSON-RPC transport that spawns and reuses a local server process, handles line-delimited JSON-RPC requests/responses, supports server-initiated client requests such as elicitation, updates connection snapshots, and lets existing tools/resources/tool calls work through the same MCP client facade as HTTP. MCP settings UI now exposes basic stdio command configuration. | Focused `unity-onboarding.test.ts`; `npm run build` |
| P42-2 | Add stdio process lifecycle controls, crash visibility, and operator UI. | Completed | Stdio MCP connections now expose structured process state in connection snapshots, including process status, PID, launch command, start/stop time, exit code/signal, and stderr tail. Added an explicit `mcp:stop` IPC/API path, graceful stop plus restart controls in project/global MCP settings, process log display, config-change cleanup to avoid orphaned stdio processes, and crash tests proving stderr/exit state remain inspectable after failures. | Focused `unity-onboarding.test.ts`; `npm run build` |
| P42-3 | Support modern remote MCP transports with the official SDK. | Completed | Added direct `@modelcontextprotocol/sdk` dependency and new `streamable-http` / `sse` MCP transport types. Remote SDK transports now use the official client, preserve the existing typed MCP facade for tools/resources/prompts/templates/completion, advertise elicitation capability, close failed transports, and keep legacy HTTP JSON-RPC untouched for Unity/Funplay bridge compatibility. MCP presets now include Streamable HTTP and SSE remote server options. | Focused `unity-onboarding.test.ts`; `npm run build` |

## Phase 43: MCP Permission Policy System

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P43-1 | Add persisted per-server and per-tool MCP policy resolution. | Completed | Added persisted MCP policy fields for server defaults and per-tool overrides (`infer` / `allow` / `ask` / `deny`, plus `infer` / `read` / `write` risk classification). Native MCP direct-tool materialization now uses a shared resolver instead of local name-only inference, hides denied tools from the provider schema, annotates exposed tools with policy summaries, and blocks denied generic `call_mcp_tool` executions at the tool execution point. | Focused `agent-runtime.test.ts`; focused `store-migrations.test.ts`; `npm run build` |
| P43-2 | Add MCP policy editing to the project/global server configuration UI. | Completed | The MCP plugin editor now persists server default permission/risk policy, resets presets to safe inference defaults, validates per-tool JSON overrides before saving, and renders existing tool policy overrides so global and project MCP settings can inspect and change the policy without direct database edits. | `npm run build`; focused `agent-ui-render.test.ts` |
| P43-3 | Persist session-scoped MCP tool approvals by stable server/tool key. | Completed | Session permission grants now carry stable MCP approval keys (`pluginId:toolName`) separately from ordinary workspace tool names. Native direct MCP tools and generic `call_mcp_tool` permission requests include MCP server/tool/policy impact metadata, `allow_session` persists the stable key, and later calls to the same MCP tool reuse that approval without broadening access to all MCP calls. | `npm run build`; focused `agent-runtime.test.ts` |
| P43-4 | Show richer MCP impact summaries in permission and transcript UI. | Completed | Permission impact payloads now include MCP server, original tool name, policy source, permission, risk, and stable approval key. Chat composer and streaming transcript permission prompts render those MCP details alongside paths, commands, and checkpoint policy so users can approve the exact external tool being requested. | `npm run build`; focused `agent-ui-render.test.ts` |

## Phase 44: MCP Tool Mapping Persistence And Audit

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P44-1 | Persist MCP tool snapshots with stable exposed-name mappings and schema hashes. | Completed | Added `mcp_tool_snapshots` persistence for each discovered MCP server tool: plugin id/name, original MCP tool name, exposed Agent tool name, description, stable schema hash, schema JSON, policy summary, discovery timestamp, and added/changed/unchanged/removed state. Native MCP materialization records snapshots after `tools/list`, while tests verify schema-order-stable hashing, changed-tool detection, and removed-tool marking. | `npm run build`; focused `store-migrations.test.ts`; focused `agent-runtime.test.ts` |
| P44-2 | Preserve MCP exposed-name mapping in tool results and UI summaries. | Completed | Direct MCP tool calls now carry the exposed Agent tool name and policy summary into `AgentToolMcpResult`, which is persisted through tool-result content blocks, runtime events, replay logs, and rendered in the structured tool activity UI. This links `mcp__server__tool` transcript entries back to the original MCP target and policy that produced them. | `npm run build`; focused `agent-runtime.test.ts`; focused `agent-ui-render.test.ts` |
| P44-3 | Surface MCP changed/removed tool mapping warnings in settings UI. | Completed | Project and global MCP settings now load persisted MCP tool snapshots through IPC and render a Tool Mapping Audit card. Changed or removed tools produce a visible warning, and each row shows original MCP tool name, exposed Agent tool name when available, and current snapshot state. | `npm run build`; focused `agent-ui-render.test.ts` |

## Phase 45: Raw MCP Control Plane

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P45-1 | Add a guarded raw MCP diagnostic request path. | Completed | Added a `sendRawMcpRequest` IPC/API path backed by a controlled MCP JSON-RPC helper. It allows only read/diagnostic methods (`tools/list`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `resources/templates/list`, `completion/complete`), rejects side-effecting `tools/call`, caps request/response size, applies a 10s timeout, and redacts sensitive keys before returning results. | `npm run build`; focused `agent-runtime.test.ts` |
| P45-2 | Add raw MCP diagnostics UI to project/global MCP settings. | Completed | Project and global MCP detail panels now include a Raw Diagnostics card with a fixed method picker, JSON params editor, guarded send action, inline parse/request errors, and bounded result preview. The UI deliberately omits `tools/call` and other side-effecting raw methods. | `npm run build`; focused `agent-ui-render.test.ts` |
| P45-3 | Persist and surface raw MCP diagnostic operation logs. | Completed | Raw MCP diagnostic requests now append bounded audit records for success/failure, method, plugin, duration, request/response size, and error text. Project and global MCP settings load those records and render a Raw Operation Audit card next to the diagnostic sender so operators can tell whether recent raw calls were fresh, successful, or failed. | `npm run build`; focused `store-migrations.test.ts`; focused `agent-runtime.test.ts`; focused `agent-ui-render.test.ts` |

## Phase 46: MCP UI Maturity

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P46-1 | Make MCP server lists operationally scannable. | Completed | Project and global MCP server rows now show connection status, per-server errors, selected-server capability counts, and explicit permission/risk policy summaries directly in the list. This preserves the existing project/global enablement model while making operational state visible before opening the detail panel. | `npm run build`; focused `agent-ui-render.test.ts` |

## Phase 47: MCP Compatibility Matrix

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P47-1 | Add a deterministic MCP compatibility matrix gate. | Completed | Added a dedicated `agent:mcp-compatibility` entrypoint and benchmark row covering Unity/Funplay HTTP MCP, connection reuse/reconnect, stdio lifecycle/crash visibility, Streamable HTTP, SSE, prompts/resources/templates/completion, elicitation, and a web-search-style tool server. | `npm run build`; `npm run agent:mcp-compatibility`; `npm run agent:benchmark` |

## Phase 48: Agent Core v2 Contract

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P48-1 | Define the Claude Code style Agent Core v2 maturity contract. | Completed | Added `docs/agent-core-v2-roadmap.md` with the maturity standard, explicit state machine, structured message parts, loop decision table, and AC48-AC60 implementation route. Added shared Agent Core v2 state/part/provider-step types plus a protocol-neutral loop-decision helper that codifies “tool calls continue, real final stop completes.” | `npm run build`; focused `agent-core-v2.test.ts`; `npm run agent:roadmap-audit` |

## Phase 49: Agent Core v2 Part Mapping

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P49-1 | Map existing runtime/chat event structures into Agent Core parts. | Completed | Added conversion helpers that turn `ChatContentBlock`, `PromptStreamEvent`, and `AgentRuntimeEvent` records into ordered Agent Core v2 parts while preserving tool metadata, permission impact, user input requests, context summaries, usage, and run errors. This creates the compatibility layer needed before Native and Claude loops switch their internal transcript model. | `npm run build`; focused `agent-core-v2.test.ts`; `npm run agent:roadmap-audit` |

## Phase 50: Agent Core v2 State Machine Foundation

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P50-1 | Add a reusable Agent Core state-machine foundation before runtime integration. | Completed | Added `createAgentCoreStateMachine`, transition validation, terminal-state checks, transition history snapshots, and decision application on top of the Agent Core v2 state table. Native and Claude runtime integration remains tracked in `docs/agent-core-v2-roadmap.md` as the next AC50 step. | `npm run build`; focused `agent-core-v2.test.ts`; `npm run agent:roadmap-audit` |
| P50-2 | Start wiring the Native main path through Agent Core v2 state tracking. | Completed | The OpenAI-compatible Native tool loop now runs an Agent Core v2 state machine across provider streaming, tool collection, tool execution, result recording, continuation, completion, and empty-final failure. `NativeToolLoopRunResult` exposes `coreState`, and runtime stages emit `stage:native_agent_core_v2` snapshots for observability without changing tool execution behavior. | `npm run build`; focused `agent-core-v2.test.ts`; focused `agent-runtime.test.ts`; `npm run agent:roadmap-audit` |
| P50-3 | Wire remaining Native and Claude runtime paths through Agent Core v2 state tracking. | Completed | The AI SDK Native tool loop now emits `stage:native_ai_sdk_agent_core_v2` snapshots and returns `coreState`; Claude SDK/CLI runtime now emits `stage:claude_agent_core_v2` snapshots across context loading, compaction, provider streaming, tool execution, tool-result recording, resume retry, failure, and completion. | `npm run build`; focused `agent-runtime.test.ts`; `npm run agent:roadmap-audit` |

## Phase 51: Agent Core v2 Provider Step Adapters

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P51-1 | Standardize provider adapters around `AgentCoreProviderStepResult`. | Completed | Added a provider-step adapter that maps OpenAI-compatible, AI SDK, and Claude result events into protocol-neutral Agent Core provider steps with normalized finish reasons, tool calls, usage, warnings, and raw metadata. Native and Claude Agent Core state stages now carry the latest normalized provider step beside the state snapshot. | `npm run build`; focused `agent-provider-step-adapter.test.ts`; focused `agent-runtime.test.ts`; `npm run agent:roadmap-audit` |

## Phase 52: Agent Core v2 Tool Executor Transactions

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P52-1 | Centralize Native tool execution transactions behind a reusable Tool Executor. | Completed | Added `native/tool-executor.ts` with a transaction recorder for running/result/completed tool events, precomputed tool errors, unknown-tool handling, and ToolSet execution. The OpenAI-compatible Native tool loop now uses this executor for real tool calls, malformed arguments, invalid input, duplicate result replay, and interrupted-tool result recording while preserving existing state/message replay behavior. | `npm run build`; focused `native-tool-executor.test.ts`; focused `agent-runtime.test.ts`; `npm run agent:roadmap-audit` |

## Phase 53: Agent Core v2 Replay Builders

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P53-1 | Build protocol-specific replay builders from Agent Core parts. | Completed | Added `agent-core-replay.ts` with builders that convert ordered Agent Core parts into OpenAI-compatible tool messages and AI SDK `ModelMessage` sequences. Assistant text, thinking, tool calls, tool results, tool errors, context summaries, and run errors now have a protocol replay path that does not rely on assistant pseudo tool text. | `npm run build`; focused `agent-core-replay.test.ts`; `npm run agent:roadmap-audit` |

## Phase 54: Agent Core v2 Interruption And Resume

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P54-1 | Make interruption/resume use Agent Core states and stable cursors. | Completed | Added persisted `agent_core_state` runtime events for Agent Core v2 stage snapshots, exposed the latest `coreState` on runtime runs, and included it in resume context alongside the existing stable completed-tool `resumeCursor`. Persisted core-state events now convert back into ordered Agent Core `system_event` parts for future replay/debug UI. | `npm run build`; focused `stream-manager-persistence.test.ts`; focused `agent-core-v2.test.ts`; `npm run agent:roadmap-audit` |

## Phase 55: Agent Core v2 Context Summaries

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P55-1 | Upgrade context compaction to emit auditable `context_summary` parts. | Completed | Native and Claude context compression stages now include the generated summary plus coverage/audit metadata in structured stage input. The runtime event log persists that data as `context_summary` events, and `runtimeEventToAgentCoreParts` converts them into ordered Agent Core `context_summary` parts for replay/debug surfaces. | `npm run build`; focused `stream-manager-persistence.test.ts`; focused `agent-core-v2.test.ts`; `npm run agent:roadmap-audit` |

## Phase 56: Agent Core v2 Todo Updates

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P56-1 | Promote todo/task graph updates into first-class Agent Core parts. | Completed | `update_todo_list` tool-use events now persist normalized `todo_update` runtime events with stable id/title/status items. Runtime event replay converts those events into ordered Agent Core `todo_update` parts so task progress can be rendered and debugged without reparsing tool text. | `npm run build`; focused `stream-manager-persistence.test.ts`; focused `agent-core-v2.test.ts`; `npm run agent:roadmap-audit` |

## Phase 57: Agent Core v2 Transcript Rendering

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P57-1 | Move transcript rendering to ordered Agent Core parts. | Completed | Completed assistant messages now prefer `metadata.agentCoreParts` when available. The renderer orders parts by sequence/time and displays assistant text, tool calls/results, context summaries, todo updates, and run errors from structured parts without parsing assistant pseudo tool text. | `npm run build`; focused `agent-ui-render.test.ts`; `npm run agent:roadmap-audit` |

## Phase 58: Agent Core v2 Run Debugger Export

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P58-1 | Add an Agent Run Debugger view/export based on state transitions and parts. | Completed | `buildAgentReplayLog` now includes an `agentCore` debugger payload with the latest Agent Core state, transition history, ordered parts derived from persisted runtime events, and part-kind counts. This gives the future debugger UI a structured export without reparsing transcript text. | `npm run build`; focused `agent-run-artifacts.test.ts`; `npm run agent:roadmap-audit` |

## Phase 59: Agent Core v2 Benchmark Gate

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P59-1 | Add `agent:core-v2-benchmark` and connect it to the maturity benchmark. | Completed | Added `scripts/agent-core-v2-benchmark.mjs` and `npm run agent:core-v2-benchmark`, covering state/part conversion, replay builders, runtime persistence, debugger export, and transcript rendering. The main deterministic `agent:benchmark` now includes this Agent Core v2 maturity slice. | `npm run build`; `npm run agent:core-v2-benchmark`; `npm run agent:roadmap-audit` |

## Phase 60: Agent Core v2 Default Runtime Path

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P60-1 | Switch default Native/Claude conversation completion onto Agent Core parts. | Completed | `executeGenericConversation` now derives ordered `metadata.agentCoreParts` from runtime `assistantContentBlocks` when a Native or Claude runtime does not already provide Agent Core parts. Completed chat messages therefore render assistant text, tool calls, and tool results from the Agent Core v2 transcript by default while preserving explicit runtime-provided parts. The Agent Core v2 benchmark now includes this default runtime path. | `npm run test:runtime`; `npm run build`; `npm run agent:core-v2-benchmark`; `npm run agent:roadmap-audit` |

## Phase 61: Skills v2 Platform Registry

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P61-1 | Define the Skills v2 platform maturity route and add filesystem Skill metadata discovery. | Completed | Added `docs/skills-v2-roadmap.md`, shared Skill package/index types, and `skill-registry.ts`. The registry parses Claude-style `SKILL.md` packages from project `.claude/skills` and user `~/.claude/skills`, records provenance and invocation metadata, applies user-over-project precedence, and injects metadata-only entries into Agent workspace context. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 62: Skills v2 Native Tool Surface

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P62-1 | Add read-only Native tools for listing and loading selected Skills. | Completed | Registered `list_agent_skills` and `read_agent_skill` as low-risk read-only tools. Native prompts now direct the model to discover/load matching filesystem Skills on demand instead of eagerly ingesting every `SKILL.md`, while Claude prompts expose filesystem Skill metadata and continue to load existing project-policy skills. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 63: Skills v2 Explicit Invocation

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P63-1 | Add explicit `/skill-name` activation with lazy full-instruction loading. | Completed | `buildGenericWorkspaceContext` now resolves messages that start with `/skill-name` against the filesystem Skill registry and loads only the selected user-invocable Skill into `toolContext.activeSkills`. `/compact` remains reserved for context compaction. Native and Claude prompts render active Skill instructions separately from metadata-only Skill indexes. | Focused `agent-runtime.test.ts`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 64: Skills v2 Automatic Activation

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P64-1 | Auto-activate model-invocable Skills from conservative metadata matches. | Completed | Filesystem Skills with `modelInvocable` enabled now activate automatically when the user message strongly matches the Skill name/description/examples. Auto activation loads at most two Skill instructions and skips packages with `disable-model-invocation: true`, preserving metadata-only behavior for weak matches. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run test:runtime`; `npm run agent:roadmap-audit` |

## Phase 65: Skills v2 Supporting Files

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P65-1 | Add lazy supporting-file listing and reading for Skill packages. | Completed | Registered `list_agent_skill_files` and `read_agent_skill_file` as read-only Native tools. Supporting-file reads are scoped to the selected Skill package, reject path traversal and symlinks, skip `SKILL.md`, reject binary-like files, and cap file size/content. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run test:runtime`; `npm run agent:roadmap-audit` |

## Phase 66: Skills v2 Trust And Permission Boundaries

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P66-1 | Add Skill trust, source verification, permission policy, and script execution boundaries. | Completed | Filesystem Skills now expose trust level, verification status, content SHA-256, permission policy, script policy, and declared scripts. Approval-required or untrusted Skills are excluded from metadata auto-activation, and declared scripts are metadata only: execution must go through ordinary Agent tools and the existing permission broker. Native/Claude prompts and skill tools surface these boundaries. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 67: Claude SDK Skills Integration

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P67-1 | Integrate Claude SDK native Skills support where available. | Completed | Claude SDK options now apply Skills-aware `settings`: inactive Skills are hidden from model auto-selection, inactive user-invocable Skills remain slash-visible, and inline Skill shell execution is disabled. When a Claude SDK AgentDefinition is active, Funplay attaches active filesystem Skill names to that agent's `skills` allowlist. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 68: Skills v2 Observability

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P68-1 | Add Skill activation runtime events, replay export, and transcript visibility. | Completed | Active filesystem Skill selections now persist as `skill_activation` runtime events, appear in replay metrics and Agent Core debugger parts, and render in completed chat transcripts from structured Agent Core system parts. The Skills v2 benchmark includes these observability checks. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 69: Skills v2 Benchmark Gate

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P69-1 | Add deterministic Skills v2 benchmark coverage. | Completed | Added `scripts/agent-skills-v2-benchmark.mjs` and `npm run agent:skills-v2-benchmark`, covering registry discovery, metadata context, explicit and automatic activation, supporting-file reads, and read-only tool-boundary checks. The main deterministic `agent:benchmark` now includes this Skills v2 slice. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run test:runtime`; `npm run agent:benchmark`; `npm run agent:roadmap-audit` |

## Phase 70: Skills v2 Settings UI

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P70-1 | Mature the Settings UI for source precedence, conflicts, updates, and project overrides. | Completed | Added a main-process filesystem Skill registry IPC endpoint and rendered it in Project Settings. The Skills page now shows source precedence, same-name override conflicts, trust/verification status, permission policy, script policy, and suggested tools alongside existing catalog sync/update and custom project Skill override controls. | `npm run agent:skills-v2-benchmark`; `npm run build`; `npm run agent:roadmap-audit` |

## Phase 71: Agent Platform v3 Host Runtime Contract

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P71-1 | Complete the Agent Platform v3 host-driven runtime route. | Completed | Added `docs/agent-platform-v3-roadmap.md` and implemented the Agent Platform v3 contract: unified `AgentRunController`, canonical Agent Core parts at persistence/render boundaries, platform `ToolExecutor` transactions, host-owned permission pauses/denials, resumable interruption cleanup, structured context summaries, observable ordered chat rendering, and redacted replay/debugger export. | `npm run agent:platform-v3-benchmark`; `npm run build`; `npm run test:runtime`; `npm run agent:roadmap-audit` |

## Phase 72: Agent Platform v3 Benchmark And Audit Convergence

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P72-1 | Fold Agent Platform v3 into the main maturity gates and route audit. | Completed | Added `scripts/agent-platform-v3-benchmark.mjs` and `npm run agent:platform-v3-benchmark`, covering long tasks, failed edits, permission denial, restart resume, context compression, MCP compatibility, observable UI rendering, and replay debugger export. The main deterministic `agent:benchmark` now runs this slice, `runtime:maturity-gate` relies on the required benchmark tier for v3 coverage, and `agent-roadmap-audit` verifies the v3 route cannot drift open. | `npm run agent:platform-v3-benchmark`; `npm run agent:roadmap-audit`; `npm run agent:benchmark`; `npm run runtime:maturity-gate` |

## Phase 73: Claude Code Style Lifecycle Hooks

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P73-1 | Add a safe platform foundation for Claude Code style lifecycle hooks. | Completed | Added `agent-hooks.ts` with Claude-style settings parsing, bounded platform rule normalization, matcher evaluation, and structured outcomes for `audit`, `append_context`, `block`, and `command`. The foundation represents command hooks as `requires_permission` first, so execution has to go through the host permission path added in P74. Hook evaluations can be recorded as runtime events, rendered as Agent Core system parts, and exported in replay metrics/debugger payloads. The main deterministic `agent:benchmark` now includes a lifecycle hooks slice. | `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-hooks.test.ts`; `npm run agent:benchmark`; `npm run agent:roadmap-audit` |

## Phase 74: Controlled Hook Command Execution

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P74-1 | Execute lifecycle hook commands only through host permission and the existing command tool path. | Completed | Added `executeAgentLifecycleHookCommand`, which takes a matched command hook, requests host permission as `run_command`, and then executes through `executeAgentToolAction` so hook commands inherit the same project cwd guard, timeout handling, background-command policy, abort signal, and structured command result metadata as normal Agent tools. Denied commands produce `permission_denied` without side effects; approved commands produce `command_completed` or `command_failed` hook results that remain replayable as runtime hook events. | `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-hooks.test.ts`; `npm run build`; `npm run agent:benchmark` |

## Phase 75: Lifecycle Hooks In The Native Run Loop

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P75-1 | Wire Claude Code style lifecycle hooks into the host-owned Native runtime path. | Completed | Added project hook config loading for `.claude/settings.json`, `.claude/settings.local.json`, and `.funplay/hooks.json`; introduced a reusable hook runner that emits ordered runtime/stage outcomes, appends host hook context, and executes command hooks only through the controlled command path. Native conversation turns now process `UserPromptSubmit` and `Stop`; Native workspace tools process `PreToolUse` before side effects and `PostToolUse` after structured results, so hook blocks prevent actual writes/commands/MCP calls before the permission/tool executor path mutates the workspace. | `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-hooks.test.ts`; focused Native OpenAI-compatible hook-block regression |

## Phase 76: Lifecycle Hooks In The Claude SDK Permission Boundary

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P76-1 | Run `PreToolUse` hooks before Claude Agent SDK tools pass host permission. | Completed | `createClaudeSdkPermissionHandler` now runs the shared lifecycle hook runner before the existing Funplay permission broker. A blocking `PreToolUse` hook returns an SDK `deny` result before Claude can execute the tool and before the normal host permission prompt fires. Non-blocking audit/context hooks remain observable but do not bypass Funplay permission denial, preserving Claude Code's invariant that hook approval cannot override host policy. The main `claude-code-platform-hooks` benchmark slice now includes Claude SDK option/permission tests. | `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/claude-sdk-options.test.ts`; `npm run agent:benchmark` |

## Phase 77: Claude Tool Result Lifecycle Parity

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P77-1 | Run `PostToolUse` hooks when Claude SDK/CLI reports tool results. | Completed | Claude runtime now observes structured `tool_result` blocks from both SDK and legacy CLI streams, deduplicates them by `toolUseId`, resolves the original Claude tool name, and runs shared `PostToolUse` hooks with result preview, error status, media count, and source metadata. Hook command actions still execute only through Funplay's permission-gated `run_command` path. Because Claude owns external tool execution before the host sees the result, `PostToolUse` hooks are audit/command/telemetry boundaries rather than authority escalation or retroactive side-effect blockers. | Focused fake Claude CLI regression in `tests/runtime/agent-runtime.test.ts`; `npm run build`; `npm run agent:benchmark` |

## Phase 78: Session And Compaction Lifecycle Boundaries

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P78-1 | Promote `SessionStart` and `PreCompact` into runtime-owned lifecycle boundaries. | Completed | Native and Claude runtimes now run `SessionStart` hooks before provider input is built, so `append_context` is visible to the first model request and `block` stops the turn before provider/tool side effects. Native and Claude automatic context handoff plus forced context-too-long retry now run `PreCompact` hooks before applying compression patches or restarting provider sessions. Blocking `PreCompact` skips that compression attempt; command hooks still execute only through Funplay's permission-gated `run_command` path. The lifecycle benchmark now covers Native `SessionStart`, Claude `PreCompact`, Claude `PostToolUse`, and Claude SDK `PreToolUse` boundaries. | Focused lifecycle regressions in `tests/runtime/agent-runtime.test.ts`; `npm run agent:benchmark` |

## Phase 79: Notification And Subagent Lifecycle Boundaries

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P79-1 | Promote notification and subagent termination into host-owned lifecycle boundaries. | Completed | Native notification tools now emit `Notification` hooks after the host records the real notification/task result, and delegated subagent tools emit `SubagentStop` hooks after completion or failure. Detached background subagents emit `SubagentStop` when their task record reaches a terminal state. Hook command actions still execute only through Funplay's permission-gated `run_command` path; `PreToolUse` remains the pre-side-effect blocker for notification tools. | Focused lifecycle regressions in `tests/runtime/agent-runtime.test.ts`; `npm run agent:benchmark` |

## Phase 80: Claude Prompt And Stop Lifecycle Boundaries

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P80-1 | Bring Claude runtime `UserPromptSubmit` and `Stop` lifecycle parity up to the Native route. | Completed | Claude runtime now runs `UserPromptSubmit` hooks after `SessionStart` and before CLI/SDK prompt construction, so appended hook context is visible to Claude in the provider input rather than handled as UI text. It also runs `Stop` hooks after a successful final text result and before the host returns the turn, making successful completion observable through the same lifecycle event used by Native. Command hook actions still execute only through Funplay's permission-gated `run_command` path. | Focused fake Claude CLI lifecycle regression in `tests/runtime/agent-runtime.test.ts`; `npm run agent:benchmark` |

## Phase 81: Lifecycle Hook Process Visibility

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P81-1 | Surface command and blocking lifecycle hook work in the visible Agent process trail. | Completed | Command lifecycle hooks, blocked hooks, permission-denied hooks, and failed hook commands now become inline process activities in both live stream state and completed conversation metadata. Routine audit/context hooks still persist as structured runtime hook events and replay/debugger data without adding transcript noise. This keeps host-owned build/test/validation hooks visible like tools while preserving a quiet normal chat surface. | Focused process transcript and stream-session regressions; `npm run test:runtime` |

## Phase 82: Execution Plan Agent Core Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P82-1 | Bring the execution-plan runtime into the unified Agent Core controller projection. | Completed | Execution-plan streams now record MCP/Unity plan tool calls, tool results, and final replan text through `AgentRunController`, emit `stage:execute_plan_agent_core_v2` snapshots for runtime event persistence, and store controller-ordered `agentCoreParts` on the completed assistant message. The main and v3 benchmark gates now include the execute-plan projection regression. | Focused execute-plan MCP stream regression; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark` |

## Phase 83: Execution Plan Permission Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P83-1 | Represent execution-plan Unity write permission as structured Agent Core parts. | Completed | The execution-plan runtime now records Unity write permission checks as a synthetic `execute_plan_unity_write` controller boundary with `permission_request`, approval `tool_result`, or denial `tool_error` parts. This keeps Plan-mode/read-only write rejection and approved Build/legacy ask writes replayable through the same Agent Core state machine as normal tools. The main and v3 benchmark gates include the denied-write projection regression. | Focused controller permission approval/denial tests; focused execute-plan denied-write stream regression; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark` |

## Phase 84: Permission Wait Interruption Recovery

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P84-1 | Finalize pending permission waits when a run is interrupted. | Completed | Added controller regression coverage for interruption while paused on a permission request. The execution-plan abort path now uses `interruptResumable()` for AbortError instead of trying to record a normal provider error step, so pending permission/tool ids are closed as structured `interrupted` tool errors and no invalid `awaiting_permission -> streaming_model_step` transition is attempted. | Focused controller pending-permission interruption test; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark` |

## Phase 85: Execution Plan Cancellation Cleanup

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P85-1 | Clear pending permission requests when an execution-plan stream is cancelled. | Completed | `cancelAgentExecutionPlanStream()` now explicitly calls `cancelPendingPermissionsForStream()` before clearing pending user inputs and deleting the active stream, matching the conversation cancellation path. A focused regression registers a pending permission without an AbortSignal to prove cancellation itself resolves it as `deny` instead of leaving an orphaned permission promise. | Focused execute-plan cancellation permission cleanup regression; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark` |

## Phase 86: Execution Plan Tool Metadata Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P86-1 | Preserve MCP/Unity execution-plan metadata in canonical Agent Core parts. | Completed | `AgentRunController` now accepts structured result metadata for tool successes and errors. Execution-plan MCP/Unity operations attach `mcp` metadata including plugin id/kind, operation, target, timeout, schema guard, argument size, and content-part count before the result enters stream events, runtime event logs, persisted `agentCoreParts`, and replay-compatible chat blocks. Tool-error parts now carry the same typed metadata surface as tool-result parts so failed MCP operations remain inspectable without parsing text summaries. | Focused controller metadata regression; focused execute-plan MCP stream regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 87: Canonical Tool Call Lifecycle Status

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P87-1 | Make tool-call part status host-owned in canonical transcripts. | Completed | `AgentRunController` now marks the originating `tool_call` part as `completed` when a result is recorded and `failed` when a tool error, permission denial, or resumable interruption is recorded. Parallel tool calls keep still-pending siblings as `pending`, so UI/replay can render lifecycle state directly from canonical parts instead of inferring it from later result ordering. | Focused controller lifecycle status regressions; focused execute-plan MCP stream regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 88: Structured Run Error Parts

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P88-1 | Persist provider/runtime failures as canonical Agent Core run-error parts. | Completed | `AgentRunController.recordProviderStep()` now records provider/runtime step failures as `run_error` parts before applying the failed loop decision. Failed runs therefore carry a structured transcript artifact with a diagnostic code and recoverability marker, giving UI, replay, and audit exports a stable source for run-level failures instead of relying only on state-transition reason strings. | Focused controller provider-error regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 89: Controller-Owned Usage Parts

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P89-1 | Promote provider usage telemetry into canonical Agent Core parts. | Completed | `AgentRunController.recordProviderStep()` now records normalized provider token usage as `usage` parts whenever a provider step supplies `AgentCoreProviderStepResult.usage`. Usage stays structured and non-visible, while final assistant text remains the visible closing part for no-tool stop steps. This moves token accounting closer to the unified controller contract instead of leaving it only in runtime-specific event side channels. | Focused controller usage-part regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 90: User Input Runtime Event Persistence

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P90-1 | Persist user-input waits and resolutions as first-class runtime events. | Completed | Agent `ask_user` and MCP elicitation waits now enter the runtime event log through `user_input_request` events, and completed responses enter as bounded `user_input_resolved` events with answer previews, selected option ids, and cancellation state. Agent Core replay maps persisted requests back into `user_input_request` parts and resolutions into system events, making user-driven pauses inspectable after refresh or replay without relying only on live stream state. | Focused runtime user-input persistence regression; focused Agent Core user-input event mapping regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 91: Permission Runtime Event Persistence

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P91-1 | Persist permission waits and resolved decisions as first-class runtime events. | Completed | Agent permission requests now enter the runtime event log through `permission_request` events from both `requestPermission` and external `onPermissionRequest`, including stable request ids, risk, tool name, and bounded impact metadata. Permission decisions now enter as `permission_resolved` events after any session-scoped grant is persisted and before the waiting tool proceeds, so replay/debug can distinguish an approved, session-approved, or denied pause without relying only on live stream state. Agent Core replay maps persisted requests back into `permission_request` parts and resolutions into system events. | Focused runtime permission persistence regression; focused Agent Core permission event mapping regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 92: Canonical Transcript Text Preference

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P92-1 | Prefer canonical Agent Core parts over legacy transcript projections when extracting text or process tools. | Completed | Shared chat text helpers now derive context text and visible assistant text from `metadata.agentCoreParts` before consulting legacy `contentBlocks` or raw message content. Completed-message process summaries now derive tool entries from Agent Core parts before falling back to operation logs or content blocks. This prevents stale compatibility projections from leaking into archived context, final execution-plan text extraction, restart previews, copy/search helpers, and completed tool summaries when a canonical transcript exists. | Focused context-text regression; focused completed-process summary regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase 93: Tool Transaction Runtime Event Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P93-1 | Persist bounded ToolExecutor transaction summaries through stream, runtime event, replay, and Agent Core projections. | Completed | ToolExecutor now exposes `createToolExecutorTransactionSummary()` and Native workspace tool execution emits that bounded summary with each tool result after the transaction reaches its terminal phase. Stream tool-result events, persisted runtime `tool_result` events, Agent Core tool-result/error parts, live stream mirrors, and replay debugger tool transactions now preserve the same transaction id, tool class, phase/status, event count, timestamps, permission summary, and checkpoint summary without persisting full tool input/output/event arrays. This moves tool lifecycle audit closer to the shared host-owned executor contract while keeping the legacy callback ordering intact. | Focused ToolExecutor transaction regression; focused Native executor callback/order regression; focused Agent Core runtime-event conversion regression; `npm run build` |

## Phase 94: Controller Tool Transaction Ingestion

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P94-1 | Let `AgentRunController` preserve ToolExecutor transaction summaries on canonical tool result/error parts. | Completed | `AgentRunController.recordToolResult()` now accepts an optional bounded transaction summary and stores it on canonical `tool_result` / `tool_error` parts. Native ToolExecutor completion passes the summary through the `onResult` hook into the Native controller path, and the Execution Plan / Claude controller adapters accept the same field so future MCP/browser/terminal transaction producers can converge without adding new side channels. | Focused controller transaction metadata regression; focused Native executor callback/order regression; `npm run build` |

## Phase 95: Execution Plan MCP Transaction Producer

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P95-1 | Make Execution Plan MCP/Unity operations produce ToolExecutor transaction summaries. | Completed | `executeOperation()` now creates a ToolExecutor transaction for each Execution Plan MCP resource read or Unity tool call, advances it into execution, completes it on success or failure, and emits the bounded summary alongside the existing MCP result metadata. Execution Plan stream events, persisted runtime events, Agent Core parts, and controller snapshots now retain the same MCP transaction class, phase/status, event count, and timing metadata that Native workspace tools already expose. | Focused execute-plan stream transaction regression; focused ToolExecutor transaction regression; `npm run build` |

## Phase 96: Execution Plan Permission Transaction Producer

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P96-1 | Make Execution Plan Unity write permission checks produce ToolExecutor transaction summaries. | Completed | The synthetic `execute_plan_unity_write` permission boundary now creates a ToolExecutor transaction with `ask` permission metadata, the stable permission request id, external checkpoint policy, and the final approval or denial decision. Approved permission results and denied permission tool errors now enter the controller transcript with bounded transaction summaries, making permission pauses auditable through the same lifecycle surface as actual MCP/Unity operations. | Focused execute-plan permission transaction regression; `npm run build` |

## Phase 97: Lifecycle Hook Command Transaction Producer

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P97-1 | Make lifecycle hook command execution produce ToolExecutor transaction summaries. | Completed | Command-style lifecycle hooks now wrap their host `run_command` execution in a ToolExecutor transaction. The transaction records the `ask` permission request id, approval or denial decision, command execution start, timeout metadata, external checkpoint policy, and terminal result before the hook result is persisted. This makes automated lifecycle command work visible to replay/audit through the same bounded transaction surface used by Native workspace tools and Execution Plan MCP/Unity operations. | Focused lifecycle command hook transaction regression |

## Phase 98: Lifecycle Hook Transaction Replay Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P98-1 | Project lifecycle hook command transactions into replay/debugger audit surfaces. | Completed | Replay/debugger export now includes lifecycle hook command transaction summaries directly on hook events and mirrors them into the unified tool transaction list. Denied and approved command hooks can be inspected from the hook timeline and the tool transaction audit surface without parsing raw runtime event payloads or relying on command-result preview text. | Focused lifecycle command hook replay regression |

## Phase 99: Lifecycle Hook Transaction Agent Core Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P99-1 | Preserve lifecycle hook command transactions on canonical Agent Core hook parts. | Completed | Agent Core runtime-event conversion now includes lifecycle hook command transaction summaries on hook `system_event` metadata. Canonical parts consumers can inspect hook command permission/execution status from the same ordered transcript surface used by UI and replay, without falling back to raw hook event bodies or replay-only debugger payloads. | Focused lifecycle command hook Agent Core projection regression |

## Phase 100: Lifecycle Hook Transaction Stream Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P100-1 | Preserve lifecycle hook command transactions through live stream stage and process activity surfaces. | Completed | Lifecycle hook command transaction summaries now flow through the runtime `onStage` callback, prompt stream stage events, live stream stage state, inline process activities, and completed conversation process activities. Real-time chat and persisted process replay therefore retain the same bounded command transaction metadata as runtime events, replay/debugger export, and Agent Core hook parts. | Focused lifecycle hook stage stream regression; focused stream-session lifecycle activity regression; focused completed process transcript regression |

## Phase 101: Live Tool Result Transaction Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P101-1 | Preserve prompt stream tool-result transactions in live tool state and UI data models. | Completed | Prompt stream `tool_result` transaction summaries now remain available in live `StreamToolResultState` and the `ToolExecutionEntry` result model used by streaming tool cards. Direct Agent Core part rendering also keeps the same transaction on tool result/error entries, so bounded transaction metadata is not dropped when stream events are converted into live UI state. | Focused stream-session tool transaction regression; focused UI tool-entry transaction regression |

## Phase 102: Historical Tool Transaction Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P102-1 | Preserve tool transaction summaries across historical transcript, operation log, and completed process surfaces. | Completed | Legacy `tool_result` content blocks now carry optional transaction summaries, Agent Core content-block converters round-trip them into canonical tool result/error parts, operation-log records store the same bounded transaction both directly and in input metadata for older UI consumers, completed process activities preserve tool-result transactions, and operation-log-backed completed tool summaries expose the transaction to chat UI data models. Native and Claude runtime stage relays now also forward stage transactions to the stream dispatcher. | Focused process transcript transaction regression; focused operation-log transaction regression; focused Agent Core content-block transaction regression; focused completed-message transaction UI regressions |

## Phase 103: Resume Boundary Transaction Projection

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P103-1 | Preserve completed tool transaction summaries on runtime resume boundaries and cursors. | Completed | `AgentRuntimeToolBoundary` and `AgentRuntimeResumeCursor` now carry optional transaction summaries. The stream dispatcher attaches the completed tool result transaction to the last completed boundary, persisted runtime runs hydrate resume cursors with the same transaction, replay/debugger export can reconstruct tool transaction rows from boundary-only events, and Agent Core runtime-event fallback parts expose boundary transaction metadata for audit consumers. | Focused runtime-run boundary persistence regression; focused structured event log boundary regression; focused Agent Core boundary transaction regression; focused replay debugger boundary transaction regression |

## Phase 104: Resume Prompt Transaction Handoff

| ID | Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|---|
| P104-1 | Expose completed tool transaction handoff semantics in Native and Claude resume prompts. | Completed | Native and Claude prompt builders now add a compact resume transaction summary when the resume cursor or last tool boundary has a transaction. The summary includes transaction id, tool use id, tool name/class, phase/status, event count, permission metadata, and checkpoint metadata, and instructs the model to treat completed transaction ids as host-recorded boundaries instead of repeating tools to catch up. | Focused Native resume prompt transaction regression; focused Claude SDK resume prompt transaction regression; Agent Platform v3 restart/resume benchmark coverage |

## Next Roadmap: Claude Code MCP Platform Parity

This draft section is intentionally not encoded as audited implementation rows. Convert each item into a numbered phase row only when that item enters active implementation.

### R1: MCP Connection Manager

- Status: Completed in P39-1.
- Goal: Replace ad hoc MCP probing with a project-scoped connection manager.
- Scope: Track server status, initialize once per server lifecycle, reuse sessions, debounce health probes, surface last error, reconnect manually or on demand, and avoid repeated `initialize` noise in Unity console.
- Verification: Unit tests for cache/reconnect/error states; runtime test proving repeated resource/tool reads do not reinitialize unnecessarily.

### R2: Per-Turn Tool Refresh

- Status: Completed in P39-2.
- Goal: Match Claude's behavior of refreshing MCP tools between turns so newly connected or changed servers become available without restarting the conversation.
- Scope: Refresh `tools/list` at turn boundaries, diff tool sets, keep stable names for unchanged tools, emit tool-added/tool-removed runtime events, and avoid refreshing inside tight tool-call loops unless explicitly needed.
- Verification: Runtime test where a server exposes a new tool after the first assistant turn and Native sees it on the next turn.

### R3: Full Server Capability Surface

- Status: Completed in P40-1 and P40-2.
- Goal: Move beyond tools/resources into the broader MCP capability model.
- Scope: Add `prompts/list`, `prompts/get`, `resources/templates/list`, optional `completion/complete` where available, and capability-aware UI badges in MCP settings.
- Verification: Fake MCP server tests for prompts, resource templates, and missing-capability fallbacks.

### R4: MCP Elicitation Bridge

- Status: Completed in P41-1.
- Goal: Support MCP servers that ask the host/user for input during a tool or workflow.
- Scope: Map MCP elicitation requests into existing Agent user-input UI, persist pending elicitation state, support accept/decline/cancel, and send structured responses back to the server.
- Verification: Runtime test where an MCP tool pauses for elicitation and resumes after the host supplies an answer.

### R5: Transport Expansion

- Status: Completed across P42-1, P42-2, and P42-3 for stdio, legacy HTTP JSON-RPC, Streamable HTTP, and SSE.
- Goal: Support common MCP transports beyond the current HTTP path.
- Scope: Add stdio server launch/stop/logging, environment and cwd configuration, server process lifecycle, graceful shutdown, restart, and local SSE/streamable HTTP compatibility where needed.
- Verification: Stdio echo MCP fixture, process lifecycle tests, crash/restart tests, and UI state tests.

### R6: MCP Permission Policy System

- Status: Completed in P43-1 through P43-4.
- Goal: Replace name-only MCP risk inference with explicit, inspectable policy.
- Scope: Per-server and per-tool policy overrides, default deny/ask/allow modes, read/write classification hints, persisted approvals, tool impact summaries, and project-level policy inheritance from global MCP config.
- Verification: Policy resolver tests for global/project/tool overrides; runtime tests for ask/full-access/read-only behavior.

### R7: Tool Mapping Persistence And Audit

- Status: Completed in P44-1 through P44-3.
- Goal: Make dynamic MCP tool names and schema changes auditable across sessions.
- Scope: Persist server tool snapshots, stable name mapping, schema hashes, changed-tool warnings, and transcript metadata linking `mcp__server__tool` back to server id and original MCP tool name.
- Verification: Migration tests, snapshot diff tests, and transcript replay tests after server schema changes.

### R8: Raw MCP Control Plane

- Status: Completed in P45-1 through P45-3.
- Goal: Add a controlled expert/debug surface similar to Claude SDK's MCP status and raw JSON-RPC controls.
- Scope: Server status API, reconnect/enable/disable controls, optional raw JSON-RPC send for diagnostics, redaction, timeout limits, and operation logging.
- Verification: IPC validation tests, permission tests for raw calls, and UI smoke tests.

### R9: MCP UI Maturity

- Status: Completed in P46-1.
- Goal: Make MCP configuration understandable without hiding operational truth.
- Scope: Unified server list with global/project scope, status dot, capabilities, exposed tools/resources/prompts count, last error, reconnect/test buttons, policy summary, and per-project enablement.
- Verification: Agent UI render tests and manual app smoke against Unity MCP.

### R10: Live Compatibility Matrix

- Status: Completed in P47-1 for deterministic compatibility fixtures. Additional live third-party MCP servers remain manual/key-gated expansion, not open maturity-route debt.
- Goal: Prove interoperability against realistic MCP servers rather than only local fixtures.
- Scope: Unity/Funplay MCP, a stdio filesystem-like fixture, a web/search-style MCP, and one server with elicitation/resources/templates.
- Verification: Deterministic fixtures in CI and key-gated/manual live matrix runs.

## Current Implementation Batch

This batch now has no open audited P-phase rows through P104-1. It completed the Agent maturity route, MCP platform parity route, Desktop UI route, Agent Core v2 route, Skills v2 route, Agent Platform v3 route, and the first Claude Code style lifecycle hooks route including controlled command execution, Native runtime/tool execution integration, Claude SDK `PreToolUse` permission-boundary integration, Claude SDK/CLI `PostToolUse` tool-result boundary parity, runtime-owned `SessionStart` / `PreCompact`, Native `Notification` / `SubagentStop`, Claude `UserPromptSubmit` / `Stop`, visible command-hook process activities, execution-plan Agent Core controller projection, execution-plan permission projection, pending permission interruption recovery, execution-plan cancellation cleanup, execution-plan MCP/Unity tool metadata projection, canonical tool-call lifecycle status updates, structured run-error parts, controller-owned usage parts, persisted user-input runtime events, persisted permission runtime events, canonical transcript text preference over legacy projections, bounded ToolExecutor transaction summaries across stream/runtime/replay projections, controller-owned transaction summary ingestion on canonical tool result/error parts, Execution Plan MCP/Unity operation transaction producers, Execution Plan write-permission transaction producers, lifecycle hook command transaction producers, lifecycle hook transaction replay projections, lifecycle hook transaction Agent Core projections, lifecycle hook transaction live stream/process activity projections, live tool-result transaction projections, historical transcript/operation-log transaction projections, resume-boundary transaction projections, and resume prompt transaction handoff. P4-2 is superseded by the Phase 9 UX simplification. P10-9 is completed for supplied live providers with Xiaomi MiMo Chat and Packy Responses covered; additional live providers remain key-gated.

Verification completed:

- Focused transaction projection regressions — include completed process activity transactions, operation-log transactions, Agent Core content-block transaction round-trips, and completed-message tool summary transaction preservation
- Focused resume-boundary transaction regressions — include persisted last tool boundary transactions, resume cursor transactions, Agent Core boundary system-part metadata, and replay/debugger transaction reconstruction from boundary events
- Focused resume prompt transaction regressions — include Native resume prompt transaction handoff and Claude SDK resume prompt transaction handoff
- `npm run build`
- Focused `agent-ui-render.test.ts` with `--test-name-pattern "MCP plugin modal|settings|MCP|mcp"` — includes MCP policy editing UI with persisted per-tool overrides
- Focused `agent-runtime.test.ts` with `--test-name-pattern "native MCP materializer|native MCP policy|native generic MCP|session MCP permissions|permission broker respects session-scoped MCP|permission broker respects tool-scoped session grants"` — includes stable MCP approval keys and direct/generic MCP permission reuse
- Focused `agent-ui-render.test.ts` with `--test-name-pattern "permission prompts|MCP plugin modal|settings|MCP|mcp"` — includes MCP server/tool/policy impact summaries in permission prompts
- Focused `store-migrations.test.ts` and `agent-runtime.test.ts` with `--test-name-pattern "v9 migration|MCP tool snapshots|native MCP materializer"` — includes persisted MCP tool snapshots, exposed-name mapping, schema hash stability, changed classification, and removed-tool marking
- Focused `agent-runtime.test.ts` and `agent-ui-render.test.ts` with `--test-name-pattern "native MCP materializer|streaming transcript shows unified thinking|permission prompts"` — includes MCP exposed-name and policy summary propagation into tool results and UI
- Focused `agent-ui-render.test.ts` with `--test-name-pattern "MCP tool snapshot card|MCP plugin modal|settings|MCP|mcp"` — includes changed/removed MCP mapping warnings in settings UI
- Focused `agent-runtime.test.ts` with `--test-name-pattern "raw MCP control|native MCP materializer"` — includes guarded raw MCP diagnostics and rejection of side-effecting raw tool calls
- Focused `agent-ui-render.test.ts` with `--test-name-pattern "MCP raw diagnostics|MCP tool snapshot card|settings|MCP|mcp"` — includes Raw Diagnostics settings UI with safe method picker
- Focused `store-migrations.test.ts` and `agent-runtime.test.ts` with `--test-name-pattern "v10 migration|MCP raw audit|raw MCP control"` — includes raw MCP diagnostic audit persistence and success/failure operation records
- Focused `agent-ui-render.test.ts` with `--test-name-pattern "MCP raw diagnostics|MCP raw audit|MCP tool snapshot card|settings|MCP|mcp"` — includes Raw Operation Audit rendering beside guarded diagnostics
- Focused `agent-ui-render.test.ts` with `--test-name-pattern "MCP server list row|MCP raw diagnostics|MCP raw audit|MCP tool snapshot"` — includes MCP server list connection status, capability count, error, and policy summary rendering
- `npm run agent:mcp-compatibility` — includes Unity/Funplay HTTP MCP, connection reuse/reconnect, stdio lifecycle and crash visibility, Streamable HTTP, SSE, prompts/resources/templates/completion, elicitation, and web-search-style MCP tool compatibility
- Focused `agent-core-v2.test.ts` — includes Agent Core v2 state transitions, terminal-state checks, stop-with-tool-call continuation, permission/user-input pauses, final-stop completion, structured part coverage, and protocol-neutral provider step typing
- Focused `agent-core-v2.test.ts` — includes Agent Core v2 mappings from chat content blocks, stream events, and persisted runtime events into ordered platform parts
- Focused `agent-core-v2.test.ts` — includes Agent Core v2 state-machine transition history, invalid transition blocking, and loop-decision application
- Focused `agent-runtime.test.ts` — includes OpenAI-compatible Native tool loop Agent Core v2 state snapshots, tool execution transition history, and `stage:native_agent_core_v2` observability
- Focused `agent-runtime.test.ts` — includes Claude SDK/CLI Agent Core v2 state snapshots and tool execution transition history
- Focused `agent-provider-step-adapter.test.ts` — includes OpenAI-compatible, AI SDK, and Claude provider-step normalization into `AgentCoreProviderStepResult`
- Focused `native-tool-executor.test.ts` — includes Native tool transaction event ordering, precomputed error recording, and unknown-tool handling
- Focused `agent-core-replay.test.ts` — includes Agent Core replay into OpenAI-compatible tool messages and AI SDK `ModelMessage` sequences
- Focused `stream-manager-persistence.test.ts` — includes persisted Agent Core state snapshots and resume context with stable completed-tool cursors
- Focused `agent-core-v2.test.ts` — includes persisted core-state event conversion into ordered Agent Core parts
- Focused `stream-manager-persistence.test.ts` — includes persisted context-summary events from compression stages with coverage/audit metadata
- Focused `agent-core-v2.test.ts` — includes persisted context-summary event conversion into ordered Agent Core parts
- Focused `stream-manager-persistence.test.ts` — includes persisted first-class todo-update events from `update_todo_list`
- Focused `agent-core-v2.test.ts` — includes persisted todo-update event conversion into ordered Agent Core parts
- Focused permission regressions — include persisted permission request/resolution runtime events and Agent Core permission event conversion into ordered parts
- Focused transaction regressions — include bounded ToolExecutor transaction summaries in Native tool results, runtime events, Agent Core parts, live stream mirrors, and replay debugger tool transactions
- Focused controller transaction regressions — include `AgentRunController` preserving transaction summaries on canonical tool result/error parts and Native ToolExecutor passing summaries through controller hooks
- Focused execute-plan transaction regressions — include MCP/Unity operation transaction summaries in stream events, persisted runtime events, Agent Core parts, and controller snapshots
- Focused execute-plan permission transaction regressions — include synthetic Unity write permission transactions with approval/denial decisions and external checkpoint policy metadata
- Focused lifecycle command hook transaction regressions — include denied and approved command hook paths with bounded ToolExecutor transaction summaries, replay/debugger projection, Agent Core hook part projection, and live stream/process activity projection
- Focused live tool transaction regressions — include prompt stream tool-result transaction preservation in stream state and streaming tool card data models
- Focused `agent-ui-render.test.ts` — includes completed transcript rendering from ordered Agent Core parts
- Focused `agent-run-artifacts.test.ts` — includes Agent Core debugger payload in replay exports
- `npm run agent:core-v2-benchmark` — covers Agent Core v2 state, replay, persistence, debugger export, and transcript rendering slices
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "mcp|unity mcp" tests/runtime/unity-onboarding.test.ts` — includes MCP prompt, resource-template, completion, and missing-capability fallback coverage
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "mcp|unity mcp" tests/runtime/unity-onboarding.test.ts` — includes MCP elicitation bridging through host user input and tool-result resume
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "mcp|unity mcp" tests/runtime/unity-onboarding.test.ts` — includes stdio MCP initialize, tools/list, tools/call, resources/list, resources/read, connection snapshot, and process cleanup coverage
- `npm run agent:roadmap-audit` — verifies no open maturity roadmap or implementation plan rows remain in the completed route
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts` — includes structured runtime activity rendering, permission impact rendering, structured tool metadata, Project Settings Usage token focus, and dedicated Agent Runs recovery/verification UI
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/stream-session-manager.test.ts` — includes per-stream permission impact state
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/stream-session-manager.test.ts tests/runtime/agent-ui-render.test.ts tests/runtime/agent-runtime.test.ts` — includes inline Agent work transcript ordering, completed process replay, per-tool activity boundaries at the same text offset, and persisted process transcript metadata
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "native memory tools|project memory service" tests/runtime/agent-runtime.test.ts` — includes classified memory writes, memory-kind search filtering, and Memory settings summaries
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "workspace context includes runtime environment|workspace context builds a structured project context index|workspace context discovers project-level agent instructions" tests/runtime/agent-runtime.test.ts` — includes structured project context indexing for scripts, dependencies, validation commands, entrypoints, and config files
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "/compact updates Claude|/compact updates native|Claude Code runtime compacts long resume context|native context handoff uses storage rowid boundary|native context handoff falls back" tests/runtime/agent-runtime.test.ts` — includes auditable context compression metadata for decisions, constraints, and unfinished tasks
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-artifacts.test.ts` — includes persisted task graph success criteria, checkpoint rollback metadata, and controlled read-only subagent orchestration records
- `node --check scripts/runtime-maturity-gate.mjs`
- `npm run test:runtime` — 205 passed, 3 skipped, 0 failed
- Agent-only deterministic runtime suite excluding UI render tests — 195 passed, 5 skipped, 0 failed
- `npm run agent:e2e`
- Xiaomi MiMo live OpenAI-compatible Chat suite with `FUNPLAY_E2E_OPENAI_COMPAT_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1`, `FUNPLAY_E2E_OPENAI_COMPAT_MODEL=mimo-v2.5-pro`, and a redacted API key — 18 passed, 0 failed in 370.9s, including real `ask_user`, `update_todo_list`, `scan_file_tree`, `read_file`, `read_document`, `find_files`, `search_project_content`, `summarize_directory`, `preview_file_diff`, `preview_patch`, `create_directory`, `write_file`, `edit_file`, `multi_edit`, `patch_file`, `checkpoint_diff`, `checkpoint_rollback`, `funplay_memory_*`, `run_subagent`, `web_fetch`, `media_attach_file`, `media_save_base64`, `funplay_notify`, `funplay_schedule_task`, `funplay_list_tasks`, `funplay_cancel_task`, `run_command`, `terminal_start`, `terminal_read`, `terminal_stop`, Plan-mode write withholding, Plan-mode approved command execution, blocked path traversal recovery, persistent terminal lifecycle, complex backend generation, and a test-driven backend repair loop
- Xiaomi MiMo focused web research plan smoke with a redacted API key — passed in 29.9s, including public `web_search`, two `web_fetch` source reads, `write_file`, and `read_file`
- Xiaomi MiMo focused weak natural-language smokes with a redacted API key — 2 passed, 0 failed in 227.0s, covering resource directory setup plus a natural failing-test repair loop with external `npm test`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-ui-render.test.ts` — includes structured tool metadata rendering and Project Usage verification/tool quality summaries
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "native tool loop aborts after a completed tool boundary" tests/runtime/agent-runtime.test.ts`
- `npm run agent:browser-smoke`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "structured event log|runtime run persistence stores timeline|active runtime runs persist accumulated usage|v3 migration" tests/runtime/stream-manager-persistence.test.ts tests/runtime/store-migrations.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-artifacts.test.ts` — includes task-level browser verification report aggregation
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "write tool|edit tools|multi_edit|patch tools" tests/runtime/workspace-tools.test.ts` — includes structured edit metrics
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-artifacts.test.ts` — includes replay token/tool retry metrics
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "persistent terminal" tests/runtime/workspace-tools.test.ts` — includes terminal service/port/log metadata
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "MCP workspace tools|serializes unsafe MCP" tests/runtime/agent-runtime.test.ts` — includes MCP metadata and oversized-args guardrail
- `npm run agent:benchmark` — 13/13 reported passed, covering stateful core, replay artifacts, provider conformance, tool reliability, MCP compatibility, structured UI render, Agent Core v2, Skills v2, Agent Platform v3, Claude Code style lifecycle hooks with controlled command execution, Native `SessionStart`, Native/Claude `PreCompact`, Native `Notification` / `SubagentStop`, Claude `UserPromptSubmit` / `Stop`, Claude SDK `PreToolUse`, and Claude SDK/CLI `PostToolUse` boundary coverage, roadmap audit, dry E2E, and Electron ABI restoration
- Focused lifecycle hook tests — includes project settings loading, ordered hook runner outcomes, controlled command hook execution, and Native `PreToolUse` blocking before workspace side effects
- Focused process transcript and stream-session tests — includes inline command lifecycle hook activity in live stream state and completed conversation metadata
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "duplicate tool call ids|coalesce bounded text|structured event log" tests/runtime/agent-runtime.test.ts tests/runtime/stream-manager-persistence.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "split across network chunks|malformed tool arguments|unsupported Responses mode|empty response" tests/runtime/openai-compatible-client.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "malformed tool arguments|duplicate tool call ids" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/provider-conformance.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "workspace write tool|workspace find, read range|workspace run_command|workspace persistent terminal" tests/runtime/workspace-tools.test.ts`
- `npm run dev` launch smoke — Electron opened the workspace and displayed Build/provider composer controls plus the project file tree; dev process was stopped after verification
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "openai-compatible native tool loop executes direct function tools|native plan mode enters tool-loop|native conversation content blocks preserve tool input" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "native tool loop permission copy" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "openai-compatible chat tool loop replays completed historical tools|openai-compatible responses tool loop replays completed historical tools|model message builder reconstructs assistant tool calls" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/tool-policy.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "workspace write tool writes inside project and blocks traversal|native create directory tool is permission-gated in ask mode" tests/runtime/workspace-tools.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "native build mode exposes write tools before intent heuristic matches|native tool adapter exposes write tools only behind explicit option|native tool loop permission copy" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "native tool-loop strategy reports explicit fallback reasons|new project sessions default to agent mode and inherit project permission|native build mode exposes write tools before intent heuristic matches" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/claude-sdk-options.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "project file listing includes empty directories" tests/runtime/project-file-preview.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "tool registry includes write and MCP metadata boundaries|conversation stream dispatches usage events and persists run totals" tests/runtime/agent-runtime.test.ts tests/runtime/stream-manager-persistence.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "direct reply uses streaming|chat text generation streams|Xiaomi MiMo tool-loop map error|Xiaomi MiMo tool schemas" tests/runtime/agent-runtime.test.ts tests/runtime/openai-compatible-client.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/openai-compatible-client.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/openai-compatible-client.test.ts tests/runtime/provider-catalog.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "fetch resets|diagnostics classify" tests/runtime/openai-compatible-client.test.ts tests/runtime/claude-cli-config.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "textual tool markers|direct function tools" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "continues unfinished multi-file write replies|textual tool markers|direct function tools" tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "textual tool markers|normalizes textual tool markers|direct function tools" tests/runtime/openai-compatible-client.test.ts tests/runtime/agent-runtime.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "default agent settings|migrates legacy agent defaults|migrates ask-first|native tool loop permission copy|native build mode exposes write tools|native plan mode exposes command tools|MiMo tool-loop map error|native command tool is high-risk|Xiaomi MiMo tool schemas" tests/runtime/provider-runtime.test.ts tests/runtime/store-migrations.test.ts tests/runtime/agent-runtime.test.ts tests/runtime/workspace-tools.test.ts tests/runtime/openai-compatible-client.test.ts`
- `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test --test-name-pattern "Xiaomi MiMo tool-loop map error|update_todo_list|empty final|inspection tools|multi-file write|incomplete todo" tests/runtime/agent-runtime.test.ts`
- `npm run test:runtime`
- `npm run build`
- `git diff --check -- electron/main/agent-platform/native/tool-loop.ts tests/runtime/agent-runtime.test.ts`

The latest prompt-copy, protocol-level historical tool replay, history-marker cleanup, Build/Plan permission collapse, legacy session-mode collapse, empty-directory file tree, deterministic tool registry, OpenAI-compatible streaming usage, Xiaomi MiMo tool schema normalization, OpenAI-compatible direct-reply streaming, OpenAI-compatible non-streaming JSON fallback removal, OpenAI-compatible provider transform layer, aggregator upstream model transform inference, transient OpenAI-compatible network retry, textual tool-marker repair, no-tool direct-reply retry removal, weak todo argument normalization, empty-final todo continuation, empty no-tool stop completion, inspection-only write-promise continuation, opencode-style task-list compatibility, edit-tool failure recovery, and non-retryable MiMo `map` error handling were verified with `npm run build` and `npm run test:runtime`. `npm run test:runtime` restored the Electron native ABI through `npm run rebuild:native:force`.
