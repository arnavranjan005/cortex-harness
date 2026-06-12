---
name: project-harness-architecture
description: Multi-cycle autonomous harness — each cycle is a fresh bounded claude -p session driven by task-queue.json; surfaces auto-detected on init; scopes auto-updated after unconstrained runs
metadata:
  type: project
---

The autonomous harness (`run-autonomous.mjs`) runs each cycle as a fresh, bounded `claude -p` session. Nothing is hardcoded after `orchestrate` — the task queue drives everything.

**Why:** Single long sessions fail reliably after ~2 hours — context fills, compaction fires, compliance decays, and hangs have no recovery path. Short, stateless cycles keep each session focused and recoverable.

**How to apply:** When working in or around harness files, treat `run-autonomous.mjs`, `cycle-schemas.mjs`, and `cycle-state/` as the runtime. Do not suggest reverting to single-session autonomous runs.

## Cycle types and sequence

| Cycle | Type string | Owns |
|---|---|---|
| orchestrate | `orchestrate` | Routes task → reads prompt file → invokes skills → writes `task-queue.json` + `skills.json` |
| explore | `explore` | Read-only surface mapping (explorer-subagent) |
| plan | `plan` | Read-only work packages (planner-subagent) — conditional on multi-surface or shared contracts |
| implement-* | `implement` | Source file edits within declared scope; scope violations auto-reverted |
| reconcile | `reconcile` | Contract check + gap resolution + consistency |
| reconcile-cross-group | `reconcile` | Multi-intent only — checks contracts across all groups; may emit `requiresAdditionalGroups` to inject new cycle groups |
| test | `test` | `nx affected --target=build,test,lint`; 25 turns/slice, up to 10 clean retries |
| smoke | `smoke` | Browser pass after test — playwright MCP auto-scoped, dev server auto-started via browser MCP detection; emitted only for groups with an implement-frontend cycle |
| fix-* | `fix` | Injected dynamically on test failure, up to MAX_RETRIES=2 |
| recovery | `recovery` | Injected after MAX_RETRIES exhausted — reads orchestration.md, re-chains |
| deliver | `deliver` | Reads all cycle-state/ files, produces unified summary |

Single-intent sequence: `orchestrate → explore → plan? → implement-* → reconcile → test → [smoke?] → [fix-* → test-retry]* → [recovery]? → deliver`

Multi-intent sequence: `orchestrate → [shared-explore] → [fix-group cycles] → [edit-group cycles] → [implement-group cycles] → reconcile-cross-group → [global-smoke?] → [additional-group cycles?] → deliver`
Each implement-feature/edit-feature group runs: `implement-* → reconcile-group → test-group → [per-group-smoke?] → [fix-* → test-retry]*`
Each fix-bug group runs: `reproduce (emitted before shared explore) → implement-* → test-group → reconcile-group → [per-group-smoke?] → [fix-* → test-retry]*`

**Multi-intent smoke ordering (important):**
- Per-group smoke runs *inside* each group, after that group's test cycle, **BEFORE** reconcile-cross-group.
- Global smoke (no taskGroup) runs *after* reconcile-cross-group — catches cross-group integration failures and any frontend files touched by reconcile-cross-group. Only emitted if any group has an implement-frontend cycle.
- Per-group smokes are omitted if the global smoke already covers everything — but the orchestrate prompt emits both when any group has frontend cycles.

## State transfer

Each cycle writes a JSON file to `.harness/cycle-state/`. The next cycle's prompt injects prior outputs:

| File | Written by | Read by |
|---|---|---|
| `task-queue.json` | orchestrate | outer loop (drives cycle execution) |
| `skills.json` | orchestrate | all implement cycles (as `## Skill guidance`) — no group suffix, always shared |
| `explore.json` | explore (shared) | all groups via fallback |
| `explore-<group>.json` | explore (per-group) | only that group's implement/reconcile cycles |
| `plan.json` / `plan-<group>.json` | plan | implement-*, reconcile for same group |
| `implement-*-<group>.json` | each implement cycle | reconcile for same group; ALL groups' impls visible to subsequent implement cycles |
| `reconcile-<group>.json` | per-group reconcile | test for same group |
| `reconcile-cross-group.json` | reconcile-cross-group | deliver; outer loop checks `requiresAdditionalGroups` |
| `test-<group>.json` | test per group | outer loop (branches on `passed`; group-suffixed fix cycles injected on failure) |
| `test.json` | test (single-intent) | outer loop |

For single-intent tasks all files are un-suffixed — backward compatible with the original design.

## Scope enforcement and auto-update

Each implement cycle is bound to scope paths in `harness.config.json`. After every cycle exits, changed files are compared against scope — out-of-scope writes are reverted via `git restore → git clean -f → git show HEAD → unlinkSync`.

When an agent runs with `scope: []` (unconstrained), the harness auto-detects created paths and writes them back to `harness.config.json` after the cycle completes. Shared libs (`libs/shared/`) are distributed to all relevant agents; app/feature paths go only to the creator.

## Surface detection on init

`cortex-harness init` recursively walks the project tree and classifies project roots by matching their full relative path against word-boundary regexes. Works for both `project.json`-based and inferred-target Nx workspaces. Unrecognized paths are shown to the user for manual input.

## Agent MD sentinel patching

Agent `.agent.md` files use `<!-- cortex:surface -->` sentinels around scope sections. `cortex-harness init`, `cortex-harness config`, and `config add-scope`/`remove-scope` all patch these sections automatically so agent files always reflect the current `harness.config.json`.

## Config CLI

`cortex-harness config` replaces manual `harness.config.json` editing:
- `config list` — print scope table
- `config` — interactive wizard
- `config add-scope <agent> <path>` — add a scope path
- `config remove-scope <agent> <path>` — remove a scope path

Every mutation updates both `harness.config.json` and agent `.agent.md` scope sections.

## Parallel execution

Implement cycles with non-overlapping write scopes run in parallel (`parallel: true` in queue entry). The outer loop validates scope safety before spawning `Promise.allSettled`. If overlap detected → serialized silently. Sequential cycle types (`test`, `reconcile`, `deliver`) are never parallelized.

## Completion signals

Every cycle must end its final message with exactly one:
- `CYCLE_COMPLETE` — finished, advance queue
- `NEEDS_HUMAN_INPUT` — blocked, pause queue, notify user
- `CYCLE_PARTIAL:<reason>` — incomplete, outer loop retries up to MAX_RETRIES

## Safety mechanisms

- **Budget cap**: `MAX_BUDGET_USD = 20` — stops loop at $0.10 remaining
- **Dead man timer**: `DEAD_MAN_MS = 20 min` — force-kills subprocess on silence
- **Turn cap**: test cycle 25 turns/slice (up to 10 clean retries); smoke cycle 20 turns/slice (up to 10 clean retries); all others 500 safety ceiling
- **Scope revert**: out-of-scope writes cascade through `git restore → git clean -f → git show HEAD → unlinkSync`
- **Smoke gate in deliver**: if any `smoke*.json` has `passed: false` and `skipped != true`, deliver does NOT write a normal summary — it emits only a Smoke failures section and ends with `NEEDS_HUMAN_INPUT`

## Multi-intent decomposition

When a task contains multiple distinct intent signals (fix + edit + implement/create), orchestrate decomposes it:
- `promptType: "multi-intent"` in task-queue.json; `intents[]` lists each sub-task with its `group` slug and `promptType`
- Each cycle entry carries `taskGroup` (short kebab slug, max 3 words: verb-noun) and `subTask`
- Shared cycles (explore when overlapping surfaces, reconcile-cross-group, deliver) omit `taskGroup`
- Execution order across groups: fix → edit → implement/create (fixes restore state first)
- Shared explore: one `explore.json` for overlapping surfaces; `priorContext` falls back to it automatically
- Per-group reconcile checks intra-group contracts; reconcile-cross-group checks inter-group contracts
- If reconcile-cross-group finds a group used the wrong workflow, it writes `requiresAdditionalGroups[]` in its output; the runner injects new cycle groups (explore → implement-* → reconcile → test) before deliver

## Dynamic injection

The queue is a living file. The runner injects cycles at runtime:

| Trigger | What gets injected | Before |
|---|---|---|
| test fails, retries remain | `fix-<surface>-attempt-N[-group]` + `test-retry-N[-group]` | deliver |
| test fails, retries exhausted | `recovery[-group]` | deliver |
| scope violation can't auto-revert | `scope-cleanup-<cycleId>` | next implement or reconcile |
| reconcile-cross-group finds wrong workflow | additional group cycles per `requiresAdditionalGroups[]` | deliver |

All injected cycles inherit `taskGroup` and `subTask` from the triggering cycle where applicable.

## Cycle output validation

`cycle-schemas.mjs` validates all cycle output files after each cycle completes:
- `test.json` / `test-<group>.json` is critical: invalid JSON → treat as failed; missing `passed` field → default `false`
- `reconcile-cross-group.json` is non-critical: invalid JSON → skip `requiresAdditionalGroups` check, continue
- All other files: warn + continue (wrong structure means less context, not wrong execution path)
- Schema registry patterns use `(-[^.]+)?` suffix matching so group-suffixed files validate against the same schemas

[[feedback-claude-md-compliance]]
