# harness.config.json Field Reference

All fields in `harness.config.json`, their types, defaults, and what they control.

## Top-level fields

| Field | Type | Default | What it controls |
|---|---|---|---|
| `cliProvider` | `"claude"` \| `"opencode"` | `"claude"` | Which CLI adapter the engine uses to spawn cycles |
| `harnessDir` | string | `".harness"` | Root dir for all harness state |
| `promptsDir` | string | `".harness/prompts"` | Where cycle prompt templates live |
| `agentsDir` | string | `".harness/agents"` | Where agent role `.agent.md` files live |
| `smokeUrls` | string[] | `[]` | URLs to browser-smoke-test after tests pass |
| `smokeCheckBudgetPerUrl` | number | `0.80` | Max USD to spend per smoke URL |
| `authProfiles` | object[] | `[]` | Named browser auth profiles for smoke sessions |

## agents field

Maps agent name → scope config. Scope is the list of file/directory paths the agent is allowed to write.

```json
{
  "agents": {
    "backend-subagent": { "scope": ["apps/api/", "libs/shared/schema/"] },
    "frontend-subagent": { "scope": ["apps/web/"] },
    "distributed-subagent": { "scope": ["apps/worker/"] },
    "infra-subagent": { "scope": [".github/", "nx.json", "package.json"] },
    "tester-subagent": { "scope": null },
    "explorer-subagent": { "scope": [] },
    "planner-subagent": { "scope": [] }
  }
}
```

`scope: null` means tester-subagent has no scope restriction (it only runs tests, never writes source files).
`scope: []` means the agent has no declared scope yet — the engine will auto-detect and update it on first run.

## mcpScope field

Maps agent name (or `"*"` for all agents) to list of MCP server names they receive.

```json
{
  "mcpScope": {
    "*": [],
    "frontend-subagent": ["playwright", "shadcn"],
    "tester-subagent": ["playwright"],
    "smoke": ["playwright"]
  }
}
```

Agents only receive MCPs explicitly listed here. `"*"` entries apply to all agents unless overridden.

## Provider override directories

When `cliProvider` is `"opencode"`, the engine looks for prompt/agent overrides in:
- `.harness/prompts-opencode/` — OpenCode-flavored prompt variants
- `.harness/agents-opencode/` — OpenCode-flavored agent role variants

Files only need to exist in the override dir if they differ from the base dir — the engine falls back to the base dir per-file.
