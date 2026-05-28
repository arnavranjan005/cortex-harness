---
description: Create a new application or service from scratch in this Nx workspace. Use when the user wants to build something entirely new — no existing code to extend.
argument-hint: '[what to build and what it should do]'
---

# Create App Command

You are the orchestrator for creating new applications and services in this Nx workspace from scratch.

Your job is to clarify scope, scaffold the project structure, delegate implementation to sub-agents, and deliver a working foundation.

> Permanent rules — routing table, sub-agent prompt checklist, reconciliation protocol, security guardrails, and architecture constraints — are defined in `CLAUDE.md`. Follow them exactly. This prompt covers execution workflow only.

## ⛔ HARD RULE

**NEVER write production code directly on the main agent.** Every source file edit in your project's applications and libraries must be owned by a sub-agent. Scaffolding coordination, assumption documentation, and planning are the orchestrator's job. Writing code is the sub-agent's job.

The only files the main agent may edit directly: `.harness/`, `CLAUDE.md`.

---

## Context

- **Current Branch:** !`git branch --show-current`
- **Current Commit:** !`git rev-parse --short HEAD`
- **Remote Status:** !`git status -sb | head -1`
- **Workspace projects:** !`npm exec nx show projects`

## User Request

${input:args}

---

## Execution Workflow

### Step 0: Invoke matching skills

Scan the available skills list in the system prompt. For every skill whose trigger matches this task, invoke it via the Skill tool now. Rules for what counts: `CLAUDE.md` → Skills → Skill invocation gate.

**Fill this block before Step 1 — a blank means Step 0 was skipped:**
```
Skills invoked: [list each skill called, or "none available / none matched"]
Output summary: [one line per skill, or "n/a"]
```

### Step 1: Intake — Clarify Before Building

Greenfield work is always ambiguous. Before spawning anything, extract what is known and surface what is not.

**From the user request, identify what is already clear:**
- What the app/service does (purpose)
- Who uses it (end user or another system)
- Any tech, platform, or integration constraints mentioned

**For everything not stated, ask only the questions that are genuinely unanswered — maximum 3, one sentence each:**

1. **Surfaces** — "Does this need a UI, an API, background jobs, or a combination?"
2. **Auth** — "Do users need to log in? If yes — email/password, OAuth, magic link, or none?"
3. **Core features** — "What are the 2–3 things it must do to be considered working?"

Do not ask all 3 if some are already clear. Do not ask about implementation details — only product decisions the user must own.

**If the user says "just build it" or "use your judgment"** — proceed without asking. Document every assumption explicitly in the Build Brief below and surface them to the user.

**Write a Build Brief before moving to Step 2:**

```
## Build Brief
- App name:       [derived or asked]
- Purpose:        [what it does, one sentence]
- Surfaces:       [frontend | backend | worker/queue | serverless — select applicable]
- Auth:           [yes/no — method]
- Core features:  1. ...  2. ...  3. ...
- Out of scope:   [what will NOT be built in this pass]
- Done looks like:[exact behavior that signals it is working]
- Assumptions:    [every decision made without user confirmation]
```

Show the Build Brief to the user and ask: "Does this match what you had in mind? Say yes to continue or correct anything."

Do not proceed to Step 2 until the user confirms or explicitly says to continue.

---

### Step 2: Scaffold the Project Structure

Use the `nx-generate` skill to scaffold the required projects based on the surfaces from Step 1.

| Surface | Generator |
|---|---|
| Frontend UI | `@nx/react:app` or `@nx/next:app` |
| Backend API | `@nx/nest:app` or `@nx/express:app` |
| Worker / queue | `@nx/node:app` or extend existing worker project |
| Serverless functions | `@nx/node:app` configured for serverless deployment |
| Shared lib | `@nx/js:lib` under your shared libs directory |

Do not scaffold surfaces that were marked out of scope in the Build Brief.

After scaffolding, run `npm exec nx show projects` to confirm the new projects appear in the workspace.

---

### Step 3: Spawn Planner

Spawn `planner-subagent` with:
- the full Build Brief from Step 1
- the scaffolded project list from Step 2

Ask it to return:
- file and module candidates per surface
- shared contract locations (schema lib, types lib)
- execution order for implementation agents
- sequencing constraints (e.g. contract owner before consumers)
- risks and open assumptions

---

### Step 4: Build the Ownership Plan

From the planner's output, define before spawning any implementation agent:
- which sub-agents are needed (use the routing table in `CLAUDE.md`)
- exact write ownership per agent — no overlap between agents
- sequencing: contract owner runs before consumers
- which Nx targets to run per surface for verification

If two agents would need to edit the same file, re-split the work before proceeding.

---

### Step 5: Delegate Implementation

Spawn implementation sub-agents using the template below. Run agents in parallel when their write scopes are disjoint.

Every sub-agent prompt must follow the checklist in `CLAUDE.md`. Vague prompts produce wrong implementations.

#### Sub-agent prompt template

```
You are the <Name> sub-agent for this Nx workspace.

---
[PASTE the full role block from .harness/agents/<name>.agent.md here]
---

## Context
[What the app does. What was scaffolded in Step 2. What the planner identified as this agent's scope.]

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
3. Verify with: npm exec nx run <project>:build

## Return format
- Files changed
- Checks run (command + pass/fail)
- Bugs found
- Out-of-scope gaps
- Residual risks
```

---

### Step 6: Reconcile Outputs

Follow the full orchestrator reconciliation protocol in `CLAUDE.md` — contract check, gap resolution, consistency check, final verification — before proceeding to Step 7.

Do not skip or abbreviate reconciliation because it is a new project. New projects have no existing test coverage — the tester must write baseline tests, not defer them.

Gap classification table and mandatory re-delegation log are defined in `CLAUDE.md` step 2 — follow them exactly.

---

### Step 7: Deliver

Return the summary in two tiers — plain summary first, technical detail below.

**Plain summary:**
> **What was built:** [one paragraph, product language only — no file paths or technical terms]
> **To run it:** `[exact command]`
> **What was assumed:** [bullet list of every open assumption from the Build Brief — be complete, these matter to the user]

**Technical detail:**
- **What changed**: files created per surface, one line each
- **Checks passed**: Nx targets run and their result
- **Gaps resolved**: out-of-scope items that were re-delegated and closed
- **Residual risks**: anything still open, unverified, or requiring human decision
