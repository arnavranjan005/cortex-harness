---
name: cortex-continue
description: Continue the chain from the last delivery — extracts residual risks and chains the next run automatically.
argument-hint: (no arguments — seeds task from last delivery automatically)
allowed-tools: Bash, Read, Glob
---

You are continuing a cortex-harness chain from where it last stopped. The engine will read the last delivery, extract residual risks, and start the next run automatically.

## Step 1 — Check for a previous delivery

Check that `.harness/output/` contains a delivery file:
```bash
cortex-harness status
```

If there is no active run and no delivery, tell the user:
> No previous delivery found. Start a new run with `/cortex-chain "your task"` or `/cortex-run "your task"`.

## Step 2 — Continue the chain

Run without a task argument — the engine seeds from the last delivery:
```bash
cortex-harness chain --max-runs 3 --budget 60
```

The engine will:
1. Read the latest delivery file
2. Ask an LLM whether chaining is needed (if residual risks exist → yes, if clean → stops)
3. Extract the next task from residual risks
4. Run that task as the next chain run

## Step 3 — Investigate on stop

When the chain exits, investigate:

Read:
1. `.harness/task-queue.json`
2. `.harness/cycle-state/*.json`
3. `.harness/output/delivery-*.md` (latest)

Surface what completed and the stop reason, using the same classification as `/cortex-chain`:
- If clean: "Chain finished — no residual risks remaining."
- If blocked: surface the block reason and recovery command
- If budget/max-runs: tell the user and suggest next step

## When the engine says "Nothing to chain"

If the engine prints "No actionable residual risks in last delivery — nothing to chain", tell the user:
> The last delivery had no residual risks. The work is complete. If you have a new task, use `/cortex-chain "new task"`.
