# Cortex — Autonomous Nx Agent Harness

> A config-driven, multi-cycle autonomous agent harness for Nx monorepos. Orchestrates Claude Code sub-agents through a deterministic state machine — explore, plan, implement, reconcile, test, and deliver — with Zod-validated state, git-enforced scope boundaries, self-healing fix injection, and multi-intent task decomposition.

![Cortex state machine](./open_agent_harness_full_state_machine.svg)

---

## Why Cortex?

Most agent harnesses give you a single orchestrator loop with no structure between steps. Cortex is different:

| Feature                          | Cortex                                                        | Most harnesses          |
| -------------------------------- | ------------------------------------------------------------- | ----------------------- |
| Typed cycle state machine        | ✓ Zod-validated JSON per cycle                                | ✗ free-form chat        |
| Git-enforced write scopes        | ✓ auto-revert out-of-scope changes                            | ✗ agents write anywhere |
| Parallel sub-agents              | ✓ `Promise.allSettled` on non-overlapping scopes              | ✗ sequential only       |
| Multi-intent decomposition       | ✓ splits mixed tasks into ordered groups, each fully verified | ✗ one task at a time    |
| Dynamic queue extension          | ✓ reconcile-cross-group injects missing cycle groups at runtime | ✗ static plan only    |
| Fix injection on test failure    | ✓ dynamic cycle injection, configurable `MAX_RETRIES`         | ✗ manual retry          |
| Rate-limit recovery              | ✓ writes partial state, `resume` re-enters at last cycle      | ✗ start over            |
| Nx-aware verification            | ✓ `nx affected` — only reruns stale projects                  | ✗ full rebuild          |
| Config-driven agents             | ✓ drop `harness.config.json` into any Nx workspace            | ✗ code changes needed   |
| Surface auto-detection           | ✓ scans project tree on `init`, no manual path entry          | ✗ hardcoded config      |
| Auto-scope update                | ✓ locks in new paths after unconstrained agent runs           | ✗ manual config update  |

---

## Cycle Flow

**Single-intent task**

```
Start run
  └─ Orchestrate           (route prompt type, invoke skills, write task-queue.json)
  └─ Explore               (map codebase, placement, naming conventions)
  └─ Plan                  (design approach — only if multi-surface or shared contracts)
  └─ Implement ×N          (parallel sub-agents, non-overlapping scopes)
       ├─ Backend
       └─ Frontend / Worker      ← git scope revert on exit
  └─ Reconcile             (contract check, gap table, re-delegate)
  └─ Test                  (nx affected build / test / lint, 25-turn slices)
       └─ [on fail] Fix ×MAX_RETRIES  (re-delegate to owning agent)
            └─ [exhausted] Recovery cycle
  └─ Deliver               (summary, PR description, residual risks)
```

**Multi-intent task** (mixed fix + implement + edit verbs)

```
Start run
  └─ Orchestrate           (decompose into ordered groups: fix → edit → implement)
  └─ Explore               (shared — one explore feeds all groups by default)
  └─ [Group: fix-x]        (reproduce → implement → reconcile → test)
  └─ [Group: edit-y]       (explore? → implement → reconcile → test)
  └─ [Group: add-z]        (explore? → implement → reconcile → test)
  └─ Reconcile-cross-group (verify shared contracts across all groups; may inject new groups)
  └─ Deliver
```

Each cycle emits exactly one signal: `CYCLE_COMPLETE` · `CYCLE_PARTIAL:<reason>` · `NEEDS_HUMAN_INPUT`

For a deep dive into the engine — task queue structure, turn cap system, safety mechanisms, scope revert cascade, fix injection, and Windows spawning — see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Installation

```bash
npm install -g cortex-harness
```

Or run without installing:

```bash
npx cortex-harness init
```

**Requires Node.js ≥ 20** and [Claude Code](https://claude.ai/code) CLI installed and authenticated.

---

## Getting Started

### 1. Initialize

Scaffolds `.harness/` with prompt templates, agent role files, `CLAUDE.md`, `harness.config.json`, and patches `.gitignore`. Automatically detects your project's surfaces:

```bash
npx cortex-harness init
```

During init, Cortex walks your project tree, classifies directories by name pattern, and prompts you to confirm the mapping:

```
  cortex-harness v1.3.0  —  init
────────────────────────────────────────────────────────────────────────

  Scaffolding prompts
  + .harness/prompts/implement-feature.md
  + .harness/prompts/fix-bug.md
  ...

  Writing root config files
  + harness.config.json
  + CLAUDE.md
  + .gitignore

────────────────────────────────────────────────────────────────────────
  Surface configuration
────────────────────────────────────────────────────────────────────────

  Nx workspace detected. Confirm surface paths — press Enter to accept.

  Backend / serverless paths  [apps/api/]:
  Frontend paths              [apps/web/]:
  Worker / queue paths        [none — enter path or leave blank to skip]:
  Shared schema lib paths     [libs/shared/schema/]:
  Shared types lib paths      [libs/shared/types/]:
  Shared UI lib paths         [libs/shared/ui/]:

  ✓ harness.config.json updated
  ✓ .harness/agents/*.agent.md scope sections patched

────────────────────────────────────────────────────────────────────────
  ✓ Harness initialized successfully
────────────────────────────────────────────────────────────────────────
```

Agent `.agent.md` files use `<!-- cortex:surface -->` sentinels — their scope sections are automatically patched to match your confirmed paths.

**Init also patches `.gitignore`** — the following runtime-only paths are added automatically so they are never accidentally committed:

```
.harness/runs/
.harness/cycle-state/
.harness/output/
.harness/session.json
.harness/notification-channels.local.json
```

### 2. Manage scopes

Use the `config` command instead of editing `harness.config.json` directly:

```bash
# View current configuration
cortex-harness config list

# Interactive wizard — pick an agent, update its scope paths
cortex-harness config

# Add a path to an agent's scope
cortex-harness config add-scope backend-subagent libs/shared/models/

# Remove a path from an agent's scope
cortex-harness config remove-scope frontend-subagent libs/shared/ui/
```

Every `config` mutation updates both `harness.config.json` and the scope sections in `.harness/agents/*.agent.md` in one step.

### 3. Run

```bash
cortex-harness run "add a product listing page with search and filters"
```

Multi-intent tasks work the same way — Cortex decomposes them automatically:

```bash
cortex-harness run "fix the broken search filter, update the product card design, and add an export to CSV feature"
```

This produces three ordered groups (`fix-search-filter` → `update-product-card` → `add-export-csv`), each with its own implement → reconcile → test cycle, then a shared cross-group reconcile before deliver.

### 4. Resume a blocked or rate-limited run

```bash
cortex-harness resume
```

### 5. Check run status

```bash
cortex-harness status
```

Prints a live dashboard: blocked questions, partial cycles, pending queue, duration, and cost so far.

### 6. View run logs

```bash
cortex-harness logs
```

Prints events from the most recent run in a readable, color-coded format:

```
[    1] ▶ RUN START   task: add a product listing page
[    2] ◇ assistant   reading the existing page structure...
[    3] ⚙ system      task_started task:abc123
[    4] ◇ assistant   tool:Read
[    5] ◇ user        {"content": "...file contents..."}
[09:12:45] → CYCLE      explore
[09:14:02] ← CYCLE END  explore ✓1
[09:14:02] ■ RUN END    ✓ done:5  spent: $0.56
```

To view a specific run, pass its timestamp (filename without `.jsonl`):

```bash
cortex-harness logs --run 2026-05-31T09-59-22
```

To scroll through a long run:

```bash
cortex-harness logs | less -R
```

---

## Gitignore patching for existing projects

If you initialized before v1.3.0 and your runtime files are being tracked, run:

```bash
cortex-harness gitignore
```

This appends the harness runtime entries to `.gitignore` (idempotent — safe to run multiple times).

---

## Scope Enforcement & Auto-Update

Each agent is bound to its declared scope paths. After every cycle, Cortex compares changed files against those paths. Out-of-scope writes are automatically reverted via a 4-step git cascade.

Reverts are non-destructive: a pre-run snapshot captures uncommitted work before the run starts and is refreshed with each cycle's valid in-scope edits, so a revert restores the latest known-good content for a file rather than wiping it back to bare `HEAD`. See [ARCHITECTURE.md → Pre-Run Snapshot & Recovery](./ARCHITECTURE.md#pre-run-snapshot--recovery) for details.

**New project with no scopes configured?** Set all agent scopes to `[]` and run. Cortex detects the paths your agents create, locks them into `harness.config.json`, and enforces them from the next cycle onward — shared libs (`libs/shared/`) are automatically distributed to all relevant agents.

---

## Config Reference

| Field        | Type   | Default            | Description                                       |
| ------------ | ------ | ------------------ | ------------------------------------------------- |
| `harnessDir` | string | `.harness`         | Root directory for all harness files              |
| `promptsDir` | string | `.harness/prompts` | Cycle prompt templates                            |
| `agentsDir`  | string | `.harness/agents`  | Agent role definition files                       |
| `agents`     | object | `{}`               | Map of agent name → `{ scope: string[] \| null }` |

`scope: null` — agent may read/verify everywhere (tester, explorer).  
`scope: []` — agent is unconstrained; auto-scope update fires after first run.  
Out-of-scope file writes are automatically reverted by git after each implement cycle.

---

## Cycle Reference

| Cycle                   | Type         | What it does                                                                   | Output file                    |
| ----------------------- | ------------ | ------------------------------------------------------------------------------ | ------------------------------ |
| `orchestrate`           | planning     | Routes prompt type, decomposes multi-intent tasks, writes `task-queue.json`    | `orchestrate.json`             |
| `explore`               | discovery    | Maps file structure, naming conventions, component placement                   | `explore.json`                 |
| `plan`                  | planning     | Designs approach, assigns write scopes to each implement cycle                 | `plan.json`                    |
| `reproduce`             | diagnosis    | Reproduces failing behavior; identifies root cause before fix cycles begin     | `reproduce.json`               |
| `implement-*`           | execution    | Writes source files within declared scope; reverts violations                  | `implement-<surface>.json`     |
| `reconcile`             | verification | Cross-surface contract check, fills gap table, re-delegates gaps               | `reconcile[-<group>].json`     |
| `reconcile-cross-group` | verification | Multi-intent only — verifies shared contracts across all groups; may inject new cycle groups | `reconcile-cross-group.json` |
| `test`                  | verification | Runs `nx affected --target=build,test,lint`; 25 turns/slice, up to 10 retries | `test[-<group>].json`          |
| `fix-*`                 | recovery     | Re-delegates broken surface to owning agent with exact error                   | injected dynamically           |
| `recovery`              | recovery     | Reads prompt-orchestration.md after MAX_RETRIES exhausted; applies chaining    | injected dynamically           |
| `deliver`               | delivery     | Unified summary, PR description, residual risks                                | `deliver.json`                 |

---

## Project Structure

```
.harness/
  prompts/
    orchestrate.md              ← 8-step planning prompt (route, disambiguate, decompose)
    implement-feature.md
    fix-bug.md
    edit-feature.md
    create-app.md
    reconcile.md
    prompt-orchestration.md
  agents/
    backend-subagent.agent.md   ← scope sections auto-patched by cortex-harness config
    frontend-subagent.agent.md
    distributed-subagent.agent.md
    infra-subagent.agent.md
    tester-subagent.agent.md
    explorer-subagent.agent.md
    planner-subagent.agent.md
  cycle-state/                  ← written at runtime (gitignored)
    skills.json                 ← skill output forwarded to implement cycles
    *.json                      ← per-cycle Zod-validated output files
  runs/                         ← gitignored
    <timestamp>.jsonl           ← full event log per run
  output/                       ← gitignored
    delivery-<timestamp>.md     ← final deliver summary written to disk
  session.json                  ← cycle outcome audit trail for interactive resume (gitignored)
  task-queue.json               ← queue written by orchestrate, consumed by main loop
harness.config.json             ← your workspace config (managed by cortex-harness config)
CLAUDE.md                       ← agent routing and protocol (checked in)
```

---

## License

[MIT](./LICENSE)
