---
name: cortex-logs
description: Show run logs in a readable format — cycle starts/ends, tool calls, costs, errors.
argument-hint: Optional run timestamp to view a specific run (e.g. "2026-06-26T02-14-33")
allowed-tools: Bash
---

## Step 1 — Show logs

If `$ARGUMENTS` is empty, show the most recent run:
```bash
cortex-harness logs
```

If `$ARGUMENTS` contains a timestamp, show that specific run:
```bash
cortex-harness logs --run "$ARGUMENTS"
```

## Step 2 — Interpret key events

After showing the raw log output, highlight:

**Cost summary:** Find `RUN END` events — report total spend for this run.

**Cycles that ran:** List each `CYCLE START` / `CYCLE END` pair with the cycle ID and outcome (✓ done, ⊘ blocked, ~ partial).

**Errors or failures:** Surface any `FATAL`, `ERROR`, or rate-limit events.

**Hung cycles:** If any cycle started but has no matching `CYCLE END`, flag it as potentially hung.

## Step 3 — Suggest action if errors found

If the log shows failures or errors, suggest:
- `cortex-harness status` — see current queue state
- `cortex-harness resume` — re-enter if cycles are blocked/partial
- `/cortex-chain "task"` — start fresh if the run is unrecoverable

## Listing available runs

If the user wants to see all available runs (to pick a specific one), run:
```bash
cortex-harness logs
```
The command lists available run timestamps when no matching run is found. You can also list `.harness/runs/*.jsonl` directly.
