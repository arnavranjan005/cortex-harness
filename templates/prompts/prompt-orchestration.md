---
description: Outcome-based prompt chaining for this Nx workspace. Invoked internally when a workflow produces a failure or gap that requires a different prompt's workflow. Not for user routing — that lives in CLAUDE.md.
---

# Prompt Orchestration

This file handles **outcome-driven chaining** between prompts.

It is read by the orchestrator when an agent's output triggers a different workflow — not when a user types a request. User routing lives in `CLAUDE.md`. This file owns what happens *after* agents report back and something goes wrong.

---

## When to read this file

Read this file when any of these occur:
- Final verification fails after attempt 2 (two re-delegations to the same sub-agent)
- An out-of-scope gap cannot be resolved by the current workflow
- Any outcome would otherwise result in marking a task `partial` or `blocked`

Do not read this file for user routing decisions.

---

## Chaining rules

| Triggering prompt | Outcome | Next action |
|---|---|---|
| `implement-feature`, `edit-feature`, `create-app` | tester fails after 2 re-delegations | run fix-bug recovery cycle below |
| `fix-bug` (user-invoked) | tester still fails after recovery cycle | permission escalation below |
| any | gap requires Prisma schema change | hard block — ask user immediately |
| any | gap requires auth / session / JWT / CORS / CSRF change | hard block — ask user immediately |
| any | gap has no owning agent **after checking CLAUDE.md routing table** and approach is genuinely unclear | permission escalation below |
| fix-bug recovery cycle | tester passes | return to originating prompt's delivery step |
| fix-bug recovery cycle | tester fails | permission escalation below |

---

## Fix-bug recovery cycle

Runs when verification fails after attempt 2 in any feature prompt.
This is an **internal workflow** — there is no `${input:args}`. The tester's failure output is the bug report.

### Input (from the originating prompt)
- Exact tester failure output from the previous verification run
- Surface and files that failed (from the sub-agent's last report)
- Originating prompt name (to know where to return on success)

### Steps

**Step 1 — Reproduce**
Confirm the exact failure from tester output. Do not re-run tests speculatively — the failure is already known. Write one sentence describing it before moving on.

**Step 2 — Root cause**
Identify the root cause in one sentence before delegating anything.
- If root cause is unclear from available output → spawn `explorer-subagent` on the failing file or surface only. Ask it: what is the code path that produces this failure?
- Do not proceed to Step 3 without a root cause. If genuinely unknowable, go to permission escalation.

**Step 3 — Minimal fix**
Delegate to the owning sub-agent (use the routing table in `CLAUDE.md`) with:
- the confirmed root cause (one sentence)
- exact files to change
- what correct behavior looks like after the fix
- explicit list of what NOT to touch
- verification command: `npm exec nx run <your-scope>/<project>:build`

Do not ask the sub-agent to investigate — the diagnosis is done. Give it a target.

**Step 4 — Verify**
Re-run `tester-subagent` on the fixed surface.

- **Pass** → return to the originating prompt's delivery step:
  - `implement-feature` → Step 5 (Deliver)
  - `edit-feature` → Step 6 (Reconcile and Deliver)
  - `create-app` → Step 7 (Deliver)
- **Fail** → proceed to permission escalation below

### Retry budget
This recovery cycle runs **once** per originating task. If it fails, do not re-run it. Proceed to permission escalation — do not loop infinitely.

---

## Permission escalation protocol

Required before marking any task `partial` or `blocked`.
**Never self-block due to uncertainty, missing context, or assumed restrictions.**

### Steps

**Step 1 — Try a genuinely different approach**
If the current path is blocked, identify a different implementation route and attempt it once.
- Must be a genuinely different approach — not a retry of the same thing
- If no alternative approach exists, skip to Step 2

**Step 2 — Ask for the specific permission or decision**
State exactly what is needed and why. Do not ask vaguely.

> "To complete this I need to [specific action — e.g. 'add a `status` field to the Prisma Invoice model']. Can I proceed? (yes / no / skip this task)"

| User response | Action |
|---|---|
| `yes` | Proceed, continue the task from where it was blocked |
| `no` | Mark `blocked`, record the user's reason |
| `skip` | Mark `blocked`, move to the next task without further discussion |

**Step 3 — Record outcome**
Only after `no` or `skip`:
- what was attempted (including the alternative approach if tried)
- what specific permission or decision was needed
- the user's response

Write this to `session.json` under `risks` so it appears in the session summary.

### Hard blocks — skip escalation, ask user immediately

These bypass Step 1 (alternative approach) and go directly to Step 2:

- Prisma schema change required — workspace rule: always needs human confirmation
- Auth, session, JWT, cookie, CORS, CSRF, or permission config change — security-sensitive, approval required
- External credentials or access the agent cannot obtain
- User already said `no` to this specific action in the current session

---

## Return states

Every path through this file exits with one of three states:

| State | Meaning | What to do |
|---|---|---|
| `done` | Recovery succeeded, verification passed | Return to originating prompt's delivery step |
| `blocked` | User said no / skip, or hard block with user confirmation | Record in `session.json` risks, surface in delivery summary |
| `continuing` | User said yes to permission request | Re-enter originating prompt workflow with the granted permission |
