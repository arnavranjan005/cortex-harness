---
name: claude-md-protocol-compliance
description: Pre-flight checklist — every rule in CLAUDE.md must be followed in full, every session, no exceptions
metadata:
  type: feedback
---

Every rule in CLAUDE.md is mandatory. Do not skip, shortcut, or partially follow any of them.

**Why:** CLAUDE.md is the authoritative operating contract for this workspace. Skipping rules breaks the harness system.

**How to apply — verify every item before proceeding:**

### 1. Session start
- **Cycle mode gate (check first):** If the initial prompt begins with `CYCLE CONSTRAINTS` → you are a harness cycle. Skip the session.json check, skip vague-request handling, skip the pre-delivery gate. Follow the cycle prompt, write output to the specified `cycle-state/` file, end with `CYCLE_COMPLETE` / `NEEDS_HUMAN_INPUT` / `CYCLE_PARTIAL:<reason>`. Everything else in CLAUDE.md still applies within the cycle.
- **Interactive sessions only:** Check `task-queue.json` for pending/partial cycles FIRST, before reading the user's message or doing anything else
- RESUME → surface partial/blocked tasks by name, ask "Resume these, or start fresh?" before proceeding
- FRESH → greet normally, wait for first message

### 2. Request routing
- Match intent to the **prompt routing table** in CLAUDE.md (fix-bug / implement-feature / edit-feature / create-app)
- **Use the Read tool to read the actual prompt file** and follow its steps in order — do NOT wing it from memory
- Vague request (no surface/file/error, <15 words): ask 2–3 clarifying questions first
- Exception: clearly greenfield → Read `create-app.md` immediately (it owns intake)
- Disambiguation rules:
  - Wrong output but no thrown error → `fix-bug`
  - "Change X" / "Update X" but X does not exist yet → `implement-feature`
  - "Add X" but it clearly replaces or removes existing behavior → `edit-feature`
  - Unsure between fix and edit → ask "Is the current behavior intentional?" (yes → edit, no → fix)
  - Multi-surface or ambiguous scope → spawn `planner-subagent` before choosing a prompt
- **Multi-intent:** if the task contains multiple distinct verb clusters (e.g. "fix X and add Y and change Z") → orchestrate decomposes into ordered groups (fix → edit → implement/create), each with its own cycle sequence. Set `promptType: "multi-intent"` in task-queue.json. Do NOT route everything to one prompt type — each sub-task must use the correct prompt. See `project_harness_architecture.md` for the full decomposition rules.

### 3. Orchestrator role
- Never edit source files directly — all edits must be delegated to a sub-agent from `.harness/agents/`
- **Mandatory pre-delegation — before spawning any feature sub-agent:**
  1. Invoke `nx-workspace` skill first (if available) — hard mandate before explorer. Record "not available" if absent.
  2. Spawn `explorer-subagent` — map existing file/component structure, placement patterns, naming conventions. Do not brief feature agents without this report.
  3. Spawn `planner-subagent` next if task touches >1 surface, placement is unclear, or shared contracts are involved.
  4. Only then brief and spawn feature sub-agents using the explorer/planner reports.
- Assign ownership per the **sub-agent routing table** in CLAUDE.md — common violation: routing queue/async/worker changes to `backend-subagent` instead of `distributed-subagent`
- **All custom sub-agents are spawned via `Agent(...)` — the role block from `.harness/agents/<name>.agent.md` is what makes the spawn correct.** Without it the agent has no scope guard, ownership boundaries, or delivery format. Always: routing table → identify sub-agent → read `.agent.md` → paste full role block as first section of prompt.
- Spawn independent agents in parallel when their write scopes do not overlap
- Every sub-agent prompt must include all 7 elements: role block, feature context, write ownership, out-of-scope list, verification command, return format, skill guidance ("none available / none matched" is valid; blank is not)

### 4. Skills — mandatory gates
- Scan the available skills list and invoke every matching skill via the Skill tool before routing or briefing anyone
- **Narrating intent is not invoking.** Saying "I'll use skill X" without calling the Skill tool is a violation.
- If no skills match, record "none available / none matched" — valid completed state, not a failure

### 5. Nx rules
- Always prefix nx commands with the workspace package manager (e.g. `npm exec nx`) — never bare `nx`
- Never guess CLI flags — check `nx_docs` or `--help` first when unsure

### 6. Workspace structure rules
- Inspect the smallest relevant set of files before changing any code
- Keep shared contracts (schemas, types, UI primitives) in shared libs — never define them inside application files
- Keep route files thin — business logic belongs in controllers, services, or queue modules
- Check existing modules before creating new services, helpers, or shared abstractions
- Extend current patterns before introducing new architecture or tooling
- Verify assumptions against the source tree — do not trust scaffold-like READMEs
- Note workspace mismatches (missing dirs, broken references) instead of silently assuming they are intentional
- Prefer targeted validation for changed surfaces before broad workspace runs

### 7. Reconciliation (after all agents report back)
- Step 1: Cross-surface contract check — shared types, Zod schemas, interfaces aligned across all surfaces. On failure: re-delegate to owning agent, re-run check, repeat until all agree.
- Step 2: Resolve all out-of-scope gaps — classify each using CLAUDE.md gap table, then fill mandatory re-delegation log:
  - Log columns: Gap | Owning agent | Spawned? | Result
  - Spawned = no anywhere → NOT done, spawn that agent now
  - "Pre-existing", "if desired", "out of scope for this task" are NOT valid reasons to leave Spawned = no
  - Gap reaches Residual risks ONLY if: Spawned = yes AND result = human-approval OR failed after 2 attempts
  - **"Already implemented" false positive guard**: if an implement report claims a sub-task is "already done by a prior cycle" and shows `filesChanged: []` (or near-empty), do NOT accept it — open the referenced files and confirm the change actually satisfies THIS group's sub-task. If not, treat it as a real gap and re-delegate.
- Step 3: Consistency check — queue producers/consumers, API request/response shapes, validation schemas. Also run the mechanical wiring sweep:
  - Every backend route added/touched: confirm imported AND registered (e.g. `app.use()`)
  - Every frontend API call: confirm the path resolves to a registered route
  - Every global provider/hook/component: confirm rendered in layout or root tree
  - Every nav entry for a changed page: confirm not gated by a stale feature flag
  On failure: re-delegate misaligned side; "pre-existing" is not an exemption here.
- Step 4: Final verification — spawn `tester-subagent` to run `npm exec nx affected --target=build,test,lint` (add `typecheck` if shared contracts changed). **Mandatory for every task that changes UI-visible behavior, backend logic, distributed/queue flows, or shared contracts — not skippable.**
  - If any changed functionality has no tests (unit/integration/e2e), write them now — not a follow-up
  - On failure (attempt 1–2): re-delegate broken surface with exact error, re-run
  - On failure (attempt 3+): read `prompt-orchestration.md` chaining rules, do not re-delegate to same agent
- **Pre-delivery gate — work through every item; loop back and complete any unchecked retroactively-actionable item before delivering. Show the filled checklist in the delivery summary.**
  - **Whole-flow audit:**
    - [ ] Task queue checked at session start (FRESH/RESUME handled)
    - [ ] Prompt file Read with the Read tool — not from memory
    - [ ] `nx-workspace` invoked (or recorded as not available) before explorer
    - [ ] Explorer ran before any sub-agent was briefed
    - [ ] Planner ran (if >1 surface or shared contracts)
    - [ ] Named sub-agent used (not generic Agent()) per CLAUDE.md routing table
    - [ ] Every sub-agent prompt had all 7 required elements (including skill guidance)
  - **Reconciliation audit:**
    - [ ] Contract check complete (Step 1)
    - [ ] Re-delegation log filled — every gap Spawned = yes or human-approval (Step 2)
    - [ ] Consistency check passed (Step 3)
    - [ ] Tester ran `npm exec nx affected --target=build,test,lint` — all pass (Step 4)
    - [ ] Missing tests written — none deferred (Step 4)
    - [ ] Smoke passed or skipped — if frontend changed, verify `smoke*.json` has `passed: true` or `skipped: true` before delivering
  - **Loop rule:** retroactively actionable items (explorer/planner/tester/tests/contract/consistency) → do it now and re-check; not fixable (session skip, wrong prompt used) → flag in Residual risks, do not block delivery
- Step 5: Deliver unified summary ONLY after gate is fully resolved — sections: What changed / Checks passed / Gaps resolved / Residual risks

### 8. Security & safety
- auth, session, JWT, cookie, CORS, CSRF, webhook verification, permissions → request approval before modifying
- Never access actual `.env` contents or print environment variables
- Never expose credentials, tokens, API keys, or personal data in logs, diffs, or summaries
- Never edit database schema without human confirmation
