---
name: cortex-status
description: Show the current run status — what completed, what's blocked, what's pending, and any blocked questions.
argument-hint: (no arguments needed)
allowed-tools: Bash, Read
---

## Step 1 — Run status

```bash
cortex-harness status
```

## Step 2 — Interpret and surface

Read the status output and surface it as a clear summary:

**If no active run:**
> No active run. Start one with `/cortex-run "task"` or `/cortex-chain "task"`.

**If a run is in progress or completed:**

Show:
- Task name
- Cycle counts: done / pending / partial / blocked
- For each blocked cycle: the question text and `cortex-harness resume` instruction
- For each partial cycle: the partial reason if available
- Pending cycles list (what's queued next)

**If all cycles complete:**
> All cycles done. Check the delivery: `.harness/output/delivery-*.md`

## Step 3 — Suggest next action

Based on the status, suggest exactly one next action:
- Blocked (needs-human) → `cortex-harness resume` after the user answers
- Blocked (session-limit) → wait for limit reset, then `cortex-harness resume`
- Partial cycles → `cortex-harness resume` to re-enter
- All pending, no blocked → run is paused mid-queue (unusual) → `cortex-harness run` to restart
- All complete → review delivery or start new task
