# MCP Scope Guide

How the `mcpScope` field in `harness.config.json` controls which MCP servers each sub-agent receives.

## How it works

Each cycle spawns a sub-agent (e.g. `frontend-subagent`) via the CLI adapter. The engine reads `mcpScope` and passes the listed MCP servers to that agent's spawn config. An agent only has access to MCPs explicitly listed for it — it will not use MCPs it wasn't given, even if they're available on your machine.

## mcpScope structure

```json
{
  "mcpScope": {
    "*": [],
    "frontend-subagent": ["playwright", "shadcn"],
    "tester-subagent": ["playwright"],
    "smoke": ["playwright"],
    "backend-subagent": [],
    "distributed-subagent": [],
    "infra-subagent": [],
    "explorer-subagent": [],
    "planner-subagent": []
  }
}
```

- `"*"` — applies to ALL agents. Add an MCP here to give every agent access.
- Named keys override `"*"` — the agent gets `"*"` entries PLUS its own named entries.
- Empty array `[]` means the agent gets only whatever is in `"*"` (usually nothing extra).

## Common MCP names

| MCP name | What it gives the agent |
|---|---|
| `playwright` | Browser automation — used by tester and smoke cycles |
| `shadcn` | shadcn/ui component search and installation |
| `github` | GitHub API access |

The MCP names must match the server names as registered in your `.mcp.json` or Claude Code MCP config.

## Special agent: smoke

`"smoke"` is not a sub-agent — it's the smoke-test cycle. It always gets `playwright` if Playwright MCP is available. Add URLs to `smokeUrls` in `harness.config.json` to enable smoke testing.
