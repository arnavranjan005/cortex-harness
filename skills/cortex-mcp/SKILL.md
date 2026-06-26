---
name: cortex-mcp
description: View or update the MCP scope configuration — which MCP servers each sub-agent receives during cycle execution.
argument-hint: What to view or change (e.g. "show MCP scopes" or "add playwright to backend-subagent")
allowed-tools: Read, Edit
---

Read `$CLAUDE_SKILL_DIR/references/mcp-scope-guide.md` now.

## Step 1 — Read current MCP scope

Read `harness.config.json`. Find the `mcpScope` field.

If `harness.config.json` does not exist:
> harness.config.json not found. Run `/cortex-init` first.

## Step 2 — Handle the request

If `$ARGUMENTS` is empty or asks to "show": display the current MCP scope table, explaining which agents get which servers using `mcp-scope-guide.md`.

Format as:

| Agent | MCP servers |
|---|---|
| * (all agents) | [list] |
| frontend-subagent | [list] |
| ... | ... |

If `$ARGUMENTS` asks to change something:

**Adding an MCP to an agent:**
Edit `harness.config.json` → `mcpScope` → add the MCP name to the agent's array.

**Adding an MCP to all agents:**
Add it to the `"*"` array.

**Removing an MCP:**
Remove the name from the relevant array.

**Adding a new agent entry:**
Add a new key to `mcpScope` with an empty array or the desired servers.

## Step 3 — Show what changed

After any edit, show the updated mcpScope table.

Remind the user:
> MCP names must match the server names as registered in your `.mcp.json` or Claude Code MCP settings. The engine passes them verbatim to the CLI adapter — a typo means the agent silently gets no access to that MCP.
