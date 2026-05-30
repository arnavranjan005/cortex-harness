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
| test | `test` | `nx affected --target=build,test,lint`; 25 turns/slice, up to 10 clean retries |
| fix-* | `fix` | Injected dynamically on test failure, up to MAX_RETRIES=2 |
| recovery | `recovery` | Injected after MAX_RETRIES exhausted — reads orchestration.md, re-chains |
| deliver | `deliver` | Reads all cycle-state/ files, produces unified summary |

Sequence enforced by harness: `orchestrate → explore → plan? → implement-* → reconcile → test → [fix-* → test-retry]* → [recovery]? → deliver`

## State transfer

Each cycle writes a JSON file to `.harness/cycle-state/`. The next cycle's prompt injects prior outputs:

| File | Written by | Read by |
|---|---|---|
| `task-queue.json` | orchestrate | outer loop (drives cycle execution) |
| `skills.json` | orchestrate | all implement cycles (as `## Skill guidance`) |
| `explore.json` | explore | plan, implement-*, reconcile |
| `plan.json` | plan | implement-*, reconcile |
| `implement-*.json` | each implement cycle | reconcile |
| `reconcile.json` | reconcile | test, deliver |
| `test.json` | test | outer loop (branches on `passed` field) |

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
- **Turn cap**: test cycle capped at 25 turns/slice; all others at 500 (safety net)
- **Scope revert**: out-of-scope writes cascade through `git restore → git clean -f → git show HEAD → unlinkSync`

## Cycle output validation

`cycle-schemas.mjs` validates all cycle output files after each cycle completes:
- `test.json` is critical: invalid JSON → treat as failed; missing `passed` field → default `false`
- All other files: warn + continue (wrong structure means less context, not wrong execution path)

[[feedback-claude-md-compliance]]
