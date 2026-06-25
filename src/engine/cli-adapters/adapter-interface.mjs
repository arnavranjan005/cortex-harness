// Contract every CLI backend adapter must implement. JSDoc only — no runtime
// code here. cycle-runner.mjs calls through this shape instead of assuming
// Claude Code's executable, flags, or stream-json event schema directly.

/**
 * @typedef {object} SpawnPlan
 * @property {string} command - executable to spawn (e.g. "claude", "powershell.exe")
 * @property {string[]} args
 * @property {string} [psFile] - Windows only: path to write `psContent` to before spawning
 * @property {string} [psContent] - Windows only: PowerShell script content
 * @property {Object<string,string>} [env] - extra environment variables to merge into the
 *   spawned process's env (e.g. OpenCode's OPENCODE_CONFIG) — merged with process.env by
 *   the caller, not a replacement for it.
 */

/**
 * @typedef {object} NormalizedEvent
 * @property {'turn'|'tool_result'|'final'|'rate_limit'|'stream_error'|'unknown'} kind
 * @property {string} [costUsd]
 * @property {number} [numTurns]
 * @property {string} [finalMessage]
 * @property {boolean} [isError]
 * @property {string} [text] - for 'stream_error': the provider's raw error message
 *   (e.g. "No payment method. Add a payment method here: <url>") — cycle-runner
 *   feeds this straight into finalMessage so classifySignal can see it, since a
 *   hard provider failure like this otherwise replaces every "text"/"final"
 *   event the cycle would normally produce.
 */

/**
 * @typedef {object} CliAdapter
 *
 * @property {() => string} resolveExecutable
 *   Resolve the full path (or bare command) for this CLI's executable.
 *   Called once per process and cached by the adapter module itself.
 *
 * @property {(opts: {
 *   prompt: string,
 *   cycle: object,
 *   budgetUsd: number,
 *   mcpConfigPath: string|null,
 *   promptFile: string,
 *   isWindows: boolean,
 * }) => SpawnPlan} buildSpawnPlan
 *   Build the args (and, on Windows, the PowerShell wrapper) needed to run
 *   one cycle. `mcpConfigPath` is null when this adapter's mcpScopeMechanism
 *   is "none" or no MCP servers are scoped for this cycle. Adapters with
 *   mcpScopeMechanism "flag" turn it into a CLI flag; adapters with
 *   "config-file" return it via the SpawnPlan's `env` field instead.
 *
 * @property {(line: string) => object|null} parseEventLine
 *   Parse one line of stdout into this CLI's raw event shape. Return null if
 *   the line isn't parseable JSON — caller falls back to raw text accumulation.
 *
 * @property {(event: object) => NormalizedEvent|null} extractResult
 *   Normalize a raw parsed event into the shape cycle-runner.mjs switches on.
 *   Return null for events that carry no turn/cost/signal information.
 *
 * @property {(message: string) => boolean} detectRateLimit
 *   Detect a rate-limit / usage-limit condition from accumulated text output.
 *
 * @property {(serverName: string, toolName: string) => string} [mcpToolName]
 *   Format the addressable name for one specific MCP tool, in this CLI's own
 *   convention — used by smoke-orchestrator.mjs when building prompt text
 *   that references a specific tool call (e.g. Claude: "mcp__playwright__
 *   browser_navigate", OpenCode: "playwright_browser_navigate" — confirmed
 *   live these conventions genuinely differ, not just a naming preference).
 *   Optional — only adapters used by smoke-orchestrator.mjs need it.
 *
 * @property {(serverName: string) => string} [mcpServerWildcard]
 *   Format a wildcard reference to every tool on one MCP server, for prose
 *   like "use this MCP session for everything" (e.g. Claude:
 *   "mcp__playwright__*", OpenCode: "playwright_*"). Optional, same callers
 *   as mcpToolName.
 *
 * @property {(opts: {
 *   prompt: string,
 *   mcpConfigPath: string|null,
 *   isWindows: boolean,
 *   allowedToolPatterns?: string[],
 *   maxTurns?: number,
 *   budgetUsd?: number,
 *   promptFile?: string,
 * }) => SpawnPlan} [buildSmokeCheckSpawnPlan]
 *   Build the spawn plan for a smoke-check sub-session — distinct from
 *   buildSpawnPlan because smoke needs MCP-restricted, mostly-text output,
 *   with its own turn/budget cap, not the main cycle shape. `allowedToolPatterns`/
 *   `maxTurns`/`budgetUsd` are honored where the underlying CLI has a flag for
 *   them (Claude: --allowedTools/--max-turns/--max-budget-usd) and otherwise
 *   accepted-but-unused for interface symmetry (OpenCode has no such flags —
 *   confirmed via `opencode run --help` — so the caller's own wall-clock
 *   timeout is the only cap that applies). Optional — only adapters used by
 *   smoke-orchestrator.mjs need it.
 *
 * @property {{
 *   supportsMcp: boolean,
 *   supportsCostTelemetry: boolean,
 *   supportsStreamEvents: boolean,
 *   mcpScopeMechanism: 'flag'|'config-file'|'none',
 * }} capabilities
 *   supportsMcp: true if this adapter accepts a per-invocation MCP config
 *     override (e.g. Claude's --mcp-config). false means there's no such flag —
 *     see mcpScopeMechanism for how (or whether) scoping happens instead.
 *   supportsCostTelemetry: true if extractResult can report real costUsd.
 *   supportsStreamEvents: true if buildSpawnPlan requests a structured event
 *     stream (vs. a single blob of final text).
 *   mcpScopeMechanism: how cycle-runner.mjs enforces per-cycle MCP scoping for
 *     this adapter — distinct from supportsMcp because the two backends use
 *     genuinely different mechanisms, not just "on vs. off":
 *       "flag"        — pass a disposable per-invocation config file via a CLI
 *                        flag (Claude's mcpConfigPath / --mcp-config). The
 *                        temp file is written before spawn, deleted after.
 *       "config-file" — no CLI flag exists, but a disposable per-invocation
 *                        config file can still be applied via an environment
 *                        variable instead (OpenCode's OPENCODE_CONFIG,
 *                        confirmed live to merge with the project's real
 *                        opencode.json without overwriting keys that file
 *                        doesn't itself set, and to never touch that file on
 *                        disk). Same disposable-temp-file lifecycle as
 *                        "flag" — written before spawn, deleted after,
 *                        cycle-unique filename so parallel cycles never race
 *                        on a shared file. Adapters using this must export a
 *                        `buildScopedConfig({ ROOT, allowedServerNames,
 *                        cycleId, tmpDir }) => string|null` (the temp file
 *                        path, or null if there's nothing to scope) and
 *                        return an `env` field from buildSpawnPlan applying
 *                        it — see opencode-mcp-config.mjs / opencode-adapter.mjs.
 *       "none"        — no MCP scoping mechanism at all; cycle-runner skips
 *                        MCP-related work entirely for this adapter.
 */

export {};
