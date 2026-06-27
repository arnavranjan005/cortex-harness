---
name: cortex-init
description: Guided setup wizard for cortex-harness — checks prerequisites, scaffolds .harness/ files, then walks the user through confirming surface paths and dev server config with interactive prompts.
argument-hint: (no arguments needed)
allowed-tools: Bash, Read, AskUserQuestion, mcp__cortex-harness__cortex_init_run, mcp__cortex-harness__cortex_init_set_scope, mcp__cortex-harness__cortex_config_get
---

Read `$CLAUDE_SKILL_DIR/references/scaffold-checklist.md` now.

## Step 1 — Check prerequisites

```bash
cortex-harness --version
```

If this fails: tell the user to run `npm install -g cortex-harness` then re-run this skill.

Check whether `harness.config.json` already exists:
```bash
test -f harness.config.json && echo "EXISTS" || echo "FRESH"
```

**If EXISTS** → use AskUserQuestion:
- "cortex-harness is already initialised here. What would you like to do?"
  - "Review or update config" → Read `$CLAUDE_SKILL_DIR/../cortex-config/SKILL.md` and follow those instructions inline now (skill chain)
  - "Re-run init to update scaffolded files" → continue to Step 2

## Step 2 — Scaffold all files

Call `cortex_init_run`. This runs `cortex-harness init --yes` — copies prompt templates, agent files, harness.config.json, wires Claude hooks, patches .gitignore.

## Step 3 — Confirm detected surfaces

Call `cortex_config_get` with `field: "agents"`. Use AskUserQuestion:
- "Do these auto-detected surface paths look right?"
  - "Yes, looks correct" → skip to Step 4
  - "No, I need to adjust paths" → ask follow-up in plain text for each agent, then call `cortex_init_set_scope` with corrected map

## Step 4 — Smoke auth (chains to cortex-auth)

Use AskUserQuestion:
- "Does your app require login to access pages?"
  - "Yes — set up auth now" → Read `$CLAUDE_SKILL_DIR/../cortex-auth/SKILL.md` and follow those instructions inline now (skill chain)
  - "No — pages are public" → skip to Step 5

## Step 5 — Post-init verification

Use checklist from `scaffold-checklist.md`. Verify:
- `harness.config.json` exists with non-empty agent scopes
- `.harness/prompts/` exists
- `.harness/agents/` exists
- `CLAUDE.md` exists

Report what passed. Flag anything missing.

## Step 6 — Offer first task (chains to cortex-chain)

Use AskUserQuestion:
- "Setup complete! What would you like to do next?"
  - "Run my first task now" → Read `$CLAUDE_SKILL_DIR/../cortex-chain/SKILL.md` and follow those instructions inline now (skill chain)
  - "I'll start a task later"
