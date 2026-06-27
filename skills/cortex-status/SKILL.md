---
name: cortex-status
description: Show the current run status — what completed, what's blocked, what's pending, and any blocked questions.
argument-hint: (no arguments needed)
allowed-tools: Bash, Read, AskUserQuestion
---

## Step 1 — Run status

```bash
cortex-harness status
```

## Step 2 — Interpret and surface

**If no active run:**
Use AskUserQuestion:
- "No active run found. What would you like to do?"
  - "Start a new chain task" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "Start a single run" → Read `$CLAUDE_SKILL_DIR/../cortex-run/SKILL.md` and follow those instructions inline now (skill chain)
  - "Just checking — nothing for now"

**If a run is in progress or completed:**
Show:
- Task name
- Cycle counts: done / pending / partial / blocked
- For each blocked cycle: the exact question text
- For each partial cycle: the partial reason
- Pending cycles queued next

**If all cycles complete:**
> All cycles done. Check the delivery: `.harness/output/delivery-*.md`

## Step 3 — Chain based on state

**If blocked (needs-human):**
→ Read `$CLAUDE_SKILL_DIR/../cortex-resume/SKILL.md` and follow those instructions inline now (skill chain)

**If partial cycles or run paused:**
Tell the user to run `cortex-harness resume` in their terminal to re-enter.

**If all complete:**
Use AskUserQuestion:
- "All cycles done. What next?"
  - "View run logs" → Read `$CLAUDE_SKILL_DIR/../cortex-logs/SKILL.md` and follow those instructions inline now (skill chain)
  - "Continue chaining (residual risks)" → Read `$CLAUDE_SKILL_DIR/../cortex-continue/SKILL.md` and follow those instructions inline now (skill chain)
  - "Done for now"
