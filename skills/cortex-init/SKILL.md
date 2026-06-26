---
name: cortex-init
description: Guided setup walkthrough for cortex-harness — checks prerequisites and scaffolds .harness/ prompt templates, agent files, and harness.config.json.
argument-hint: (no arguments needed)
allowed-tools: Bash, Read
---

Read `$CLAUDE_SKILL_DIR/references/scaffold-checklist.md` now.

## Step 1 — Check if CLI is installed

```bash
cortex-harness --version
```

If this fails with "command not found", tell the user to install it:
```
npm install -g cortex-harness
```
Then re-run this skill.

## Step 2 — Check if already initialised

Check whether `harness.config.json` exists in the current directory.

If it exists, tell the user:
> cortex-harness is already initialised here. Run `/cortex-config` to review or update configuration.

## Step 3 — Run init

Tell the user:
> Running cortex-harness init. It will detect your project structure and ask you to confirm surface paths.
> Follow the interactive prompts in your terminal.

Then advise them to run in their terminal (Claude cannot drive interactive prompts):
```
cortex-harness init
```

Explain what it will ask:
- Confirm detected surface paths (backend, frontend, shared libs, workers)
- These become the write-scope declarations for each sub-agent

## Step 4 — Post-init verification

After the user says init is done, verify using the checklist from `scaffold-checklist.md`:

Read:
- `harness.config.json` — confirm it exists and agents have scope paths
- `.harness/prompts/` — confirm prompt templates exist
- `.harness/agents/` — confirm agent role files exist
- `CLAUDE.md` — confirm routing instructions exist

If anything is missing, tell the user what to fix and how.

## Step 5 — Next steps

After successful init:
> Setup complete. Run your first task with:
> `/cortex-chain "describe your task here"`
>
> Or a single run with: `/cortex-run "describe your task here"`
