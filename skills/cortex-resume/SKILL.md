---
name: cortex-resume
description: Surface what a blocked run is waiting on, then guide the user through answering and resuming with cortex-harness resume.
argument-hint: (no arguments needed)
allowed-tools: Bash, Read
---

You are reading the blocked run state and surfacing what the engine is waiting for. You do not answer the question yourself.

Read `$CLAUDE_SKILL_DIR/references/blocked-states.md` now.

## Step 1 — Check for a blocked run

Run:
```bash
cortex-harness status
```

Read the output carefully.

## Step 2 — No blocked run

If the status output says "No active run found" or "All cycles complete", tell the user:
> No blocked run found. Start a new run with `/cortex-run` or `/cortex-chain`.

## Step 3 — Session-limit block

If the status output shows a session/weekly limit block:

Tell the user:
- Claude's usage limit was hit — the run state is preserved
- The limit typically resets within 24 hours
- After it resets, resume with: `cortex-harness resume`
- No work is lost

## Step 4 — Human-input block

If the status output shows one or more cycles waiting for human input, surface each one clearly:

---
**The engine stopped and needs your decision:**

[Paste the question text from status output here — do not paraphrase it]

**Why the engine stopped here:** This is a decision the engine will not make autonomously — it involves [auth/security/schema/ownership — pick the right one based on the question].

**What to do:**
1. Decide your answer to the question above
2. Run in your terminal: `cortex-harness resume`
3. The engine will walk you through answering interactively, then re-enter the run

---

If there are multiple blocked cycles, surface each question separately.

## Rules

- Do NOT answer the blocked question yourself, even if it seems obvious.
- Do NOT run `cortex-harness resume` yourself — that command collects answers interactively and cannot be driven by Claude.
- Do NOT modify any `.harness/` files.
- If the question is about auth, JWT, CORS, CSRF, schema changes, or permissions — these are security gates by design. Tell the user that explicitly.
