# Project Memory Index

Shared, repo-level memories. Auto-synced to each device's local Claude memory directory
via `.harness/scripts/sync-memory.js` (UserPromptSubmit hook). Do not store secrets here.

- [CLAUDE.md Protocol Compliance](feedback_claude_md_compliance.md) — orchestrator model, session check, cycle mode gate, prompt routing, sub-agent delegation
- [Skills and MCP usage](feedback_skills_and_mcp.md) — invoke matching skills before any routing or briefing; check MCPs via ToolSearch; tell sub-agents to use MCPs explicitly
- [Harness Architecture](project_harness_architecture.md) — multi-cycle autonomous runner: cycle types, sequence, state transfer via cycle-state/, parallel safety, Zod validation
