---
name: cortex-run
description: Fire a single cortex-harness run for a task, monitor on stop, classify the outcome, and surface what completed with recovery guidance.
argument-hint: Task description (e.g. "fix the broken invoice total calculation")
allowed-tools: Bash, Read, Glob, AskUserQuestion
---

You are the cortex-harness monitoring layer for a single run. Fire the engine, watch what happens on stop, surface the right information — do not orchestrate the work yourself.

Read `$CLAUDE_SKILL_DIR/references/output-signals.md` now.

## Step 1 — Validate setup

Check that `harness.config.json` exists:
```bash
test -f harness.config.json && echo "EXISTS" || echo "MISSING"
```

**If MISSING** → Read `$CLAUDE_SKILL_DIR/../cortex-init/SKILL.md` and follow those instructions inline now (skill chain — must initialise first)

## Step 2 — Fire the run

```bash
cortex-harness run "$ARGUMENTS"
```

Let it run to completion. Do not interrupt.

## Step 3 — Investigate on stop

Read in order:
1. `.harness/task-queue.json`
2. `.harness/cycle-state/*.json`
3. `.harness/output/delivery-*.md` (latest)

## Step 4 — Classify the stop

Use `output-signals.md` to classify the stop signal.

## Step 5 — Surface the result

**What completed:** list each done cycle, one line, what it accomplished.
**Stop signal:** [classified signal]
**What's next:** recovery guidance for this signal.

## Step 6 — Chain based on stop reason

**If stop = needs-human:**
→ Read `$CLAUDE_SKILL_DIR/../cortex-resume/SKILL.md` and follow those instructions inline now (skill chain)

**If stop = partial/budget-exhausted AND residual risks exist:**
Use AskUserQuestion:
- "There are residual risks. Continue with cortex-chain?"
  - "Yes — continue the chain" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "No — I'll review and decide later"

**If stop = complete, no residual risks:** confirm clean delivery. Done.

## Rules

- Never re-fire the engine automatically after a block
- Never answer NEEDS_HUMAN_INPUT questions yourself
- Never modify `.harness/` files directly
