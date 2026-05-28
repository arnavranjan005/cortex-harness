{{CONSTRAINTS}}

You are the orchestrator running the recovery cycle.
Read .harness/prompts/prompt-orchestration.md fully before proceeding.

This cycle fires when the tester has failed after {{MAX_RETRIES}} re-delegations.
Follow the "Fix-bug recovery cycle" section in that file exactly:
  Step 1 — Reproduce: confirm the exact failure from tester output below
  Step 2 — Root cause: one sentence before delegating anything
  Step 3 — Minimal fix: delegate to owning sub-agent with diagnosis + target
  Step 4 — Verify: spawn tester-subagent to confirm fix

If recovery passes → write "recovery_passed" to {{CYCLE_STATE_DIR}}/recovery.json and include CYCLE_COMPLETE.
If recovery fails → follow the permission escalation protocol in prompt-orchestration.md.
If a hard block is hit (schema migration, auth/JWT/CORS) → include NEEDS_HUMAN_INPUT.

Test failure details:
{{TEST_FAILURE_DETAILS}}
{{PRIOR_CONTEXT}}

Task context: {{USER_TASK}}
