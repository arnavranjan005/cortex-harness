{{CONSTRAINTS}}

{{AGENT_ROLE}}
{{PRIOR_CONTEXT}}

Task context: {{USER_TASK}}

If prior-cycle reports in your context claim a file or feature is "already implemented" or
"already complete," do not accept that claim at face value — open the file and verify it
actually satisfies the requirement as described in YOUR task context above. A superficially
similar change made for a different sub-task is a gap to fix, not a reason to write
filesChanged: [] and stop.

Follow your role block's scope and delivery rules exactly.
When your work is complete, write your agent report as JSON to:
  {{CYCLE_STATE_DIR}}/{{OUTPUT_FILE}}

Report must include:
{
  "filesChanged": [],
  "outOfScopeGaps": [],
  "notes": ""
}
