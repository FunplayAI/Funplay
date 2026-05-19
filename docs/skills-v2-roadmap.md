# Skills v2 Platform Roadmap

Last updated: 2026-05-16

## Maturity Target

Funplay Skills v2 should behave like a platform capability, not a large prompt fragment. The target is Claude Code style skill handling:

- Skill packages live as directories with `SKILL.md` as the entry point.
- Metadata is indexed first; full instructions and supporting files load only when relevant.
- Project, user, plugin, catalog, and custom skills have explicit source precedence and provenance.
- Users can invoke a skill explicitly, and the model can select a skill automatically when metadata matches.
- Skill use is observable in the Agent event stream and replayable from run artifacts.
- Skills can declare suggested tools, dependencies, examples, inputs, outputs, and invocation policy.
- Script or tool side effects are governed by the same permission broker as normal Agent tools.
- Claude SDK runtime can delegate to native Claude skill mechanisms where available, while Native runtime uses Funplay's own registry and tools.

## Implementation Route

| ID | Scope | Status |
|---|---|---|
| SK61-1 | Define Skills v2 platform maturity standard and route. | Completed |
| SK61-2 | Add filesystem Skill package discovery and metadata registry. | Completed |
| SK62-1 | Add read-only Native tools for listing and loading selected Skills. | Completed |
| SK63-1 | Replace eager prompt injection with automatic metadata-based activation. | Completed |
| SK64-1 | Add explicit `/skill-name` invocation and session-visible activation state. | Completed |
| SK65-1 | Add supporting-file lazy loading with size limits and provenance. | Completed |
| SK66-1 | Add Skill trust, source verification, permission policy, and script execution boundaries. | Completed |
| SK67-1 | Integrate Claude SDK native Skills support where available. | Completed |
| SK68-1 | Add Skill activation/runtime events, replay export, and UI visibility. | Completed |
| SK69-1 | Add deterministic and live Skill benchmark gates. | Completed |
| SK70-1 | Mature the Settings UI for source precedence, conflicts, updates, and project overrides. | Completed |

## Phase 61 Verification

- Added `AgentSkillIndexEntry` and `AgentSkillPackage` shared platform types.
- Added `skill-registry.ts` for Claude-style filesystem `SKILL.md` package parsing.
- Project `.claude/skills` and user `~/.claude/skills` sources are indexed with source provenance and user-over-project precedence.
- Workspace context now carries filesystem Skill metadata without loading full instructions.
- Regression checks: focused `agent-runtime.test.ts`, `npm run build`

## Phase 62 Verification

- Added read-only Native tools `list_agent_skills` and `read_agent_skill`.
- Native prompts now tell the model to list/load a matching filesystem Skill instead of eagerly consuming every `SKILL.md`.
- Claude prompts expose filesystem Skill metadata while keeping existing project-policy skills loaded.
- Regression checks: focused `agent-runtime.test.ts`, `npm run build`

## Phase 63 Verification

- Model-invocable filesystem Skills now auto-activate from conservative metadata matches against the user message.
- Auto activation loads at most two matching Skill instructions and skips Skills marked `disable-model-invocation: true`.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`, `npm run test:runtime`

## Phase 64 Verification

- Messages beginning with `/skill-name` now activate a matching user-invocable filesystem Skill for the current turn.
- Explicit activation loads only the selected Skill's full instruction into `toolContext.activeSkills`; the rest of the registry remains metadata-only.
- `/compact` remains reserved for context compaction and does not activate a Skill with the same name.
- Regression checks: focused `agent-runtime.test.ts`, `npm run build`

## Phase 65 Verification

- Added read-only Native tools `list_agent_skill_files` and `read_agent_skill_file` for supporting files.
- Supporting file reads are scoped to the selected Skill directory, skip symlinks, reject path traversal and binary-like files, and cap file size/content.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`, `npm run test:runtime`

## Phase 66 Verification

- Filesystem Skills now carry trust level, source verification status, content SHA-256, permission policy, script policy, and declared script metadata.
- Project/user/plugin Skills receive local provenance; user/plugin sources can be trusted, while catalog/custom sources default to unverified approval-required handling.
- Skills marked approval-required or untrusted are not auto-activated by metadata matching; explicit invocation and read tools still surface the policy.
- Declared scripts are metadata only and never execute through the Skill system directly; they must go through normal host tools and permission broker checks.
- Native and Claude prompts, `list_agent_skills`, and `read_agent_skill` now show trust, verification, permission, and script boundaries.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`

## Phase 67 Verification

- Claude SDK sessions now receive Skills-aware settings when filesystem Skills exist.
- Inactive Skills are hidden from model auto-selection with `skillOverrides`, while user-invocable inactive Skills remain slash-visible.
- Skill inline shell execution is disabled through SDK settings.
- When the caller uses a Claude SDK AgentDefinition, active Funplay Skills are attached to that agent's `skills` allowlist.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`

## Phase 68 Verification

- Active filesystem Skill selections now persist as first-class `skill_activation` runtime events.
- Agent replay exports include Skill activation metrics and convert persisted activations into structured Agent Core system parts.
- Completed chat transcript rendering now shows activated Skills from Agent Core parts without parsing assistant pseudo text.
- The Skills v2 benchmark now includes activation-event, replay, and transcript visibility checks.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`

## Phase 69 Verification

- Added `npm run agent:skills-v2-benchmark` with focused registry, activation, supporting-file, and read-only tool-boundary checks.
- The deterministic `npm run agent:benchmark` suite now includes the Skills v2 platform slice.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`, `npm run test:runtime`, `npm run agent:roadmap-audit`, `npm run agent:benchmark`

## Phase 70 Verification

- Project Settings now loads the filesystem Skill registry through a main-process IPC path.
- The Skills settings view shows source precedence, same-name override conflicts, trust/verification status, permission policy, script policy, and suggested tools.
- Existing catalog sync/update and project custom Skill override controls remain available beside the Claude Code filesystem registry view.
- Regression checks: `npm run agent:skills-v2-benchmark`, `npm run build`
