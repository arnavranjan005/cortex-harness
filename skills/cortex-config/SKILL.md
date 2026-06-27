---
name: cortex-config
description: Read or update harness.config.json — view agent scopes, change CLI provider, update smoke URLs, or adjust budget settings.
argument-hint: What to view or change (e.g. "show agent scopes" or "set cliProvider to opencode")
allowed-tools: AskUserQuestion, mcp__cortex-harness__cortex_config_get, mcp__cortex-harness__cortex_config_set, mcp__cortex-harness__cortex_init_set_scope
---

Read `$CLAUDE_SKILL_DIR/references/config-fields.md` now.

## Step 1 — Read current config

Call `cortex_config_get` (no field) to read the full config.

**If harness.config.json not found** → Read `$CLAUDE_SKILL_DIR/../cortex-init/SKILL.md` and follow those instructions inline now (skill chain — must initialise first)

## Step 2 — Ask what to do

If $ARGUMENTS is empty, use AskUserQuestion:
- "What would you like to do?"
  - "View full config"
  - "Change CLI provider"
  - "Update agent scope paths"
  - "Update smoke URLs or budget"
  - "Manage MCP scopes" → Read `$CLAUDE_SKILL_DIR/../cortex-mcp/SKILL.md` and follow those instructions inline now (skill chain)
  - "Manage auth profiles" → Read `$CLAUDE_SKILL_DIR/../cortex-auth/SKILL.md` and follow those instructions inline now (skill chain)

If $ARGUMENTS already specifies what to change, go directly to Step 3.

## Step 3 — Handle the change

**View full config:**
Display config and explain each field using `config-fields.md`. Stop.

**Change CLI provider:**
Use AskUserQuestion:
- "Which CLI provider?"
  - "claude (Anthropic Claude Code)" — description: "Uses .harness/prompts/ and .harness/agents/"
  - "opencode" — description: "Uses .harness/prompts-opencode/ overrides"

Call `cortex_config_set` with `field: "cliProvider"` and chosen value.

**Update agent scope paths:**
Call `cortex_config_get` with `field: "agents"` to show current paths.
Ask user which agent and paths to change in plain text.
Call `cortex_init_set_scope` with corrected scopes map.

**Update smoke URLs:**
Ask in plain text: "List the URLs to smoke-check after each run."
Call `cortex_config_set` with `field: "smokeUrls"`.

Use AskUserQuestion for budget:
- "Budget per URL?"
  - "$0.50"
  - "$0.80 (default)"
  - "$1.00"
  - "Other"
Call `cortex_config_set` with `field: "smokeCheckBudgetPerUrl"`.

## Rules

- Never change `harnessDir`, `promptsDir`, or `agentsDir` unless explicitly asked
