# Agent Platform v3 Roadmap

Last updated: 2026-05-16

## Maturity Target

Agent Platform v3 moves Funplay toward a Claude Code style host-driven agent platform. The target is not a stronger prompt. The target is a stable runtime contract:

- The host owns the run loop, tool execution, permission checks, recovery, compression, and audit trail.
- Providers return protocol-neutral steps: assistant text, thinking, tool calls, finish reason, usage, and warnings.
- Tool calls continue the loop. Only a no-tool stop with final user-visible text can complete the run.
- Tool execution is transactional: validation, permission, timeout, checkpoint, execution, summary, failure classification, and replay are one host-owned path.
- UI, persistence, resume, replay, and benchmarks consume structured parts and events rather than assistant pseudo text.

## Current Gap Audit

| Area | Current State | Gap |
|---|---|---|
| Agent main loop | Native OpenAI-compatible, AI SDK, Claude SDK/CLI, and execution-plan paths now project their observable run state through `AgentRunController` or Agent Core snapshots. | Remaining work is convergence polish: reduce runtime-specific compatibility projections without changing the stable controller contract. |
| Message structure | Agent Core parts exist and completed/streaming UI can render ordered parts. Some legacy content block and operation-log paths remain. | Make parts the canonical transcript artifact and treat legacy blocks as compatibility projection. |
| Tool executor | Native workspace tools and Execution Plan MCP/Unity operations now project bounded transaction summaries through stream, runtime event, replay, and Agent Core surfaces. Browser, terminal, command, and provider-specific paths still have some separate lifecycle glue. | Lift transaction semantics into a platform executor shared by all tool classes. |
| Permissions | Build/Plan and MCP policies are host-side, and prompts no longer decide authority. Some permission copy is still surfaced through runtime-specific stages. | Make permission requests first-class controller pauses with stable part/event identity. |
| Recovery | Stable tool-boundary resume and duplicate tool protection exist for Native loops. Pending/running tool finalization is not yet the single controller responsibility. | Controller should finalize dangling work as structured error parts and resume from stable cursors. |
| Context compression | Native/Claude context handoffs are auditable and structured enough for current compression. | Move compression trigger/result into the controller lifecycle and keep summaries as structured parts. |
| Observable UI | Chat can interleave assistant text and tool activity. | Make the interleaving source exclusively controller parts, with grouped tool batches and replay parity. |

## Phase C1: Unified Agent Run Controller

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C1-1 | Completed | Added the v3 roadmap and the first pure `AgentRunController` contract skeleton. It records provider steps as ordered Agent Core parts, maps Agent Core loop decisions to platform actions, keeps pending/completed tool ids, and returns to `building_model_input` after tool result recording. Runtime integration is intentionally not switched over yet. | `node --experimental-strip-types --import ./tests/register-ts-loader.mjs --test tests/runtime/agent-run-controller.test.ts`; `npm run build` |
| C1-2 | Completed | Native OpenAI-compatible loop now records provider steps and host tool results through `AgentRunController`, exposes controller snapshots in `stage:native_agent_core_v2`, and delegates the safe core loop actions to `runController.nextAction`: execute tools, continue after length, complete only on no-tool stop with visible final text, and fail empty or non-terminal no-tool provider steps. Host-forced continuations for incomplete todos and partial writes stay before default completion. | `tests/runtime/agent-run-controller.test.ts`; focused Native OpenAI-compatible tool-loop tests; `npm run build`; `npm run test:runtime` |
| C1-3 | Completed | AI SDK-backed Native loop now projects provider steps and buffered tool results into `AgentRunController`, exposes controller snapshots in `stage:native_ai_sdk_agent_core_v2`, and gates final no-tool completion, failure, and length continuation through `runController.nextAction`. AI SDK tool results are buffered until `finish-step` so controller replay preserves tool-call/result pairing. | `npm run build`; `npm run test:runtime` |
| C1-4 | Completed | Claude Code runtime now projects assistant tool-use events, user tool-result events, and final result events into `AgentRunController` without taking over Claude SDK internals. `stage:claude_agent_core_v2` exposes the controller snapshot alongside the existing core state, including provider step count, completed tool ids, and final loop decision. | Focused Claude runtime test; `npm run build`; `npm run test:runtime` |

## Phase C2: Canonical Message Parts

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C2-1 | Completed | New assistant messages now get canonical `metadata.agentCoreParts` at the persistence boundary. `appendProjectConversationTurn` and `appendProjectAssistantMessage` preserve runtime-supplied parts when present, otherwise derive ordered Agent Core parts from assistant content blocks or final visible text. | Focused transcript persistence test; `npm run build`; `npm run test:runtime` |
| C2-2 | Completed | Added `agentCorePartsToChatContentBlocks` and wired the conversation persistence boundary to project legacy `contentBlocks` from canonical parts whenever callers do not provide blocks explicitly. Existing callers that still provide blocks keep their output, while parts-backed messages now remain compatible with older render/context paths. | Agent Core projection test; transcript persistence projection test; `npm run build`; `npm run test:runtime` |
| C2-3 | Completed | Completed/streaming display paths now suppress assistant pseudo-tool fallback text such as `[Tool] ...` and `[Previous tool call] ...` when structured parts or tool blocks are available, and raw pseudo-tool-only assistant content is no longer rendered or searchable as final text. Copy/search plain text now prefers canonical Agent Core parts for assistant messages. Provider repair/replay paths remain structured compatibility logic rather than UI fallback text. | UI pseudo-tool regression tests; `npm run build`; `npm run test:runtime` |

## Phase C3: Transactional Tool Executor

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C3-1 | Completed | Added a platform `ToolExecutor` transaction envelope covering workspace, command, terminal, browser, MCP, media, memory, user-input, subagent, checkpoint, and custom tools. Transactions now have host-owned status/phase, permission/checkpoint/timeout metadata, lifecycle events, structured result/error payloads, summaries, cancellation handling, and Agent Core part projection. Runtime migration remains scoped to C3-2/C3-3. | `tests/runtime/tool-executor.test.ts`; `npm run build`; `npm run test:runtime` |
| C3-2 | Completed | Native workspace tool execution now wraps every tool result in the platform `ToolExecutorTransaction` envelope while preserving the existing ordered callbacks. The adapter records lifecycle events, structured success/failure, tool-class classification, and exposes the transaction alongside the legacy `{ summary, toolResult }` return for incremental migration. | Native tool executor tests; `npm run build`; `npm run test:runtime` |
| C3-3 | Completed | Added platform result normalization so MCP, browser, terminal, command, media, memory, and workspace outputs preserve their typed metadata inside the same `ToolExecutorTransactionResult` schema. Native executor now uses the shared normalizer and classifies command/browser/MCP/terminal tool transactions for downstream audit/replay. | Tool executor metadata normalization tests; Native tool executor classification tests; `npm run build`; `npm run test:runtime` |

## Phase C4: Host Permission Model

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C4-1 | Completed | `AgentRunController` can now record permission waits as structured `permission_request` parts and transition to `awaiting_permission` with `nextAction=request_permission`. Tool calls remain pending until host permission resolves, so UI/replay can consume a stable part instead of runtime-specific status text. Full runtime permission execution migration is left to C4-2/C4-3. | Agent Run Controller permission pause test; `npm run build`; `npm run test:runtime` |
| C4-2 | Completed | Added a controller path that turns denied host permission into a structured `tool_error` part with `failureKind=permission_denied`, clears the pending tool id, and returns to `building_model_input` so the provider can continue from a valid tool-output boundary instead of receiving prompt-level permission prose. Runtime callers can adopt this path incrementally. | Agent Run Controller permission denial recovery test; `npm run build`; `npm run test:runtime` |
| C4-3 | Completed | Native tool-loop prompts and high-risk tool descriptions no longer ask the model to self-enforce write/command permission. They describe the visible Build/Plan mode and available tools, while stating that host-side permission, checkpoint, denial, and error replay happen at the tool execution point. Existing “do not fake writes when no write tool is available” guidance remains tied to tool availability, not model-owned authority. | Native permission prompt regression test; prompt hint scan; `npm run build`; `npm run test:runtime` |

## Phase C5: Resume And Recovery

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C5-1 | Completed | `AgentRunController.interruptResumable()` now finalizes every pending tool id as a structured `tool_error` part with `failureKind=interrupted`, clears pending ids, marks them completed for replay safety, and moves to `interrupted_resumable` when the current state permits. This prevents dangling tool calls after app restarts or stream interruptions. | Agent Run Controller interruption finalization test; `npm run build`; `npm run test:runtime` |
| C5-2 | Completed | `AgentRunController.recordToolResult()` now treats already-completed, non-pending tool ids as exactly-once replay boundaries and does not append duplicate `tool_result`/`tool_error` parts. This gives resumed runs a shared duplicate side-effect guard independent of tool class, with Native executor transactions carrying the tool-class metadata. | Agent Run Controller duplicate tool-result test; Native transaction class tests; `npm run build`; `npm run test:runtime` |
| C5-3 | Completed | Added `buildAgentCoreReplaySnapshot()` to derive pending/completed tool ids, a stable `resume_after_last_completed_tool` cursor, stable replay parts up to that boundary, and provider-ready OpenAI-compatible / AI SDK replay messages from canonical Agent Core parts. Dangling pending tool calls are excluded from replay unless they have been finalized as tool errors. | Agent Core replay cursor test; `npm run build`; `npm run test:runtime` |

## Phase C6: Structured Context Compression

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C6-1 | Completed | `AgentRunController.requestContextCompression()` now moves the run from provider-input build into `compacting_context` with `nextAction=compact_context`, making compression a host lifecycle decision instead of ad hoc runtime behavior. | Agent Run Controller compression trigger test; `npm run build`; `npm run test:runtime` |
| C6-2 | Completed | `context_summary` parts now support structured payloads for goal, completed work, unfinished work, changed files, decisions, constraints, failed tools, and next step. `AgentRunController.recordContextSummary()` persists that structured summary as a canonical part and returns to provider input build. | Agent Run Controller structured summary test; `npm run build`; `npm run test:runtime` |
| C6-3 | Completed | Agent Core replay now formats structured context summaries into provider user-context messages while preserving adjacent assistant tool-call/tool-result pairing. Replay snapshots continue to trim dangling pending tools at the stable cursor. | Agent Core structured summary replay test; `npm run build`; `npm run test:runtime` |

## Phase C7: Observable Chat UI

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C7-1 | Completed | Live stream state now mirrors assistant text, thinking, tool calls, and tool results into ordered Agent Core parts. `StreamingTranscriptMessage` prefers those parts when present, while completed messages already prefer persisted `metadata.agentCoreParts`. Legacy timeline props remain as compatibility fallback during event-source migration. | Stream manager Agent Core mirror test; streaming Agent Core render test; `npm run build`; `npm run test:runtime` |
| C7-2 | Completed | Streaming and completed render paths group adjacent/same-boundary tool calls into `ToolActivityGroup` batches, with active live groups expanded and completed/historical groups collapsible. Agent Core part rendering reuses the same grouping surface. | Streaming same-boundary grouping test; long-task UI render test; `npm run build`; `npm run test:runtime` |
| C7-3 | Completed | Live streaming and persisted replay now share the Agent Core part renderer when parts are available, so a restarted conversation can show the same assistant-text/tool sequence from `metadata.agentCoreParts` that the live stream showed from mirrored stream parts. | Completed Agent Core replay render test; streaming Agent Core render test; `npm run build`; `npm run test:runtime` |

## Phase C8: Replay Debugger

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C8-1 | Completed | Replay exports now include an expanded Agent Core debugger model with controller transitions, ordered parts, provider step summaries, tool transaction summaries, permission decision markers, compression points, and the resume cursor. This is the platform/debugger data contract the UI can render without re-parsing raw logs. | Replay debugger export test; `npm run build`; `npm run test:runtime` |
| C8-2 | Completed | Added `buildRedactedAgentReplayLog()` for exportable replay bundles that recursively redact provider/API tokens from run metadata and events while preserving debugger, recovery, timeline, and metrics structure. | Redacted replay export test; `npm run build`; `npm run test:runtime` |

## Phase C9: Benchmark Gate

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C9-1 | Completed | Added `scripts/agent-platform-v3-benchmark.mjs` and the `agent:platform-v3-benchmark` npm script. The benchmark is dry/offline and covers long tasks, failed edits, permission denial, restart resume, context compression, MCP compatibility, observable UI rendering, and replay debugger export, writing JSON/Markdown reports under `out/agent-platform-v3-benchmark/`. | `npm run agent:platform-v3-benchmark` |
| C9-2 | Completed | Folded the v3 benchmark into the manual runtime maturity gate. It was first added as a required standalone gate; after C11 it is covered through the required deterministic `agent:benchmark` slice to avoid duplicate execution. | `npm run runtime:maturity-gate` |

## Phase C10: Route Closure Audit

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C10-1 | Completed | Expanded `agent-roadmap-audit` into a multi-route audit covering the agent maturity roadmap, architecture plan, Agent Core v2 roadmap, Skills v2 roadmap, Agent Platform v3 roadmap, and Desktop UI improvement plan. The audit now checks each route's native row shape and status column, so completed specialty roadmaps cannot drift back to open work without failing the deterministic benchmark. | `npm run agent:roadmap-audit`; `npm run agent:benchmark` |

## Phase C11: Benchmark Convergence

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C11-1 | Completed | Added Agent Platform v3 as a first-class slice inside `scripts/agent-benchmark.mjs`, using `FUNPLAY_SKIP_NATIVE_ABI_WRAP=1 npm run agent:platform-v3-benchmark` so the parent benchmark owns the native ABI setup/restore. `runtime:maturity-gate` now relies on the required `agent:benchmark` tier for v3 coverage instead of running the same v3 slice twice. | `npm run agent:benchmark`; `npm run runtime:maturity-gate` |

## Phase C12: Claude Lifecycle Boundary Parity

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C12-1 | Completed | Claude SDK/CLI stream handling now treats `tool_result` blocks as a host-observable lifecycle boundary. `PostToolUse` hooks run once per `toolUseId` with the Claude tool name and bounded result metadata, and queued CLI hook work is drained before the runtime marks the stream complete. | Focused fake Claude CLI regression; `npm run build`; `npm run agent:benchmark` |

## Phase C13: Session And Compaction Lifecycle Boundaries

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C13-1 | Completed | Native and Claude runtimes now run `SessionStart` before provider input construction and `PreCompact` before applying context handoff patches. Hook context is injected into the same structured prompt channel used by prior hook events, while blocking hooks stop the turn or skip the compression attempt at the host boundary. | Focused Native `SessionStart` and Claude `PreCompact` regressions; `npm run agent:benchmark` |

## Phase C14: Notification And Subagent Lifecycle Boundaries

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C14-1 | Completed | Native notification tools now emit `Notification` hooks after the host observes the real notification/task outcome, and delegated subagent tools emit `SubagentStop` hooks after completion or failure. Detached background subagents also emit `SubagentStop` when their stored task record reaches a terminal state. These hooks carry bounded tool input/result metadata and still route command hook actions through the permission-gated host command path. | Focused Native `Notification` and `SubagentStop` lifecycle regressions; `npm run agent:benchmark` |

## Phase C15: Claude Prompt And Stop Lifecycle Boundaries

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C15-1 | Completed | Claude runtime now runs `UserPromptSubmit` hooks after `SessionStart` and before CLI/SDK provider input is built, so appended hook context enters the same prompt channel as Native. Claude runtime also runs `Stop` hooks after a successful final text result and before the turn is returned, giving host hooks a stable completion boundary across both Native and Claude runtimes. | Focused fake Claude CLI `UserPromptSubmit`/`Stop` regression; `npm run agent:benchmark` |

## Phase C16: Lifecycle Hook Process Visibility

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C16-1 | Completed | Command-style lifecycle hooks and blocking/error hook outcomes now enter the same inline process activity trail used for tools, context compression, and tool timeouts. Routine audit/context hooks remain stored as runtime hook events without adding transcript noise, while command hooks that actually run host work stay visible in both live stream state and completed conversation metadata. | Focused process transcript and stream-session regressions; `npm run test:runtime` |

## Phase C17: Execution Plan Controller Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C17-1 | Completed | Execution-plan runs now wrap MCP/Unity plan operations and the final replan reply in `AgentRunController`. The runtime emits `stage:execute_plan_agent_core_v2` snapshots for persisted Agent Core state events, and completed assistant messages persist controller-ordered `metadata.agentCoreParts` so plan tool calls/results replay before the final assistant text instead of falling back to legacy operation-log ordering. | Focused execute-plan MCP stream regression; `npm run agent:platform-v3-benchmark` |

## Phase C18: Execution Plan Permission Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C18-1 | Completed | Execution-plan Unity write permission checks now become controller-owned `tool_call -> permission_request -> tool_result/tool_error` parts. Approved writes clear the synthetic permission boundary before real Unity/MCP tools execute, while Plan/read-only or denied writes produce a structured `tool_error` and continue to the final replan reply without dangling permission state. | Focused controller permission approval/denial tests; focused execute-plan denied-write stream regression; `npm run agent:platform-v3-benchmark` |

## Phase C19: Permission Wait Interruption Recovery

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C19-1 | Completed | `AgentRunController.interruptResumable()` now has explicit regression coverage for runs interrupted while paused on a permission request, finalizing the pending permission tool as an `interrupted` `tool_error`. The execution-plan abort path now uses `interruptResumable()` for AbortError instead of recording a synthetic provider error step, preventing invalid transitions from `awaiting_permission`. | Focused controller pending-permission interruption test; `npm run agent:platform-v3-benchmark` |

## Phase C20: Execution Plan Cancellation Cleanup

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C20-1 | Completed | `cancelAgentExecutionPlanStream()` now mirrors conversation cancellation by explicitly clearing pending permission requests as well as pending user input requests before removing the active stream. This prevents orphaned permission promises/audit entries when an execution-plan run is cancelled outside the normal AbortSignal path. | Focused execute-plan cancellation permission cleanup regression; `npm run agent:platform-v3-benchmark` |

## Phase C21: Execution Plan Tool Metadata Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C21-1 | Completed | `AgentRunController` now preserves structured tool result/error metadata on canonical `tool_result` and `tool_error` parts. Execution-plan MCP/Unity operations populate `mcp` metadata for read-resource and call-tool results, and the completed/streaming render path can display that metadata from both success and error parts instead of falling back to operation-log-only context. | Focused controller metadata regression; focused execute-plan MCP stream regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C22: Canonical Tool Call Lifecycle Status

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C22-1 | Completed | `AgentRunController` now updates the originating `tool_call` part status when a tool result, tool error, permission denial, or resumable interruption is recorded. Canonical transcripts now show pending parallel tool calls, completed tool calls, and failed/interrupted tool calls directly on the structured call part, matching the host-owned lifecycle model instead of requiring UI/replay to infer status only from later result parts. | Focused controller lifecycle status regressions; focused execute-plan MCP stream regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C23: Structured Run Error Parts

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C23-1 | Completed | `AgentRunController.recordProviderStep()` now emits a canonical `run_error` part when a provider/runtime step fails with an error. The controller still drives the state machine to `failed`, but replay/debug/UI now have an explicit structured error artifact instead of relying only on transition text. | Focused controller provider-error regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C24: Controller-Owned Usage Parts

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C24-1 | Completed | `AgentRunController.recordProviderStep()` now records provider token usage as canonical `usage` parts when `AgentCoreProviderStepResult.usage` is available. Usage remains a structured, non-visible transcript artifact while final assistant text still closes visible no-tool stop steps. | Focused controller usage-part regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C25: User Input Runtime Event Persistence

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C25-1 | Completed | Agent user-input waits now persist as first-class runtime events. `requestUserInput` and external `onUserInputRequest` record bounded `user_input_request` events, resolved answers record redacted/bounded `user_input_resolved` events, and Agent Core replay maps persisted requests back into `user_input_request` parts. | Focused runtime user-input persistence regression; focused Agent Core user-input event mapping regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C26: Permission Runtime Event Persistence

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C26-1 | Completed | Agent permission waits now persist as first-class runtime events. `requestPermission` and external `onPermissionRequest` record stable `permission_request` events with bounded impact metadata, and resolved decisions record `permission_resolved` events after any session permission grant is persisted but before the waiting tool proceeds. Agent Core replay maps persisted permission requests back into `permission_request` parts and resolutions into system events. | Focused runtime permission persistence regression; focused Agent Core permission event mapping regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C27: Canonical Transcript Text Preference

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C27-1 | Completed | Message text helpers now prefer canonical Agent Core parts over legacy content blocks when both are present. `getChatMessageContextText()` and `getChatMessageVisibleAssistantText()` now derive from persisted parts first, and completed-process tool summaries prefer Agent Core parts before operation-log fallbacks. This keeps archived context, restart previews, and completed-message process summaries aligned with the canonical transcript surface. | Focused context-text regression; focused completed-process summary regression; `npm run build`; `npm run agent:platform-v3-benchmark`; `npm run agent:benchmark`; `npm run test:runtime` |

## Phase C28: Tool Transaction Runtime Event Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C28-1 | Completed | ToolExecutor transactions now project a bounded `AgentToolTransactionSummary` into Native tool results, prompt stream tool-result events, persisted runtime `tool_result` events, Agent Core tool-result/error parts, live stream Agent Core mirrors, and replay debugger tool transactions. The summary carries only stable host-owned lifecycle metadata such as transaction id, tool class, phase/status, event count, timestamps, permission summary, and checkpoint summary, keeping input/output payloads out of the runtime event snapshot. | Focused transaction regressions for ToolExecutor, Native executor, and Agent Core runtime-event conversion; `npm run build` |

## Phase C29: Controller Tool Transaction Ingestion

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C29-1 | Completed | `AgentRunController.recordToolResult()` now preserves optional transaction summaries on canonical `tool_result` and `tool_error` parts. Native ToolExecutor completion passes the summary through the `onResult` hook into the Native controller path, while Execution Plan and Claude controller adapters now accept the same field for future non-Native transaction producers. This keeps the controller transcript compatible with the shared ToolExecutor lifecycle surface instead of making transaction metadata a Native-only side channel. | Focused controller transaction metadata regression; focused Native executor callback regression; `npm run build` |

## Phase C30: Execution Plan MCP Transaction Producer

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C30-1 | Completed | Execution Plan MCP/Unity operations now create ToolExecutor transactions at the operation boundary, advance into execution, complete as success or structured failure, and emit bounded transaction summaries with `onToolResult`. Resource reads and tool calls therefore carry the same `mcp` transaction class, terminal phase/status, event count, and timing metadata through stream events, persisted runtime events, Agent Core parts, and controller snapshots. | Focused execute-plan stream transaction regression; focused ToolExecutor transaction regression; `npm run build` |

## Phase C31: Execution Plan Permission Transaction Producer

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C31-1 | Completed | Execution Plan Unity write permission checks now create ToolExecutor transactions for the synthetic `execute_plan_unity_write` boundary. The transaction records the `ask` permission policy, request id, approval/denial decision, external checkpoint policy, and terminal result before the controller records the permission approval or denial as a canonical tool result/error part. | Focused execute-plan permission transaction regression; `npm run build` |

## Phase C32: Lifecycle Hook Command Transaction Producer

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C32-1 | Completed | Command-style lifecycle hooks now create ToolExecutor transactions around the host `run_command` boundary. The transaction records the `ask` permission request, approval or denial decision, command execution start, terminal result, timeout metadata, and external checkpoint policy before the hook result is persisted, so lifecycle hook command work can be audited through the same bounded transaction surface as Native and Execution Plan tools. | Focused lifecycle command hook transaction regression |

## Phase C33: Lifecycle Hook Transaction Replay Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C33-1 | Completed | Replay/debugger export now projects lifecycle hook command transaction summaries into both hook events and the unified tool transaction list. A denied or approved command hook can therefore be inspected from the hook timeline and from the tool transaction audit surface without parsing raw runtime event payloads. | Focused lifecycle command hook replay regression |

## Phase C34: Lifecycle Hook Transaction Agent Core Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C34-1 | Completed | Agent Core runtime-event conversion now preserves lifecycle hook command transaction summaries on the hook `system_event` metadata. Canonical parts consumers can inspect hook command permission/execution status without falling back to replay-only debugger payloads or raw hook event bodies. | Focused lifecycle command hook Agent Core projection regression |

## Phase C35: Lifecycle Hook Transaction Stream Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C35-1 | Completed | Lifecycle hook command transaction summaries now flow through the live `onStage` stream path, stream stage state, inline process activities, and completed conversation process activities. Real-time and persisted chat process views retain the same bounded command transaction metadata as runtime events, replay/debugger export, and Agent Core parts. | Focused lifecycle hook stage stream regression; focused stream-session lifecycle activity regression; focused completed process transcript regression |

## Phase C36: Live Tool Result Transaction Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C36-1 | Completed | Prompt stream `tool_result` transaction summaries now remain available in live `StreamToolResultState` and the `ToolExecutionEntry` data model used by live tool cards. Agent Core part rendering also preserves the same transaction on tool result/error entries, so live UI data no longer drops bounded transaction metadata after the stream event is processed. | Focused stream-session tool transaction regression; focused UI tool-entry transaction regression |

## Phase C37: Historical Tool Transaction Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C37-1 | Completed | Tool transaction summaries now survive the historical transcript path as well as the live stream path. Legacy `tool_result` content blocks, Agent Core content-block converters, operation-log records, completed process activities, and operation-log-backed tool summaries all carry the same bounded transaction metadata. Native and Claude runtime stage forwarding also preserves transaction summaries when relaying stage events to the stream dispatcher. | Focused process transcript transaction regression; focused operation-log transaction regression; focused Agent Core content-block transaction regression; focused completed-message transaction UI regressions |

## Phase C38: Resume Boundary Transaction Projection

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C38-1 | Completed | Runtime tool-boundary records and resume cursors now preserve bounded transaction summaries from the completed tool result. Restart/resume diagnostics can therefore inspect the exact tool transaction attached to the last completed boundary, including event counts and checkpoint metadata, without relying on a separate tool-result event still being nearby in the log. Replay/debugger export and Agent Core fallback system parts also project boundary transactions. | Focused runtime-run boundary persistence regression; focused structured event log boundary regression; focused Agent Core boundary transaction regression; focused replay debugger boundary transaction regression |

## Phase C39: Resume Prompt Transaction Handoff

| Requirement | Status | Implementation Notes | Verification |
|---|---|---|---|
| C39-1 | Completed | Native and Claude resume prompts now render a compact tool transaction handoff beside the raw resume context JSON. The handoff names the transaction id, tool use id, tool name/class, phase/status, event count, permission summary, and checkpoint summary, and explicitly tells the model not to rerun a host-recorded completed transaction just to catch up. This makes resume semantics visible to the model without expanding tool inputs or outputs. | Focused Native resume prompt transaction regression; focused Claude SDK resume prompt transaction regression; Agent Platform v3 restart/resume benchmark coverage |
