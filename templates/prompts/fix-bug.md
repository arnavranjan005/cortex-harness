---
description: Fix a bug in this Nx workspace through reproduce-first, root-cause-driven delegation. Use when something is broken, behaving incorrectly, or throwing errors in production or tests.
argument-hint: '[bug description, error message, or failing behavior]'
---

# Fix Bug Command

You are the orchestrator for diagnosing and fixing bugs in this Nx workspace.

Your job is to reproduce the failure, identify the root cause, delegate a minimal targeted fix, and verify the fix without introducing regressions.

> Permanent rules — routing table, sub-agent prompt checklist, reconciliation protocol, security guardrails, and architecture constraints — are defined in `CLAUDE.md`. Follow them exactly. This prompt covers execution workflow only.

## ⛔ HARD RULE

**NEVER write production code directly on the main agent.** The main agent diagnoses — sub-agents fix. Every source file edit in `api/`, `worker/`, `serverless/`, `web/`, or `libs/` must be owned by a sub-agent.

The only files the main agent may edit directly: `.harness/`, `CLAUDE.md`.

---

## Context

- **Current Branch:** !`git branch --show-current`
- **Current Commit:** !`git rev-parse --short HEAD`
- **Remote Status:** !`git status -sb | head -1`

## User Report

${input:args}

If the user provides error messages, stack traces, or reproduction steps, treat them as the primary signal. Do not reinterpret unless clearly incomplete.

---

## Execution Workflow

### Step 0: Invoke matching skills

Scan the available skills list in the system prompt. For every skill whose trigger matches this task, invoke it via the Skill tool now. Rules for what counts: `CLAUDE.md` → Skills → Skill invocation gate.

**Fill this block before Step 1 — a blank means Step 0 was skipped:**
```
Skills invoked: [list each skill called, or "none available / none matched"]
Output summary: [one line per skill, or "n/a"]
```

### Step 1: Reproduce the Failure

Before delegating any fix, run these checks in order — stop at the first one that surfaces the error:

**1a. Typecheck first** — run `npm exec nx run <affected-surface>:typecheck`. Prisma query errors, wrong API shapes, and TS mismatches appear immediately without a running server. If typecheck fails, that IS the root cause — skip to Step 2.

**1b. Run existing tests** — run `npm exec nx affected --target=test,e2e`. A failing test pinpoints the broken path faster than static analysis.

**1c. Ask for the runtime signal** — if 1a and 1b pass but the bug is visible in the UI or network tab, ask the user to paste the actual API response or browser error before doing any further exploration. Do not guess at runtime failures from static analysis alone.

**1d. Spawn Explorer if still unclear** — only after 1a–1c, spawn `explorer-subagent` to locate the failing code path and confirm the incorrect behavior.

**Do not proceed to Step 2 until the failure is confirmed** or you have a clear explanation for why it cannot be reproduced (e.g. environment-only failure, missing seed data).

If reproduction is blocked — say so explicitly and stop. Do not guess at a fix.

### Step 2: Root Cause Analysis

Once the failure is located, determine the root cause before writing anything.

Ask yourself (or spawn `Explorer` if the codepath is unclear):
- Is this a logic error, type mismatch, missing Zod validation, race condition, or contract mismatch?
- Is the bug isolated or does it reflect a broader misalignment (e.g. producer/consumer shape mismatch)?
- Is there a test that should have caught this but didn't?

**Write the root cause in one sentence before proceeding.** If you cannot identify it, stop and ask the user — do not guess.

### Step 3: Plan the Minimal Fix

Define the smallest change that corrects the root cause without touching unrelated code.

Before delegating:
- identify the exact files that need to change
- confirm the owning sub-agent for each (routing table in `CLAUDE.md`)
- list what must NOT change
- if a shared contract (`libs/shared/schema` or `libs/shared/types`) is involved, all consumers must be updated in the same pass — identify them now

If the fix touches more than two surfaces, assign a single contract owner before delegating consumers.

### Step 4: Delegate the Fix

Before delegating, follow the **mandatory pre-delegation steps in `CLAUDE.md`**: if explorer was not spawned in Step 1d, spawn it now to confirm the fix scope and check for adjacent impact — even when the root cause is confirmed.

Spawn the owning sub-agent(s) using the prompt template in `.harness/prompts/implement-feature.md` with:
- the confirmed root cause (one sentence)
- exact files to change
- what correct behavior looks like after the fix
- explicit list of what NOT to touch
- verification command

**Do not ask the sub-agent to investigate — you already did that.** Give it a diagnosis and a clear target.

Run independent fix agents in parallel only when their scopes are disjoint and the fixes are causally independent.

### Step 5: Test Coverage and Regression Check

After the fix is applied, spawn `tester-subagent` with three explicit goals:

1. **Fix confirmed** — the original failing behavior is now resolved
2. **No regression** — the adjacent behavior most likely to break still works
3. **Coverage** — tests must exist for the fixed code path. If they do not exist, write them now — unit, integration, or e2e, whichever fits the behavior. Do not defer this. Specifically:
   - Backend fix (controller/service/queue) → unit or integration test
   - UI fix (page/component) → e2e test covering the affected user flow
   - Shared contract fix → tests on both producer and consumer sides

**A bug fix is not complete until the path that was broken has a test that would have caught it.**

### Step 6: Reconcile and Deliver

Follow the full orchestrator reconciliation protocol in `CLAUDE.md` — contract check, gap resolution, consistency check, final verification — before delivering.

Gap classification table and mandatory re-delegation log are defined in `CLAUDE.md` step 2 — follow them exactly.

Return a summary with exactly these sections:
- **Root cause**: one sentence
- **What changed**: files edited, one line each
- **Checks passed**: Nx targets run and their result (must include typecheck + test/e2e)
- **Tests written**: new tests added — file, test name, type (unit/integration/e2e). If none written, explain why existing coverage was sufficient.
- **Regression coverage**: what adjacent behavior was verified
- **Residual risks**: anything still open or unverified
