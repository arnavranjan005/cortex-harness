# Cortex — Autonomous Nx Agent Harness

[![npm version](https://img.shields.io/npm/v/cortex-harness?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/cortex-harness)
[![npm downloads](https://img.shields.io/npm/dm/cortex-harness?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/cortex-harness)
[![CI](https://img.shields.io/github/actions/workflow/status/arnavranjan005/cortex-harness/ci.yml?branch=main&label=CI&logo=github)](https://github.com/arnavranjan005/cortex-harness/actions/workflows/ci.yml)
[![Node >=20](https://img.shields.io/node/v/cortex-harness?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Cortex turns a Claude Code session into a supervised engineering team. You give it a task; it writes a typed cycle queue, dispatches git-scoped sub-agents in parallel, Zod-validates every output, auto-reverts scope violations using a non-destructive snapshot, and injects fix cycles when tests or browser smoke fails — repeating until the workspace is clean or chaining into the next run from residual risks.

![Cortex runtime architecture](./cortex-harness-runtime.svg)

---

## Why Cortex?

Most agent harnesses give you a single orchestrator loop with no structure between steps. Cortex is different:

| Feature                       | Cortex                                                          | Most harnesses          |
| ----------------------------- | --------------------------------------------------------------- | ----------------------- |
| Typed cycle state machine     | ✓ Zod-validated JSON per cycle                                  | ✗ free-form chat        |
| Git-enforced write scopes     | ✓ auto-revert out-of-scope changes                              | ✗ agents write anywhere |
| Parallel sub-agents           | ✓ `Promise.allSettled` on non-overlapping scopes                | ✗ sequential only       |
| Multi-intent decomposition    | ✓ splits mixed tasks into ordered groups, each fully verified   | ✗ one task at a time    |
| Dynamic queue extension       | ✓ reconcile-cross-group injects missing cycle groups at runtime | ✗ static plan only      |
| Fix injection on test failure | ✓ dynamic cycle injection, configurable `MAX_RETRIES`           | ✗ manual retry          |
| Rate-limit recovery           | ✓ writes partial state, `resume` re-enters at last cycle        | ✗ start over            |
| Nx-aware verification         | ✓ `nx affected` — only reruns stale projects                    | ✗ full rebuild          |
| Config-driven agents          | ✓ drop `harness.config.json` into any Nx workspace              | ✗ code changes needed   |
| Surface auto-detection        | ✓ scans project tree on `init`, no manual path entry            | ✗ hardcoded config      |
| Auto-scope update             | ✓ locks in new paths after unconstrained agent runs             | ✗ manual config update  |

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
  └─ Smoke                 (per-URL browser pass via Playwright MCP; auto-starts dev server)
  └─ Deliver               (summary, PR description, residual risks)
```

**Multi-intent task** (mixed fix + implement + edit verbs)

```
Start run
  └─ Orchestrate           (decompose into ordered groups: fix → edit → implement)
  └─ Explore               (shared — one explore feeds all groups by default)
  └─ [Group: fix-x]        (reproduce → implement → reconcile → test → smoke)
  └─ [Group: edit-y]       (explore? → implement → reconcile → test → smoke)
  └─ [Group: add-z]        (explore? → implement → reconcile → test → smoke)
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

**Requires Node.js ≥ 20** and a supported agent CLI installed and authenticated — [Claude Code](https://claude.ai/code) (default) or [OpenCode](https://opencode.ai). See [§2c](#2c-switch-cli-backend) to switch backends.

---

## Getting Started

### 1. Initialize

Scaffolds `.harness/` with prompt templates, agent role files, `CLAUDE.md`, `harness.config.json`, and patches `.gitignore`. Automatically detects your project's surfaces:

```bash
npx cortex-harness init

# Skip all interactive prompts — accept detected defaults
npx cortex-harness init --yes
npx cortex-harness init -y
```

During init, Cortex walks your project tree, classifies directories by name pattern, and prompts you to confirm the mapping:

```
  cortex-harness v1.11.0  —  init
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

### 1a. Register auth profiles (optional, for authenticated smoke testing)

If your app has login-gated pages, register a named auth profile so Cortex can probe them during the smoke cycle:

```bash
# Opens a headed browser — log in manually, then close the window
cortex-harness auth

# Named profile for multi-role testing
cortex-harness auth --profile admin
cortex-harness auth --profile customer
```

Cortex captures Playwright storage state and writes the profile to `harness.config.json` under `authProfiles`. During smoke runs, the matching `mcp__playwright-<name>__*` MCP server is injected automatically with the saved session.

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

**Dev server management:**

```bash
# Print current devServer services table
cortex-harness config dev-server

# Auto-detect services and write to harness.config.json
cortex-harness config dev-server detect

# Remove devServer block from harness.config.json
cortex-harness config dev-server clear
```

`detect` scans depth-1 subdirectories and the project root for known frameworks (Next.js, Vite, Angular, NestJS, Express, Django, FastAPI, Flask, Rails, Spring Boot, .NET, Go, Laravel, Rust) and writes a `devServer.services[]` block to config. The `init` command runs detection automatically when a dev server is found.

### 2a. Manage MCP server scope

Every cycle only gets the MCP servers listed for its agent (or cycle type) under `mcpScope` in `harness.config.json` — `mcpScope["*"]` applies to every cycle, on top of its own key. A server with no entry anywhere in `mcpScope` never loads for any cycle, even though it's registered in `.mcp.json`.

```bash
# Inspect what's registered and scoped — flags any server with no mcpScope
# entry at all (e.g. one you added to .mcp.json by hand)
cortex-harness mcp

# Print just the mcpScope table
cortex-harness config mcp-scope

# Interactive wizard — pick an agent (or "*"), then pick servers for it
# from a checklist (no typing names), loop back to pick another agent
cortex-harness config
# → "MCP server scope"

# One-shot scripting equivalents
cortex-harness config add-mcp-scope frontend-subagent shadcn
cortex-harness config remove-mcp-scope frontend-subagent shadcn
```

`init` registers servers from the template's `.mcp.json` additively (never overwrites a server you already defined) and auto-scopes the well-known ones (`playwright`, `shadcn`, `github`, `filesystem`, `fetch`) into the matching agents with no prompt. Any other server it registers triggers the same checklist prompt as the wizard above — "which agents should get this new server?" — since there's no safe default for an unknown tool's access. In non-interactive `init` runs (`-y`, CI) that prompt is skipped and the server is left unscoped; a warning names it so you can run `add-mcp-scope` afterward.

`cortex-harness mcp usage` attributes prior tool calls to the server that made them by parsing the `mcp__<server>__<tool>` prefix Claude Code gives every MCP tool call — this works for any server, including ones added after the fact, with no per-server config needed.

### 2b. Manage dynamic route params

Pages with a `[param]`/`[...param]` segment (e.g. `app/clients/[id]/page.tsx`) get a generic placeholder (`"1"` / `"test"`) substituted in during smoke URL scanning unless you configure a real value via `routeParams` in `harness.config.json`. This applies whether the URL was found by the deterministic filesystem scanner or by the pre-smoke LLM URL detector — the LLM only ever flags a URL as dynamic, the engine mechanically resolves `routeParams` against it afterward, so the substitution logic only lives in one place. Two shapes are supported, checked in order:

- **Route-specific override** — keyed by the bracket route pattern, value is `{ paramName: value }`. Wins when present.
- **Flat default** — keyed by param name only, applies to every route using that name.

```bash
# Print the current routeParams table
cortex-harness config route-params

# Interactive wizard — lists dynamic pages actually found in your project (no
# need to hand-type a bracket path), asks for a value per param, then asks
# whether it applies to that one page or to every page using that param name
cortex-harness config
# → "Dynamic route params"

# One-shot scripting equivalents
cortex-harness config set-route-param id 1
cortex-harness config set-route-override /clients/[id] id demo-client-1
cortex-harness config remove-route-param id
cortex-harness config remove-route-param /clients/[id]
```

### 2c. Switch CLI backend

Cortex drives cycles through a pluggable CLI adapter — `claude` (default) or `opencode`. Both are scaffolded by `init` (prompt/agent templates for each live side-by-side as `.harness/prompts-opencode/` and `.harness/agents-opencode/`), so switching later doesn't require re-running `init`.

```bash
# Print the configured backend and which providers are actually installed on PATH
cortex-harness config cli-provider

# Switch backend
cortex-harness config set-cli-provider opencode
cortex-harness config set-cli-provider claude

# Interactive wizard — pick from installed/known providers with install status shown
cortex-harness config
# → "CLI backend"
```

The two backends differ in cost telemetry, MCP scoping mechanism, and tool-naming convention, but `cortex-harness run`/`resume`/`status`/`logs` work identically against either — see [ARCHITECTURE.md → CLI Adapters](./ARCHITECTURE.md#cli-adapters) for the full contract.

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

### 4a. Chain runs automatically

`chain` runs a task, extracts residual risks from the delivery, and automatically starts the next run to address them — repeating until no actionable risks remain or the run/budget cap is hit:

```bash
# Start a chained sequence
cortex-harness chain "add product listing page with search and filters"

# Continue from the last delivery (reads residual risks automatically)
cortex-harness chain

# Resume a blocked/partial run, then keep chaining
cortex-harness chain resume

# Options
cortex-harness chain "task" --max-runs 5 --budget 100
```

| Flag | Default | Description |
|---|---|---|
| `--max-runs <n>` | `3` | Maximum number of sequential runs |
| `--budget <usd>` | `60` | Global USD cap across all chained runs |
| `--resume-on-block` | off | Collect human answers for blocked cycles and resume within the chain |

If a session-limit block is hit mid-chain, the chain stops immediately with a clear message — `cortex-harness chain resume` re-enters after your limit resets.

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

| Field                    | Type   | Default            | Description                                                       |
| ------------------------ | ------ | ------------------ | ----------------------------------------------------------------- |
| `cliProvider`            | string | `claude`           | Which agent CLI backend drives cycles — `claude` or `opencode`. Managed via [§2c](#2c-switch-cli-backend) |
| `harnessDir`             | string | `.harness`         | Root directory for all harness files                              |
| `promptsDir`             | string | `.harness/prompts` | Cycle prompt templates                                            |
| `agentsDir`              | string | `.harness/agents`  | Agent role definition files                                       |
| `agents`                 | object | `{}`               | Map of agent name → `{ scope: string[] \| null }`                |
| `devServer`              | object | —                  | Dev server services written by `config dev-server detect`         |
| `authProfiles`           | array  | `[]`               | Named auth profiles captured by `cortex-harness auth`            |
| `smokeUrls`              | array  | `[]`               | Explicit URLs to probe during smoke cycles (merged with detected) |
| `smokeCheckBudgetPerUrl` | number | —                  | Max USD spend per URL during a smoke run                          |
| `smokeCheckTimeoutMs`    | number | `90000` (Claude) / `180000` (OpenCode) | Wall-clock timeout per URL before the smoke-check subprocess is killed. OpenCode's higher default reflects it needing more tool-call turns per page in practice |
| `routeParams`            | object | `{}`               | Concrete values for dynamic route segments during smoke URL scanning — keyed by param name (flat default) or by bracket route pattern (e.g. `"/clients/[id]"`, route-specific override) |
| `mcpScope`               | object | `{}`               | Map of `"*"` / agent name / cycle type → allowed MCP server names. `"*"` applies to every cycle; a server missing from every key here never loads, even if it's in `.mcp.json`. Managed via `cortex-harness config` / `add-mcp-scope` / `remove-mcp-scope` — see [§2a](#2a-manage-mcp-server-scope) |

`scope: null` — agent may read/verify everywhere (tester, explorer).  
`scope: []` — agent is unconstrained; auto-scope update fires after first run.  
Out-of-scope file writes are automatically reverted by git after each implement cycle.

---

## Cycle Reference

| Cycle                   | Type         | What it does                                                                                 | Output file                  |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------- | ---------------------------- |
| `orchestrate`           | planning     | Routes prompt type, decomposes multi-intent tasks, writes `task-queue.json`                  | `orchestrate.json`           |
| `explore`               | discovery    | Maps file structure, naming conventions, component placement                                 | `explore.json`               |
| `plan`                  | planning     | Designs approach, assigns write scopes to each implement cycle                               | `plan.json`                  |
| `reproduce`             | diagnosis    | Reproduces failing behavior; identifies root cause before fix cycles begin                   | `reproduce.json`             |
| `implement-*`           | execution    | Writes source files within declared scope; reverts violations                                | `implement-<surface>.json`   |
| `reconcile`             | verification | Cross-surface contract check, fills gap table, re-delegates gaps                             | `reconcile[-<group>].json`   |
| `reconcile-cross-group` | verification | Multi-intent only — verifies shared contracts across all groups; may inject new cycle groups | `reconcile-cross-group.json` |
| `test`                  | verification | Runs `nx affected --target=build,test,lint`; 25 turns/slice, up to 10 retries                | `test[-<group>].json`        |
| `fix-*`                 | recovery     | Re-delegates broken surface to owning agent with exact error                                 | injected dynamically         |
| `recovery`              | recovery     | Reads prompt-orchestration.md after MAX_RETRIES exhausted; applies chaining                  | injected dynamically         |
| `smoke`                 | verification | Per-URL browser pass via Playwright MCP; on failure injects `fix-*` + smoke-retry up to MAX_RETRIES; exhausted failures → residual risks | `smoke[-<group>].json` |
| `deliver`               | delivery     | Unified summary, PR description, residual risks; smoke failures are residual risks (never `NEEDS_HUMAN_INPUT`) | `deliver.json` |

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
    url-detector.md             ← pre-smoke URL extraction (mini-Claude session, print-only/no Write; falls back to route-scanner)
  prompts-opencode/             ← OpenCode-flavored prompt variants, scaffolded alongside prompts/ — selected when cliProvider is "opencode"
  agents/
    backend-subagent.agent.md   ← scope sections auto-patched by cortex-harness config
    frontend-subagent.agent.md
    distributed-subagent.agent.md
    infra-subagent.agent.md
    tester-subagent.agent.md
    explorer-subagent.agent.md
    planner-subagent.agent.md
  agents-opencode/              ← OpenCode-flavored agent role files, same role set as agents/
  cycle-state/                  ← written at runtime (gitignored)
    skills.json                 ← skill output forwarded to implement cycles
    probe-urls.json             ← pre-smoke URL detection result (urls, dynamicUrls, layoutAffected, framework — dynamicUrls always routeParams-resolved by the engine)
    changed-files.json          ← snapshot diff used by implement/reconcile
    scope-violations.json       ← auto-revert tracking
    smoke-attempt-N[-<group>].json  ← per-attempt smoke snapshot, used to build retry history
    *.json                      ← per-cycle Zod-validated output files (explore, plan, implement, reconcile, test, fix, smoke, ...)
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

## Contributing

Found a bug or want to add something? See [CONTRIBUTING.md](./CONTRIBUTING.md) to get started.

## License

[MIT](./LICENSE)
