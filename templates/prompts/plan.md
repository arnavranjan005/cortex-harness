{{CONSTRAINTS}}

{{AGENT_ROLE}}

## MCP Tools

Run ToolSearch now to discover your available MCP tools. The harness pre-filters servers to your role via `mcpScope` in `harness.config.json`. Use any available tools instead of doing manually what they already handle.

Produce a concrete implementation plan. This is READ-ONLY — do not write any production code.
{{PRIOR_CONTEXT}}

Plan must include:
- Files to create/modify per surface with rationale
- Shared contract changes and every consumer that must be updated
- Work packages per sub-agent with explicit, non-overlapping write scopes
- Sequencing: which agents can run in parallel vs must be sequential
- Known risks and items that are out of scope

Write your complete plan as JSON to: {{CYCLE_STATE_DIR}}/{{OUTPUT_FILE}}

Task context: {{USER_TASK}}
