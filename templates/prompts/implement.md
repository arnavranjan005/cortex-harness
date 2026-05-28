{{CONSTRAINTS}}

{{AGENT_ROLE}}
{{PRIOR_CONTEXT}}

Task context: {{USER_TASK}}

Follow your role block's scope and delivery rules exactly.
When your work is complete, write your agent report as JSON to:
  {{CYCLE_STATE_DIR}}/{{OUTPUT_FILE}}

Report must include:
{
  "filesChanged": [],
  "outOfScopeGaps": [],
  "notes": ""
}
