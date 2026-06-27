---
name: cortex-logs
description: Show run logs in a readable format — cycle starts/ends, tool calls, costs, errors.
argument-hint: Optional run timestamp to view a specific run (e.g. "2026-06-26T02-14-33")
allowed-tools: Bash, AskUserQuestion
---

## Step 1 — Show logs

If $ARGUMENTS is empty, show most recent run:
```bash
cortex-harness logs
```

If $ARGUMENTS contains a timestamp:
```bash
cortex-harness logs --run "$ARGUMENTS"
```

## Step 2 — Interpret key events

**Cost summary:** Find `RUN END` events — report total spend.

**Cycles that ran:** List each `CYCLE START` / `CYCLE END` pair with cycle ID and outcome (✓ done, ⊘ blocked, ~ partial).

**Errors or failures:** Surface any `FATAL`, `ERROR`, or rate-limit events.

**Hung cycles:** Flag any cycle with a `CYCLE START` but no matching `CYCLE END`.

## Step 3 — Chain based on what's found

**If errors, failures, or hung cycles found:**
Use AskUserQuestion:
- "Errors found in the logs. What would you like to do?"
  - "Check current status" → Read `$CLAUDE_SKILL_DIR/../cortex-status/SKILL.md` and follow those instructions inline now (skill chain)
  - "Start a fresh chain task" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "Just reviewing — nothing for now"

**If logs look clean (no errors):**
Use AskUserQuestion:
- "Logs look clean. What next?"
  - "Continue chaining" → Read `$CLAUDE_SKILL_DIR/../cortex-continue/SKILL.md` and follow those instructions inline now (skill chain)
  - "Start a new task" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "Done for now"
