# cortex-harness init Scaffold Checklist

Running `cortex-harness init` scaffolds a workspace. This is what it creates and what to verify afterward.

## What init creates

```
.harness/
  prompts/           ← cycle prompt templates (orchestrate, implement-feature, fix-bug, etc.)
  prompts-opencode/  ← OpenCode-flavored variants (if cliProvider is opencode)
  agents/            ← sub-agent role definition files
    backend-subagent.agent.md
    frontend-subagent.agent.md
    distributed-subagent.agent.md
    infra-subagent.agent.md
    tester-subagent.agent.md
    explorer-subagent.agent.md
    planner-subagent.agent.md
  memory/            ← MEMORY.md and memory file templates
  scripts/           ← sync-memory.js hook script

harness.config.json  ← agent scopes, MCP scope, auth profiles, smoke URLs
CLAUDE.md            ← orchestrator routing instructions (orchestrator brain)
.gitignore           ← patched to exclude .harness/runs/, .harness/cycle-state/, etc.
```

## What init asks you

During init, it detects your project structure and asks you to confirm surface paths:
- Backend paths (e.g. `apps/api/`)
- Frontend paths (e.g. `apps/web/`)
- Shared lib paths
- Worker/queue paths

These become the `scope` declarations in `harness.config.json` for each agent.

On Nx workspaces, surfaces are detected from the project graph. On non-Nx projects, it walks the directory tree.

## Post-init verification checklist

After running init, verify:
- [ ] `harness.config.json` exists at project root
- [ ] `.harness/prompts/` contains prompt templates (orchestrate.md, implement-feature.md, etc.)
- [ ] `.harness/agents/` contains all 7 agent role files
- [ ] `CLAUDE.md` exists and contains routing instructions
- [ ] `.gitignore` includes `.harness/runs/`, `.harness/cycle-state/`, `.harness/output/`
- [ ] Agent scopes in `harness.config.json` reflect your actual project paths

## Common post-init fixes

If scope paths are wrong, run: `cortex-harness config` to update them interactively.
If `.gitignore` wasn't patched, run: `cortex-harness gitignore` to apply it manually.
