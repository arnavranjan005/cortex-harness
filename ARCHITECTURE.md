# Cortex — Engine Architecture

This document covers the internal mechanics of `src/run-autonomous.mjs` for contributors and anyone who wants to understand how the harness actually works.

---

## Overview

Cortex runs a deterministic state machine driven by a **task queue**. Every cycle runs inside a subprocess (`claude -p`), emits exactly one signal, and writes a Zod-validated JSON output file. The outer loop reads signals and advances the queue.

---

## Task Queue

The `orchestrate` cycle writes `task-queue.json` — a manifest that defines every downstream cycle, its type, the owning agent, its output file, and whether it may run in parallel. The main loop consumes this file one batch at a time. Nothing after `orchestrate` is hardcoded.

```json
{
  "task": "add payments page",
  "promptType": "implement-feature",
  "cycles": [
    { "id": "explore",            "type": "explore",   "status": "pending", "parallel": false },
    { "id": "implement-backend",  "type": "implement", "status": "pending", "parallel": true,
      "agent": "backend-subagent" },
    { "id": "implement-frontend", "type": "implement", "status": "pending", "parallel": true,
      "agent": "frontend-subagent" },
    { "id": "reconcile",          "type": "reconcile", "status": "pending", "parallel": false },
    { "id": "test",               "type": "test",      "status": "pending", "parallel": false },
    { "id": "deliver",            "type": "deliver",   "status": "pending", "parallel": false }
  ]
}
```

---

## Main Execution Loop

```
while (queue has pending cycles):
  batch   ← nextCycleBatch()            // collect consecutive parallel=true cycles
  results ← Promise.allSettled(runCycle × batch)
  for each result:
    signal = extract signal from output
    update cycle status in queue
    CYCLE_COMPLETE      → advance queue
    CYCLE_PARTIAL       → retry or inject fix cycles (see below)
    NEEDS_HUMAN_INPUT   → stop, surface block to user
  check budget: remaining ≤ $0.10 → stop loop
```

Parallel batches are validated before execution via `safeToParallelize()` — if two parallel cycles have overlapping declared file-path scopes (per `harness.config.json`), they are serialized automatically rather than failing.

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

---

## Fix Injection & Recovery

```
test fails
  ↓
inject fix-<surface>-attempt-1    (re-delegate to owning agent with exact error)
inject test-retry-1
  ↓ still failing
inject fix-<surface>-attempt-2
inject test-retry-2
  ↓ MAX_RETRIES (2) exhausted
inject recovery cycle             (reads prompt-orchestration.md, applies chaining rules)
  ↓
deliver                           (with residual risks noted)
```

Fix cycles carry the exact error output from the preceding test run. Each retry targets the agent that owns the broken surface per the routing table.

---

## Session Persistence & Logging

**Autonomous resume** is driven by `task-queue.json` — the outer loop checks whether cycles with `pending` or `partial` status remain and picks up from the first incomplete one. No separate "session check" cycle runs; the harness does this itself before spawning anything.

`session.json` is a separate audit trail: the harness writes each cycle outcome (`done` / `partial` / `blocked`) there for interactive sessions. When a human runs `cortex-harness resume` from the CLI, `session.json` is what surfaces unfinished work in the conversation — it does not drive the autonomous loop.

Every subprocess event — text deltas, tool calls, cost data, results — is appended as newline-delimited JSON to `.harness/runs/<timestamp>.jsonl`, providing a full audit trail of every run.

---

## Windows Spawning

On Windows, Cortex avoids shell quote-handling issues with long prompts by:

1. Writing the full cycle prompt to a UTF-8 `.txt` temp file
2. Generating a `.ps1` wrapper script that reads and passes the file
3. Spawning `powershell.exe` to execute the wrapper
