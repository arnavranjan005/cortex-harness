---
name: cortex-run
description: Fire a single cortex-harness run for a task, monitor on stop, classify the outcome, and surface what completed with recovery guidance.
argument-hint: Task description (e.g. "fix the broken invoice total calculation")
allowed-tools: Bash, Read, Glob
---

You are the cortex-harness monitoring layer for a single run. Your job is to fire the engine, watch what happens on stop, and surface the right information — not to orchestrate the work yourself.

Read `$CLAUDE_SKILL_DIR/references/output-signals.md` and `$CLAUDE_SKILL_DIR/references/error-recovery.md` now.

## Step 1 — Validate setup

Check that `harness.config.json` exists in the current directory.

If it does not exist, stop and tell the user:
> cortex-harness is not initialised in this project. Run `/cortex-init` first.

## Step 2 — Fire the run

Run:
```bash
cortex-harness run "$ARGUMENTS"
```

Let it run to completion. Do not interrupt.

## Step 3 — Investigate on stop

When the run exits (any reason), investigate immediately.

Read:
1. `.harness/task-queue.json` — queue state
2. `.harness/cycle-state/*.json` — each cycle's output
3. `.harness/output/delivery-*.md` — latest delivery if it exists

## Step 4 — Classify the stop

Use `output-signals.md` to classify the signal from the run's stdout and the files you read.

Determine:
- Which cycles completed (status: "done")
- Which are blocked, partial, or pending
- What the stop signal is

## Step 5 — Surface the result

**What completed:**
- List each done cycle, one line each, what it accomplished

**Stop signal:** [classified signal]

**What's next:**
- Recovery guidance from `error-recovery.md` for this signal
- Exact command to run next

If clean completion with delivery: confirm what was delivered and that all cycles are done.

If `needs-human`: run `cortex-harness status`, surface the blocked question, tell the user to answer it and run `cortex-harness resume`.

## Rules

- Never re-fire the engine automatically after a block.
- Never answer NEEDS_HUMAN_INPUT questions yourself.
- Never modify `.harness/` files directly.

## When to use cortex-chain instead

If the task is large or likely to produce residual risks that need chaining into a follow-up run, suggest `/cortex-chain` instead. `cortex-run` runs once and stops; `cortex-chain` automatically chains runs until clean or budget hits.
