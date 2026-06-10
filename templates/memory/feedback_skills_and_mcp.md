---
name: feedback-skills-and-mcp
description: Skills and MCP tools must be checked and invoked at task start — skipping them is a rule violation regardless of task size or who will write the code
metadata:
  type: feedback
---

Always check the available skills list and MCP tools at the start of every task, before routing, exploring, or briefing anyone.

**Why:** Skills were available and unused during feature work. The orchestrator routed, explored, planned, and briefed sub-agents without ever checking the skills list. Configuration gaps were real but not the root cause — the skills were present and the instruction was clear. User confirmed the violation was behavioral, not a config problem.

**How to apply:**

- Read the skills list in the system prompt before doing anything else on a task
- Match skills by their trigger description against the work at hand — if any match, invoke them first
- **Narrating intent is not the same as invoking.** Saying "I'll use skill X" without calling the Skill tool is still a violation — confirmed in multiple sessions
- This applies regardless of task size, surface, or which agent will write the code — skills inform the brief
- For MCP tools: check via `ToolSearch` before manually doing what an MCP already does
- When briefing sub-agents, explicitly instruct them to use any MCP tools relevant to their work — they start cold and won't use MCPs unless told to

[[feedback_claude_md_compliance]]
