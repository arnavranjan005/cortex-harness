---
name: cortex-config
description: Read or update harness.config.json — view agent scopes, change CLI provider, update smoke URLs, or adjust budget settings.
argument-hint: What to view or change (e.g. "show agent scopes" or "set cliProvider to opencode")
allowed-tools: Bash, Read, Edit
---

Read `$CLAUDE_SKILL_DIR/references/config-fields.md` now.

## Step 1 — Read current config

Read `harness.config.json` from the current directory.

If it does not exist:
> harness.config.json not found. Run `/cortex-init` to set up the harness first.

## Step 2 — Handle the request

If `$ARGUMENTS` is empty or asks to "show" / "view": display the current config in a readable format, explaining each field using `config-fields.md`.

If `$ARGUMENTS` asks to change something, identify what needs changing from `config-fields.md`:

**Common changes and how to handle them:**

- `cliProvider` (claude/opencode) — edit the field directly
- Agent scope paths — edit the `agents.<name>.scope` array
- `smokeUrls` — edit the array
- `smokeCheckBudgetPerUrl` — edit the number
- MCP scope — tell the user to use `/cortex-mcp` for MCP changes
- Auth profiles — tell the user to use `/cortex-auth` for auth profile changes

## Step 3 — Apply the change

For simple field changes, use the Edit tool to update `harness.config.json` directly.

Always show the user what you changed:
> Updated `cliProvider` from `"claude"` to `"opencode"`.

For complex changes (scope path updates, provider migration), explain the implications:
- Changing `cliProvider` to `opencode`: the engine will look for prompts in `.harness/prompts-opencode/` as overrides
- Changing scope paths: paths that don't exist yet will trigger a warning on the next run, not an error — the agent will create them

## Rules

- Never commit or push config changes
- Never add real credentials to `authProfiles` — use `/cortex-auth` for that
- Never change `harnessDir`, `promptsDir`, or `agentsDir` unless the user explicitly asks — these are rarely wrong and changing them breaks the engine
