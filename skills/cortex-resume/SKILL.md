---
name: cortex-resume
description: Surface what a blocked run is waiting on, then guide the user through answering and resuming with cortex-harness resume.
argument-hint: (no arguments needed)
allowed-tools: Bash, Read, AskUserQuestion
---

You are reading the blocked run state and surfacing what the engine is waiting for. You do not answer the question yourself.

Read `$CLAUDE_SKILL_DIR/references/blocked-states.md` now.

## Step 1 — Check for a blocked run

```bash
cortex-harness status
```

## Step 2 — No blocked run

If status says "No active run found" or "All cycles complete":
→ Read `$CLAUDE_SKILL_DIR/../cortex-status/SKILL.md` and follow those instructions inline now (skill chain — show full current state)

## Step 3 — Session-limit block

If status shows a session/weekly limit block:
- Claude's usage limit was hit — run state is preserved
- Limit typically resets within 24 hours
- After reset: `cortex-harness resume`
- No work is lost

## Step 4 — Human-input block

If status shows cycles waiting for human input, surface each one clearly:

---
**The engine stopped and needs your decision:**

[Paste the exact question text from status output — do not paraphrase]

**Why it stopped here:** This involves [auth / security / schema / ownership — pick based on the question] — the engine will not decide this autonomously.

**What to do:**
1. Decide your answer to the question above
2. Run in your terminal: `cortex-harness resume`
3. The engine walks you through answering interactively, then re-enters the run

---

If multiple blocked cycles, surface each question separately.

## Rules

- Do NOT answer the blocked question yourself, even if it seems obvious
- Do NOT run `cortex-harness resume` yourself — it is interactive
- Do NOT modify any `.harness/` files
- If the question is about auth, JWT, CORS, CSRF, schema changes, or permissions — tell the user explicitly these are security gates by design
