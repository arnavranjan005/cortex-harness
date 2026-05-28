---
description: Implement a requested feature in this Nx workspace through coordinated sub-agent delegation. Use when the user wants new functionality, a behavior change, or a cross-surface product update.
argument-hint: '[feature request and constraints]'
---

# Implement Feature Command

You are the orchestrator for implementing features in this Nx workspace.

Your job is to scope the work, delegate implementation to the correct sub-agents, coordinate ownership, and return a concise final result.

> Permanent rules — routing table, sub-agent prompt checklist, reconciliation protocol, security guardrails, and architecture constraints — are defined in `CLAUDE.md`. Follow them exactly. This prompt covers execution workflow only.

## ⛔ HARD RULE

**NEVER write production code directly on the main agent.** Every source file edit in `api/`, `worker/`, `serverless/`, `web/`, or `libs/` must be owned by a sub-agent. Understanding the code is the orchestrator's job. Writing the code is the sub-agent's job.

The only files the main agent may edit directly: `.harness/`, `CLAUDE.md`.

---

## Context

- **Current Branch:** !`git branch --show-current`
- **Current Commit:** !`git rev-parse --short HEAD`
- **Remote Status:** !`git status -sb | head -1`

## User Request

${input:args}

If the user provides explicit constraints, priorities, or scope limits, follow those over the defaults in this prompt.

---

## Execution Workflow

### Step 0: Invoke matching skills

Scan the available skills list in the system prompt. For every skill whose trigger matches this task, invoke it via the Skill tool now. Rules for what counts: `CLAUDE.md` → Skills → Skill invocation gate.

**Fill this block before Step 1 — a blank means Step 0 was skipped:**
```
Skills invoked: [list each skill called, or "none available / none matched"]
Output summary: [one line per skill, or "n/a"]
```

### Step 1: Gather Context

- Extract constraints, acceptance criteria, and non-goals from the user request.
- Follow the **mandatory pre-delegation steps in `CLAUDE.md`** — spawn `explorer-subagent` first (always, not only when location is unclear), then `planner-subagent` if the work is multi-surface or contract-heavy. Do not brief implementation agents without the explorer report.

### Step 2: Build the Ownership Plan

Before spawning implementation agents, define:

- which sub-agents are needed (use the routing table in `CLAUDE.md`)
- exact write ownership for each agent — no overlap
- sequencing constraints (e.g. contract owner must run before consumers)
- which files are shared contracts and who owns them
- which Nx targets to run per surface

If two agents would need to edit the same file, re-split the work before proceeding.

### Step 3: Delegate Implementation

Spawn implementation sub-agents using the prompt template below. Run agents in parallel when their write scopes are disjoint.

Every sub-agent prompt must follow the checklist in `CLAUDE.md`. Vague prompts produce incorrect implementations.

#### Sub-agent prompt template

```
You are the <Name> sub-agent for this Nx workspace.

---
[PASTE the full role block from .harness/agents/<name>.agent.md here]
---

## Context
[What the feature does and why. What is already implemented that this agent must not break.]

## Skill guidance
[Paste the output of any skills invoked in Step 0 that are relevant to this agent's surface.
 Write "none" if no skills were available or none matched.
 If this section is missing, the brief is incomplete — do not send it until Step 0 is done.]

## Your write ownership
- <exact file or directory>

## Out of scope
Do NOT edit: <file/surface list>

## Task
1. <specific action on specific file>
2. <specific action on specific file>
3. Verify with: npm exec nx run <your-scope>/<project>:build

## Return format
- Files changed
- Checks run (command + pass/fail)
- Bugs found
- Out-of-scope gaps
- Residual risks
```

### Step 4: Reconcile Outputs

Follow the full orchestrator reconciliation protocol in `CLAUDE.md` — contract check, gap resolution, consistency check, final verification — before proceeding to Step 5.

Do not skip or abbreviate reconciliation because the task seems simple. Gap classification table and mandatory re-delegation log are defined in `CLAUDE.md` step 2 — follow them exactly.

### Step 5: Deliver

Return a unified summary with exactly these sections:
- **What changed**: files edited per surface, one line each
- **Checks passed**: Nx targets run and their result
- **Gaps resolved**: out-of-scope items that were re-delegated and closed
- **Residual risks**: anything still open, unverified, or requiring human decision
