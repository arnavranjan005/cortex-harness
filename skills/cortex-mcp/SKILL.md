---
name: cortex-mcp
description: View or update MCP server scope assignments in harness.config.json — which MCP servers each sub-agent can use during cycle execution.
argument-hint: Action (e.g. "show", "add playwright to frontend-subagent", "remove shadcn from tester")
allowed-tools: AskUserQuestion, mcp__cortex-harness__cortex_mcp_scope_list, mcp__cortex-harness__cortex_mcp_scope_set, mcp__cortex-harness__cortex_mcp_scope_remove
---

Read `$CLAUDE_SKILL_DIR/references/mcp-scope-guide.md` now.

## Step 1 — Check config exists

Call `cortex_mcp_scope_list`. If it returns "harness.config.json not found":
→ Read `$CLAUDE_SKILL_DIR/../cortex-init/SKILL.md` and follow those instructions inline now (skill chain)

## Step 2 — Show current scope

Display as a table:

| Agent | MCP servers |
|---|---|
| * (all agents) | [list] |
| frontend-subagent | [list] |
| ... | ... |

## Step 3 — Ask what to do

If $ARGUMENTS is empty, use AskUserQuestion:
- "What would you like to do with MCP scopes?"
  - "Just show current scopes" → display table and stop
  - "Add an MCP server to an agent"
  - "Remove an MCP server from an agent"

If $ARGUMENTS already specifies an action, parse it and go directly.

## Step 4 — Handle the action

**Add MCP to agent:**
Use AskUserQuestion:
- "Which agent should get access?" (options: "frontend-subagent", "tester-subagent", "backend-subagent", "All agents (*)")
- "Which MCP server?" (options: "playwright", "shadcn", "prisma", "Other")

Call `cortex_mcp_scope_set`. If "All agents" → use `agent: "*"`.

**Remove MCP from agent:**
Use AskUserQuestion with options from current scope list.
Call `cortex_mcp_scope_remove`.

After any change, call `cortex_mcp_scope_list` again and show updated table.

> MCP names must match server names in `.mcp.json` exactly — a typo means the agent silently gets no access.
