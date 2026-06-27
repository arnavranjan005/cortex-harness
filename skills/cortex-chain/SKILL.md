---
name: cortex-chain
description: Fire the cortex-harness chain engine for a task, monitor on every stop, classify the stop reason, and surface what completed with specific recovery guidance.
argument-hint: Task description (e.g. "add invoice PDF export with email delivery")
allowed-tools: Bash, Read, Glob, AskUserQuestion
---

You are the cortex-harness monitoring layer. Fire the engine, watch what happens on every stop, surface the right information — do not orchestrate the work yourself.

Read `$CLAUDE_SKILL_DIR/references/chain-signals.md` and `$CLAUDE_SKILL_DIR/references/error-recovery.md` now.

## Step 1 — Validate setup

```bash
test -f harness.config.json && echo "EXISTS" || echo "MISSING"
```

**If MISSING** → Read `$CLAUDE_SKILL_DIR/../cortex-init/SKILL.md` and follow those instructions inline now (skill chain — must initialise first)

## Step 2 — Fire the chain

```bash
cortex-harness chain "$ARGUMENTS" --max-runs 3 --budget 60
```

If $ARGUMENTS is empty, seed from last delivery:
```bash
cortex-harness chain --max-runs 3 --budget 60
```

Let it run to completion. Do not interrupt.

## Step 3 — Investigate on stop

Read in order:
1. `.harness/task-queue.json`
2. `.harness/cycle-state/*.json`
3. `.harness/output/delivery-*.md` (latest, sort by name)

## Step 4 — Classify the stop

Use `chain-signals.md` to classify: complete, needs-human, session-limit, billing-error, budget-exhausted, max-runs, no-delivery, exit-nonzero.

## Step 5 — Surface the result

**What completed:** each done cycle, one line, what it did.
**Stop reason:** [classified signal]
**What's next:** specific recovery guidance from `error-recovery.md`.

## Step 6 — Chain based on stop reason

**If stop = needs-human:**
→ Read `$CLAUDE_SKILL_DIR/../cortex-resume/SKILL.md` and follow those instructions inline now (skill chain)

**If stop = budget-exhausted or max-runs AND pending cycles or residual risks exist:**
Use AskUserQuestion:
- "The chain hit its limit but work is still pending. Continue?"
  - "Yes — continue the chain" → Read `$CLAUDE_SKILL_DIR/../cortex-continue/SKILL.md` and follow those instructions inline now (skill chain)
  - "No — I'll review and decide later"

**If stop = complete, all cycles done:** confirm clean delivery. Done.

**If stop = billing-error or session-limit:** surface the block, tell the user to resolve it, then run `cortex-harness resume`. Do NOT chain automatically.

## Rules

- Never re-fire the engine automatically after a block. The user decides.
- Never answer NEEDS_HUMAN_INPUT questions yourself.
- Never modify `.harness/` files directly.
- If a cycle's JSON is missing or unparseable, note it and continue — don't abort the investigation.
