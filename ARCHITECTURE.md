# Cortex — Engine Architecture

This document covers the internal mechanics of `src/run-autonomous.mjs` and `bin/cli.mjs` for contributors and anyone who wants to understand how the harness works.

---

## Overview

Cortex runs a deterministic state machine driven by a **task queue**. Every cycle runs inside a subprocess (`claude -p`), emits exactly one signal, and writes a Zod-validated JSON output file. The outer loop reads signals and advances the queue. For multi-intent tasks, the queue is decomposed into ordered groups at plan time and may be extended at runtime by the cross-group reconcile cycle.

---

## Task Queue

The `orchestrate` cycle writes `.harness/task-queue.json` — a manifest that defines every downstream cycle, its type, the owning agent, its output file, and whether it may run in parallel. The main loop consumes this file one batch at a time. Nothing after `orchestrate` is hardcoded.

**Single-intent example:**

```json
{
  "task": "add product listing page",
  "promptType": "implement-feature",
  "cycles": [
    { "id": "explore",            "type": "explore",              "status": "pending", "parallel": false },
    { "id": "implement-backend",  "type": "implement-backend",    "status": "pending", "parallel": true,
      "agent": "backend-subagent" },
    { "id": "implement-frontend", "type": "implement-frontend",   "status": "pending", "parallel": true,
      "agent": "frontend-subagent" },
    { "id": "reconcile",          "type": "reconcile",            "status": "pending", "parallel": false },
    { "id": "test",               "type": "test",                 "status": "pending", "parallel": false },
    { "id": "deliver",            "type": "deliver",              "status": "pending", "parallel": false }
  ]
}
```

**Multi-intent example** (two groups + shared cycles):

```json
{
  "task": "fix broken search, add export CSV",
  "promptType": "multi-intent",
  "intents": [
    { "subTask": "fix broken search filter", "promptType": "fix-bug",           "group": "fix-search" },
    { "subTask": "add export to CSV feature", "promptType": "implement-feature", "group": "add-export" }
  ],
  "cycles": [
    { "id": "explore",                          "type": "explore",           "status": "pending", "parallel": false },
    { "id": "reproduce-fix-search",             "type": "reproduce",         "status": "pending", "taskGroup": "fix-search",  "subTask": "fix broken search filter" },
    { "id": "implement-backend-fix-search",     "type": "implement-backend", "status": "pending", "taskGroup": "fix-search",  "agent": "backend-subagent",  "parallel": true },
    { "id": "implement-frontend-fix-search",    "type": "implement-frontend","status": "pending", "taskGroup": "fix-search",  "agent": "frontend-subagent", "parallel": true },
    { "id": "reconcile-fix-search",             "type": "reconcile",         "status": "pending", "taskGroup": "fix-search"  },
    { "id": "test-fix-search",                  "type": "test",              "status": "pending", "taskGroup": "fix-search"  },
    { "id": "implement-backend-add-export",     "type": "implement-backend", "status": "pending", "taskGroup": "add-export", "agent": "backend-subagent",  "parallel": true },
    { "id": "implement-frontend-add-export",    "type": "implement-frontend","status": "pending", "taskGroup": "add-export", "agent": "frontend-subagent", "parallel": true },
    { "id": "reconcile-add-export",             "type": "reconcile",         "status": "pending", "taskGroup": "add-export" },
    { "id": "test-add-export",                  "type": "test",              "status": "pending", "taskGroup": "add-export" },
    { "id": "reconcile-cross-group",            "type": "reconcile",         "status": "pending", "taskGroup": null          },
    { "id": "deliver",                          "type": "deliver",           "status": "pending", "parallel": false          }
  ]
}
```

---

## Multi-Intent Decomposition

When the orchestrate cycle detects mixed verb clusters in the task description (e.g. fix + implement + edit), it decomposes the task into ordered **groups** before writing the queue.

**Ordering rule:** fix groups run before edit groups, which run before implement/create groups. This ensures fixes restore correct state before new behavior is layered on top.

**Shared explore (default):** A single shared `explore` cycle (no `taskGroup`, `outputFile: "explore.json"`) feeds all groups. Per-group explores are only emitted when the task description makes it unambiguous that the groups touch completely separate surfaces with no shared code.

**Group cycle naming:** All cycles in a group carry `taskGroup: "<slug>"` and `subTask: "<text>"`. Their `id` and `outputFile` include the group slug as a suffix (e.g. `implement-backend-fix-search`, `test-fix-search.json`). Shared cycles (`explore`, `reconcile-cross-group`, `deliver`) omit `taskGroup`.

**Context propagation:** Each implement and reconcile cycle receives ALL previously completed implement reports as prior context — not just its own group's. This gives later groups visibility into what earlier groups changed, enabling correct shared-contract decisions.

---

## Cross-Group Reconcile & Dynamic Queue Extension

After all groups' test cycles complete, `reconcile-cross-group` runs as a shared reconcile step. Its job is to verify that shared type/schema changes made by one group are correctly consumed by all other groups.

It also performs **workflow type validation**: it reviews each group's implement reports and checks whether the cycle type (fix-bug, implement-feature, edit-feature) was appropriate given what the agent actually found. If a mismatch is detected — for example, a fix-bug group found no actual bug, or an implement group found it first needed to fix something broken — the reconcile report includes a `requiresAdditionalGroups[]` array.

```json
{
  "requiresAdditionalGroups": [
    {
      "reason": "implement-backend-add-export found that the export endpoint is broken, not absent — needs fix first",
      "subTask": "fix broken export endpoint",
      "suggestedPromptType": "fix-bug",
      "suggestedAgents": ["backend-subagent"],
      "group": "fix-export-endpoint"
    }
  ]
}
```

The runner reads this after `reconcile-cross-group` completes and calls `injectAdditionalGroups()`, which:

1. Calls `buildAdditionalGroupCycles()` — constructs a full cycle group (reproduce if fix-bug, explore, implement-*, reconcile, test) for each entry
2. Splices the new cycles into the queue immediately before the `deliver` cycle
3. Writes the updated queue to disk
4. Prints the modified pending queue to the terminal

This means the plan is self-correcting: wrong workflow types discovered during execution are handled automatically without human intervention.

---

## Main Execution Loop

```
while (queue has pending cycles):
  batch   ← nextCycleBatch()            // collect consecutive parallel=true cycles
  results ← Promise.allSettled(runCycle × batch)
  for each result:
    signal = extract signal from output
    update cycle status in queue
    CYCLE_COMPLETE      → advance queue; check for additional groups (reconcile-cross-group)
    CYCLE_PARTIAL       → retry or inject fix cycles (see below)
    NEEDS_HUMAN_INPUT   → stop, surface block to user
  check budget: remaining ≤ $0.10 → stop loop

print run summary (done / partial / blocked / pending / duration / cost)
```

Parallel batches are validated before execution via `safeToParallelize()` — if two parallel cycles have overlapping declared file-path scopes (per `harness.config.json`), they are serialized automatically rather than failing.

---

## Run Summary

At the end of every run the harness prints a summary dashboard:

```
━━━ Run Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Done     : 11
Partial  : 0
Blocked  : 1
Pending  : 0
Duration : 42m 18s
Spent    : $8.41 / $20
Log      : .harness/runs/2026-05-31T....jsonl
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Turn Cap & Retry System

| Cycle      | Turn cap           | Error/rate-limit retries | Clean partial retries |
| ---------- | ------------------ | ------------------------ | --------------------- |
| `test`     | **25 turns/slice** | 2                        | **10**                |
| all others | 500 (safety net)   | 2                        | 2                     |

When the test cycle hits its 25-turn cap:

1. The subprocess is force-killed
2. A new `claude -p` call requests a progress summary from accumulated context
3. Output is written as `{ passed: false, partial: true, history: [...] }` — the `history[]` array carries forward to the next slice
4. The test cycle is re-queued with the accumulated history as prior context

This lets long test runs slice across multiple 25-turn windows without losing coverage state. After 10 clean partials, the cycle is declared exhausted and fix injection triggers.

---

## Safety Mechanisms

| Mechanism          | Default                  | What it does                                                              |
| ------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Budget cap         | `MAX_BUDGET_USD = 20`    | Accumulates `total_cost_usd` from every event; stops at `$0.10` remaining |
| Dead man timer     | `DEAD_MAN_MS = 20 min`   | Force-kills subprocess if no stdout for 20 minutes; marks cycle `hung`    |
| Result grace kill  | `RESULT_GRACE_MS = 15 s` | After `result` event, force-kills after 15 s (Windows MCP stdout hold)    |
| Safety turn cap    | `SAFETY_TURN_CAP = 500`  | Hard ceiling on all cycles; prevents infinite loops                       |
| 0-turn silent fail | —                        | `signal === complete` + 0 turns + no output file → treated as partial     |
| Rate-limit detect  | —                        | Detects "You've hit your / session limit / weekly limit" → partial        |

---

## Scope Enforcement

Each implement cycle is bound to a declared file-path scope from `harness.config.json`. After every cycle exits, the harness compares changed files against that scope. Out-of-scope writes trigger a 4-step revert cascade:

```
1. git restore <file>             // restore tracked modified files
2. git clean -f <file>            // remove untracked files
3. git show HEAD:<path> > <file>  // restore from last commit if needed
4. fs.unlinkSync(<file>)          // last resort: delete the file
```

If the cascade cannot fully revert a file, a `scope-cleanup-<cycleId>` reconcile cycle is injected into the queue before the run continues.

**`scope: []` — unconstrained mode:** When an agent's scope is an empty array, the scope check is skipped entirely and the agent may write anywhere. This is the default for a fresh project with no paths configured yet.

---

## Auto-Scope Update

When an implement cycle completes with `scope: []` (unconstrained), the harness automatically detects the paths created and writes them back to `harness.config.json`, locking them in for all future cycles in the same run.

**Path inference** (`inferScopePath`):

| File path | Inferred scope |
|---|---|
| `apps/api/src/products/controller.ts` | `apps/api/` |
| `libs/shared/models/src/product.ts` | `libs/shared/models/` |
| `libs/shop/feature-cart/src/index.ts` | `libs/shop/feature-cart/` |

**Shared lib distribution** (`resolveTargetAgents`): paths added to scope are distributed to all agents that need them, not just the creator:

| Path type | Agents receiving the scope |
|---|---|
| `apps/<name>/` or `libs/<feature>/` | creating agent only |
| `libs/shared/` (non-UI) | backend + frontend + distributed |
| `libs/.../ui` or `libs/.../components` | frontend only |

The in-memory `CONFIGURED_AGENTS` map is also updated immediately, so subsequent cycles in the same run benefit from enforcement right away.

---

## Zod Schema Validation

Every cycle output file is matched against a named Zod schema before its contents are used as context for downstream cycles. The pattern matching is regex-based to handle group-suffixed filenames:

| Pattern | Schema |
|---|---|
| `skills.json` | `SkillsReport` |
| `explore[-<group>].json` | `ExploreReport` |
| `plan[-<group>].json` | `PlanReport` |
| `reproduce[-<group>].json` | `ReproduceReport` |
| `implement-*.json` | `ImplementReport` |
| `reconcile[-<group>].json` | `ReconcileReport` |
| `test[-<group>].json` | `TestReport` |
| `fix-*.json` | `FixReport` |

On schema mismatch, a warning is printed and conservative defaults (from `CONSERVATIVE_DEFAULTS`) fill in missing critical fields — the run continues rather than aborting.

The `ReconcileReport` schema includes the optional `requiresAdditionalGroups` field (array of `AdditionalGroupEntry`) used by `reconcile-cross-group` to trigger dynamic queue extension.

---

## Surface Detection (init)

`bin/cli.mjs` recursively walks the project tree on `init`, skipping standard ignore directories (`node_modules`, `.git`, `dist`, `build`, `.nx`, etc.). A directory is treated as a **project root** when it contains `src/`, `project.json`, `index.ts`, or `index.js`.

Each project root's full relative path is matched against ordered word-boundary regexes:

```
backend      →  \b(api|backend|server|serverless)\b
distributed  →  \b(worker|queue|job|processor|consumer|producer)\b
sharedSchema →  \b(schema|zod|validation|models?)\b
sharedTypes  →  \b(types?|entit(y|ies)|interfaces?|domain)\b
sharedUi     →  \bui\b|\b(components?|design[-_]system)\b
frontend     →  \b(web|frontend|client|shop|store|dashboard|portal)\b
```

First match wins. Paths that match nothing are left unassigned and shown to the user for manual input. `e2e` projects are always skipped.

Works for both **explicit-config** workspaces (with `project.json`) and **inferred-target** workspaces (plugins only, no `project.json`).

---

## Agent MD Sentinel Patching

Agent `.agent.md` files use HTML comment sentinels to mark scope sections:

```md
## Scope

Primary ownership:
<!-- cortex:backend -->
- `apps/api/`
<!-- /cortex:backend -->
```

`patchAgentScopes()` in `cli.mjs` replaces the content between each `<!-- cortex:KEY -->` / `<!-- /cortex:KEY -->` pair using `indexOf` (no regex, no escaping issues). Patching runs automatically after:

- `cortex-harness init` — after surface confirmation
- `cortex-harness config` — after the interactive wizard
- `cortex-harness config add-scope` / `remove-scope` — after any surgical scope mutation

The `<!-- cortex:frontend-checks -->` sentinel generates Nx run commands from the actual frontend app names (e.g. `nx run shop:lint`) rather than a hardcoded project name.

---

## Gitignore Management

`init` and the standalone `cortex-harness gitignore` command both call `patchGitignore()`, which appends a fenced block to the project's `.gitignore`:

```
# cortex-harness
.harness/runs/
.harness/cycle-state/
.harness/output/
.harness/session.json
.harness/notification-channels.local.json
# /cortex-harness
```

The function is idempotent — it checks for the `# cortex-harness` block before writing and skips if already present. `.harness/task-queue.json` is intentionally **not** gitignored: it contains the cycle plan the orchestrator writes and that users may want to inspect or commit.

---

## Fix Injection & Recovery

```
test fails
  ↓
inject fix-<surface>-attempt-1[-<group>]    (re-delegate to owning agent with exact error)
inject test-retry-1[-<group>]
  ↓ still failing
inject fix-<surface>-attempt-2[-<group>]
inject test-retry-2[-<group>]
  ↓ MAX_RETRIES (2) exhausted
inject recovery[-<group>] cycle             (reads prompt-orchestration.md, applies chaining)
  ↓
deliver                                     (with residual risks noted)
```

Fix cycles carry the exact error output from the preceding test run. Each retry targets the agent that owns the broken surface per the routing table. In multi-intent runs, fix and retry cycles carry the group's `taskGroup` and `subTask` fields so context is scoped correctly.

---

## Session Persistence & Logging

**Autonomous resume** is driven by `task-queue.json` — the outer loop checks whether cycles with `pending` or `partial` status remain and picks up from the first incomplete one. No separate "session check" cycle runs; the harness does this itself before spawning anything.

`session.json` is a separate audit trail: the harness writes each cycle outcome (`done` / `partial` / `blocked`) there for interactive sessions. When a human runs `cortex-harness resume` from the CLI, `session.json` is what surfaces unfinished work in the conversation — it does not drive the autonomous loop.

Every subprocess event — text deltas, tool calls, cost data, results — is appended as newline-delimited JSON to `.harness/runs/<timestamp>.jsonl`, providing a full audit trail of every run.

The final deliver summary is also written to `.harness/output/delivery-<timestamp>.md` so it survives the session and can be referenced later.

---

## Windows Spawning

On Windows, Cortex avoids shell quote-handling issues with long prompts by:

1. Writing the full cycle prompt to a UTF-8 `.txt` temp file in `.harness/runs/`
2. Generating a `.ps1` wrapper script that reads and passes the file
3. Spawning `powershell.exe` to execute the wrapper
