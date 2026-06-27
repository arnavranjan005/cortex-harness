---
name: cortex-continue
description: Continue the chain from the last delivery — extracts residual risks and chains the next run automatically.
argument-hint: (no arguments — seeds task from last delivery automatically)
allowed-tools: Bash, Read, Glob, AskUserQuestion
---

You are continuing a cortex-harness chain from where it last stopped.

## Step 1 — Check for a previous delivery

```bash
cortex-harness status
```

**If no delivery found** → use AskUserQuestion:
- "No previous delivery found. What would you like to do?"
  - "Start a new chain task" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "Cancel"

## Step 2 — Continue the chain

Run without a task argument — seeds from last delivery:
```bash
cortex-harness chain --max-runs 3 --budget 60
```

The engine reads the latest delivery, checks for residual risks, extracts the next task, and runs it.

## Step 3 — Investigate on stop

Read in order:
1. `.harness/task-queue.json`
2. `.harness/cycle-state/*.json`
3. `.harness/output/delivery-*.md` (latest)

## Step 4 — Classify and surface

Surface what completed and the stop reason (same classification as cortex-chain).

## Step 5 — Chain based on stop reason

**If stop = needs-human:**
→ Read `$CLAUDE_SKILL_DIR/../cortex-resume/SKILL.md` and follow those instructions inline now (skill chain)

**If stop = budget-exhausted or max-runs AND residual risks still exist:**
Use AskUserQuestion:
- "Still have pending work. Keep chaining?"
  - "Yes — continue again" → Read `$CLAUDE_SKILL_DIR/../cortex-continue/SKILL.md` and follow those instructions inline now (self-chain)
  - "No — I'll review first"

**If engine prints "Nothing to chain":**
> The last delivery had no residual risks — work is complete.

Use AskUserQuestion:
- "Chain is complete. What next?"
  - "Start a new task" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "Done for now"
