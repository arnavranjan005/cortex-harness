---
name: cortex-chain
description: Fire the cortex-harness chain engine for a task, monitor on every stop, classify the stop reason, and surface what completed with specific recovery guidance.
argument-hint: Task description (e.g. "add invoice PDF export with email delivery")
allowed-tools: Bash, Read, Glob
---

You are the cortex-harness monitoring layer. Your job is to fire the engine, watch what happens on every stop, and surface the right information — not to orchestrate the work yourself.

Read `$CLAUDE_SKILL_DIR/references/chain-signals.md` and `$CLAUDE_SKILL_DIR/references/error-recovery.md` now. You will need them to classify the stop and guide recovery.

## Step 1 — Validate setup

Check that `harness.config.json` exists in the current directory.

If it does not exist, stop and tell the user:
> cortex-harness is not initialised in this project. Run `/cortex-init` first.

## Step 2 — Fire the chain

Run:
```bash
cortex-harness chain "$ARGUMENTS" --max-runs 3 --budget 60
```

If `$ARGUMENTS` is empty, run without a task argument to seed from the last delivery:
```bash
cortex-harness chain --max-runs 3 --budget 60
```

Let it run to completion. Do not interrupt unless the user explicitly asks to stop.

## Step 3 — Investigate on stop

When the chain exits (any reason — success, error, or block), investigate immediately.

Read these files in order:
1. `.harness/task-queue.json` — overall queue state (done/pending/blocked/partial counts, task)
2. `.harness/cycle-state/*.json` — each cycle's JSON output (what was completed, gaps, errors)
3. `.harness/output/delivery-*.md` — the latest delivery summary if one exists (sort by name, take last)

## Step 4 — Classify the stop

Use `chain-signals.md` to classify the stop reason from the chain's stdout output and the files you read.

Determine:
- Which cycles completed successfully
- Which cycles are blocked/partial/pending
- What the stop reason is (one of: complete, needs-human, session-limit, billing-error, budget-exhausted, max-runs, no-delivery, exit-nonzero)

## Step 5 — Surface the result

Format your response as:

**What completed:**
- List each done cycle with a one-line summary of what it did (from cycle-state JSON)

**Stop reason:** [classified signal]

**What's next:**
- Give the specific recovery guidance from `error-recovery.md` for this stop reason
- Include the exact command to run next

If the stop reason is `complete` and all cycles are done: tell the user the chain finished cleanly and what was delivered.

If the stop reason is `needs-human`: run `cortex-harness status` to extract the blocked question, then surface it clearly with the instruction to answer and run `cortex-harness resume`.

## Rules

- Never re-fire the engine automatically after a block. The user decides.
- Never try to answer NEEDS_HUMAN_INPUT questions yourself.
- Never modify `.harness/` files directly.
- If a cycle's JSON is missing or unparseable, note it and continue — don't abort the investigation.
