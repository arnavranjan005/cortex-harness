# Workspace Operating Notes

- If `nx-workspace` and `nx-generate` skills are available in your system prompt, invoke them for discovery and scaffolding (they are workspace-specific — record "not available" and continue if absent).
- Always prefix nx commands: `npm exec nx`.
- Keep shared contracts (schemas, types, UI primitives) in your configured shared libs — paths are defined in `harness.config.json`.
- Keep route files thin — business logic in controllers, services, or queue modules.
- Check existing modules before creating new services, helpers, or shared abstractions.
- Never edit database schema without human confirmation.

## Agent Orchestration

This workspace uses an orchestrator → sub-agent model for all feature work.

**Before routing — check for vague requests:**
If the request has no specific surface, file, behavior, or error mentioned AND is fewer than ~15 words:
- Ask 2–3 targeted clarifying questions before loading any prompt.
- Exception: clearly greenfield ("create an app", "build a new service") → read `create-app.md` immediately.

**Match user intent to the right prompt:**

| User signals | Action |
|---|---|
| "create an app", "build from scratch", greenfield | Read `.harness/prompts/create-app.md` and follow its steps |
| "add", "implement", "I need X" on existing code | Read `.harness/prompts/implement-feature.md` and follow its steps |
| "fix", "broken", "error", "not working", stack trace | Read `.harness/prompts/fix-bug.md` and follow its steps |
| "change", "update", "modify", "adjust" existing behavior | Read `.harness/prompts/edit-feature.md` and follow its steps |
| Mixed verbs — fix + add, fix + change, implement + edit | Multi-intent: decompose into ordered groups (fix → edit → implement), each with its own cycle sequence. Read `.harness/prompts/orchestrate.md` Step 6 for full rules. |
| "where is X", "find X", "how does X work" (read-only) | Spawn `explorer-subagent` |
| "plan", "design", "how should we approach" (read-only) | Spawn `planner-subagent` |
| "scaffold", "generate", new lib/project inside existing app | Invoke `nx-generate` skill first, then `implement-feature.md` |

**Disambiguation rules — apply when signals conflict or intent is unclear:**

| Ambiguous case | Resolution |
|---|---|
| Wrong output described, but no error thrown | → `fix-bug` (unexpected behavior is a bug) |
| "Change X" / "Update X" but X does not exist yet | → `implement-feature` |
| "Add X" but it clearly replaces or removes existing behavior | → `edit-feature` |
| Unsure between fix and edit | Ask: "Is the current behavior intentional?" — yes → `edit-feature`, no → `fix-bug` |
| Task touches multiple surfaces and ownership is unclear | Spawn `planner-subagent` first, then route |

**Cycle mode — autonomous harness sessions:**

If your initial prompt begins with `CYCLE CONSTRAINTS`, you are running as a named cycle inside the autonomous harness. Apply these rules immediately:

- **Skip the session.json check** — the outer loop owns queue state
- **Skip vague-request handling** — your task is fully specified in the cycle prompt
- Follow the cycle prompt instructions exactly, write your output JSON to the specified `.harness/cycle-state/` file
- End your final message with exactly one signal:
  - `CYCLE_COMPLETE` — work is finished, outer loop advances the queue
  - `NEEDS_HUMAN_INPUT` — blocked on a hard decision only a human can make (schema migration, auth/JWT/CORS/CSRF, destructive action). Do NOT emit for routing ambiguity — make a best-guess decision and continue.
  - `CYCLE_PARTIAL:<reason>` — could not finish; outer loop will retry

**Session resumption — run this at the start of every interactive conversation:**

```
node -e "
  try {
    const s = JSON.parse(require('fs').readFileSync('.harness/session.json','utf8'));
    const cycles = s.cycles || [];
    if (!cycles.length) { console.log('FRESH'); process.exit(0); }
    const partial  = cycles.filter(c => c.outcome === 'partial').map(c => '['+c.n+'] '+c.description);
    const blocked  = cycles.filter(c => c.outcome === 'blocked').map(c => '['+c.n+'] '+c.description);
    const done     = cycles.filter(c => c.outcome === 'done').length;
    console.log('RESUME');
    console.log('started='+s.startTime);
    console.log('done='+done);
    if (partial.length)  console.log('partial='+partial.join('|'));
    if (blocked.length)  console.log('blocked='+blocked.join('|'));
  } catch { console.log('FRESH'); }
"
```

- **FRESH** → greet normally, wait for user's first message
- **RESUME** → surface unfinished tasks: "Previous session from [startTime] — [done] done, [partial] partial, [blocked] blocked." Ask: "Resume these, or start fresh?"

**Mandatory pre-delegation steps — required before spawning any feature sub-agent:**
1. **Invoke `nx-workspace` skill** (if available) — hard mandate before explorer. Record "not available" if absent.
2. **Spawn `explorer-subagent` first** — map existing file structure, component/module placement, naming conventions. Do not brief feature agents without this report. This applies even when the location seems obvious.
3. **Spawn `planner-subagent` next** if task touches >1 surface, component/architecture placement is unclear, or shared contracts are involved.
4. Only after explorer (and planner if needed) report back, brief and spawn feature sub-agents.

**The one rule every agent must follow:**
The agent that receives the user's request is the orchestrator. It plans, delegates, and reconciles. It does NOT write production code. Every source file edit must be owned by a sub-agent spawned from `.harness/agents/`.

**Sub-agent routing table:**
| What the work touches | Sub-agent to spawn |
|---|---|
| Queue/job flows, async processing, retry, idempotency, event-driven handlers | `distributed-subagent` |
| Backend apps, serverless functions, shared contracts (schema, types) | `backend-subagent` |
| Frontend apps, shared UI libs | `frontend-subagent` |
| Nx config, CI, `.github/workflows`, dependencies | `infra-subagent` |
| Builds, tests, verification | `tester-subagent` |
| Codebase discovery (read-only) | `explorer-subagent` |
| Multi-surface or contract-heavy planning (read-only) | `planner-subagent` |
| CI monitoring and self-healing fixes | `ci-monitor-subagent` |

**Every sub-agent prompt must include:**
1. The agent's role block (paste from `.harness/agents/<name>.agent.md`)
2. Feature context
3. Explicit write ownership — exact files or directories
4. Out-of-scope list — what NOT to touch
5. Verification command — `npm exec nx run <project>:build` or equivalent
6. Return format
7. Skill guidance — paste output of any skills invoked (or write "none available / none matched")

**Spawn independent agents in parallel** when their write scopes do not overlap.

## Skills and MCP Tools

At the start of every task, scan the available skills list in the system prompt. If any skill's trigger description matches the work, invoke it via the Skill tool before routing or briefing anyone. Narrating intent is not invoking — you must actually call the Skill tool.

`nx-workspace` and `nx-generate` are workspace-specific skills — they may not be present in every deployment. If absent, record "not available" and continue.

If no skills match: record "none available / none matched" and continue.

**Hard mandates — skill must run before the listed action, no exceptions (only if available in system prompt):**
- `nx-workspace` before any workspace exploration or agent briefing
- `nx-generate` before any scaffolding or generator call

**In cycle mode (autonomous harness) — skill and MCP propagation protocol:**
- The `orchestrate` cycle invokes all matching skills and writes output to `.harness/cycle-state/skills.json`
  Format: `{ "invoked": ["skill-name", ...], "output": { "skill-name": "<one-line summary>" } }`
  If no skills match: write `{ "invoked": [], "output": {} }` — marks Step 0 complete, not skipped
- Implement cycles do not re-invoke skills — they read `skills.json` from `cycle-state/` as their `## Skill guidance`
- If `skills.json` is absent when an implement cycle runs: write "none available / none matched"
- When briefing sub-agents (interactive or autonomous), always include which MCP servers they will receive — agents start cold and will not use MCPs unless explicitly told. Check `mcpScope[agent-name]` plus `mcpScope["*"]` in `harness.config.json` for the full list. Use ToolSearch to discover available tools before doing manually what an MCP already handles.

## Reconciliation Protocol (after all agents report back)

1. **Cross-surface contract check** — if any agent changed a shared type, interface, or validation schema in a shared lib, verify every other consumer used the updated version. On failure: re-delegate to owning agent, re-run check, repeat.

2. **Resolve out-of-scope gaps** — collect every gap from agent reports. Fill the mandatory re-delegation log:

   | Gap | Owning agent | Spawned? | Result |
   |-----|-------------|----------|--------|
   | (every gap) | | yes / no | pass / human-approval / failed |

   - Spawned = no anywhere → NOT done, spawn that agent now.
   - "Pre-existing" or "out of scope for this task" are NOT valid reasons to leave Spawned = no.
   - Gap reaches Residual risks ONLY if: Spawned = yes AND result = human-approval OR failed after 2 attempts.

   Hard blocks — human approval required, do not re-delegate:
   - Database schema change needed
   - Auth, JWT, session, CORS, CSRF, permissions change
   - Ambiguous ownership spanning >2 agents after checking routing table

3. **Consistency check** — confirm queue producers/consumers, API request/response shapes, and validation schemas align across all changed surfaces. Also run the mechanical wiring sweep:
   - Every backend route file added/touched: verify it is imported AND registered (e.g. `app.use()`).
   - Every frontend API fetch: verify the path resolves to a registered route.
   - Every provider/hook/component meant to run globally: verify it is rendered in a layout or root tree.
   - Every nav entry pointing at a changed page: verify it is not gated by a stale feature flag.
   Treat any finding here as a real gap — step 2 re-delegation rules apply; "pre-existing" is not an exemption.

4. **Final verification** — spawn `tester-subagent` to run `npm exec nx affected --target=build,test,lint`. Add `typecheck` if shared lib contracts were changed. **Mandatory — not skippable.**
   - If any changed functionality has no test coverage, write the missing tests — not a follow-up.
   - On failure (attempt 1–2): re-delegate to owning agent with exact error, re-run.
   - On failure (attempt 3+): read `.harness/prompts/prompt-orchestration.md` and follow its chaining rules.

**Pre-delivery gate — check every item before delivering:**

> In autonomous runs (cycle mode), the harness enforces structural gates between cycles. Items the harness enforces are marked [harness] — verify them against completed `cycle-state/` files rather than inline work.

- [ ] Session.json checked at conversation start (FRESH/RESUME handled) — [harness] in autonomous runs
- [ ] Prompt file was read with the Read tool — not from memory
- [ ] `nx-workspace` invoked (or recorded as not available) before explorer
- [ ] Explorer ran before any sub-agent was briefed — [harness: explore cycle precedes implement cycles]
- [ ] Planner ran (if >1 surface or shared contracts)
- [ ] Named sub-agent used per routing table (not generic Agent())
- [ ] Every sub-agent prompt had all 7 required elements
- [ ] Contract check complete (Step 1)
- [ ] Re-delegation log filled — every gap Spawned = yes or human-approval (Step 2)
- [ ] Consistency check passed (Step 3)
- [ ] Tester ran `npm exec nx affected --target=build,test,lint` — all pass (Step 4)
- [ ] Missing tests written — none deferred (Step 4)
- [ ] Smoke passed (or skipped) — if any frontend changed, check `cycle-state/smoke*.json` for `passed: true` or `skipped: true` before delivering

**Loop rule:** If any item above is unchecked —
- **Retroactively actionable** (explorer, planner, tester, tests, contract check, re-delegation gaps): do it now, re-check, repeat until checked
- **Not retroactively fixable** (session check skipped, wrong prompt used without reading it): flag as process violation in Residual risks — do not block delivery over it

**Deliver a unified summary only after the gate is fully resolved:**
- **What changed**: files edited per surface, one line each
- **Checks passed**: Nx targets run and their result
- **Gaps resolved**: out-of-scope items that were re-delegated and closed
- **Residual risks**: anything still open, unverified, or requiring human decision

## Security Rules

- Never access actual `.env` contents or print environment variables.
- Never expose credentials, tokens, API keys, or personal data in logs, diffs, or summaries.
- Never commit secrets or secret-bearing config values.
- Treat auth, session, JWT, cookie, CORS, CSRF, webhook verification, and permission changes as security-sensitive — request approval before modifying.
- Never edit database schema without human confirmation.
- Do not add client-side code that embeds secrets or environment-derived sensitive values.
