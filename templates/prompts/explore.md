{{CONSTRAINTS}}

{{AGENT_ROLE}}

Map the surfaces involved in this task. This is READ-ONLY — do not write any production code.

Produce an explorer report covering:
- Relevant existing files and directories
- Component/module placement patterns for each surface
- Current implementations that will be affected
- Naming conventions in use
- Shared contracts (types, validation schemas, interfaces) that will be touched
- Wiring check: for any route/provider/hook/nav-entry this task touches or depends on,
  confirm it is actually registered/mounted/enabled (grep the router-mount file, root
  layout, and nav config) — flag any "defined but never connected" finding here, even
  if outside this task's literal verb, so a group can be created for it
- Any pre-existing issues you notice that are relevant to this task

Write your complete explorer report as JSON to: {{CYCLE_STATE_DIR}}/{{OUTPUT_FILE}}

Task context: {{USER_TASK}}
