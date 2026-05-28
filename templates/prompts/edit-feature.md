---
description: Edit or extend an existing feature in this Nx workspace. Use when behavior needs to change, a flow needs adjustment, or requirements have evolved — but nothing is broken.
argument-hint: '[what to change and why, current behavior, desired behavior]'
---

# Edit Feature Command

You are the orchestrator for modifying existing features in this Nx workspace.

Your job is to understand the current behavior, define the minimal change needed, delegate targeted edits to the correct sub-agents, and verify that both the new behavior works and the existing behavior is preserved.

> Permanent rules — routing table, sub-agent prompt checklist, reconciliation protocol, security guardrails, and architecture constraints — are defined in `CLAUDE.md`. Follow them exactly. This prompt covers execution workflow only.

## ⛔ HARD RULE

**NEVER write production code directly on the main agent.** The main agent plans — sub-agents implement. Every source file edit in `api/`, `worker/`, `serverless/`, `web/`, or `libs/` must be owned by a sub-agent.

The only files the main agent may edit directly: `.harness/`, `CLAUDE.md`.

---

## Context

- **Current Branch:** !`git branch --show-current`
- **Current Commit:** !`git rev-parse --short HEAD`
- **Remote Status:** !`git status -sb | head -1`

## User Request

${input:args}

If the user describes current behavior and desired behavior, treat both as equally important. The goal is to change one without silently breaking the other.

---

## Execution Workflow

### Step 0: Invoke matching skills

Scan the available skills list in the system prompt. For every skill whose trigger matches this task, invoke it via the Skill tool now. Rules for what counts: `CLAUDE.md` → Skills → Skill invocation gate.

**Fill this block before Step 1 — a blank means Step 0 was skipped:**
```
Skills invoked: [list each skill called, or "none available / none matched"]
Output summary: [one line per skill, or "n/a"]
```

### Step 1: Understand the Current Behavior

Before planning any change, follow the **mandatory pre-delegation steps in `CLAUDE.md`** — spawn `explorer-subagent` first, then `planner-subagent` if the feature spans multiple surfaces or shared contracts.

**Do not plan or delegate changes until explorer reports back.**

### Step 2: Define the Change Boundary

Before delegating, answer these explicitly:

- What is the current behavior?
- What is the desired behavior after the edit?
- What must be preserved and must not regress?
- Which files change and which stay untouched?
- Does the change affect a shared contract in `libs/shared/*`? If yes, identify all consumers now — they must all be updated in the same pass.

**Minimal change rule:** change only what is required. Do not refactor, clean up, or improve adjacent code unless the user explicitly asked. Scope creep in edits causes regressions.

### Step 3: Build the Ownership Plan

Define per-agent write scope before spawning anything:

- which sub-agents are needed (routing table in `CLAUDE.md`)
- exact files or directories each agent owns — no overlap
- sequencing: contract owner runs before consumers
- which Nx targets to run per surface

If the edit touches a shared contract, assign one owner. All other agents are read-only on that file — they adapt to the updated version, they do not co-own it.

### Step 4: Delegate Implementation

Spawn implementation sub-agents using the prompt template in `.harness/prompts/implement-feature.md`. Every agent must know:
- what the feature currently does (from Step 1)
- what needs to change and why
- what must NOT change — be explicit
- exact write ownership
- verification command

Run independent agents in parallel when their scopes are disjoint.

### Step 5: Verify New and Existing Behavior

Spawn `Tester` with two explicit goals:
1. **New behavior** — the edited feature behaves as requested
2. **Preserved behavior** — adjacent and downstream behavior that was not supposed to change still works

If tests for the edited path are missing or outdated, the tester must write or update them — not defer to a follow-up.

### Step 6: Reconcile and Deliver

Follow the full orchestrator reconciliation protocol in `CLAUDE.md` — contract check, gap resolution, consistency check, final verification — before delivering.

Gap classification table and mandatory re-delegation log are defined in `CLAUDE.md` step 2 — follow them exactly.

Return a summary with exactly these sections:
- **What changed**: files edited per surface, one line each
- **Behavior delta**: current behavior → new behavior, one sentence
- **Preserved behavior**: what was explicitly verified to still work
- **Checks passed**: Nx targets run and their result
- **Tests written or updated**: coverage added or changed
- **Residual risks**: anything still open, unverified, or requiring human decision

---

## Routing Guidance

| Edit type | Sub-agents to use |
|---|---|
| UI copy, style, layout only | `Frontend` only |
| API response shape or validation change | `Backend` + `Frontend` if UI consumes it |
| Queue payload or job behavior change | `Distributed` + `Backend` |
| Shared type or Zod schema change | one owner, all consumers updated |
| Multi-surface behavior change | `Planner` first, then implementation agents |
