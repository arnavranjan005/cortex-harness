import { execSync } from "child_process";
import chalk from "chalk";
import { isWindows } from "../constants.mjs";
import { logger } from "../../logger.mjs";

// Moved from claude-exe.mjs verbatim — see that file for the re-export kept
// for existing CLAUDE_EXE importers (run-autonomous.mjs, smoke-orchestrator.mjs,
// chain-task.mjs).
const CLAUDE_EXE_RESOLVE_RETRIES = 3;
const CLAUDE_EXE_RESOLVE_RETRY_DELAY_MS = 200;

function resolveExecutable() {
  if (!isWindows) return "claude";
  for (let attempt = 1; attempt <= CLAUDE_EXE_RESOLVE_RETRIES; attempt++) {
    try {
      const lines = execSync("where.exe claude", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const resolved = lines.find((l) => l.toLowerCase().endsWith(".cmd")) ?? lines[0];
      if (resolved) return resolved;
    } catch {
      // fall through to retry
    }
    if (attempt < CLAUDE_EXE_RESOLVE_RETRIES) {
      const until = Date.now() + CLAUDE_EXE_RESOLVE_RETRY_DELAY_MS;
      while (Date.now() < until) { /* brief synchronous wait before retry */ }
    }
  }
  logger.warn(
    chalk.yellow(
      `  [WARN] could not resolve full path to "claude" via where.exe after ${CLAUDE_EXE_RESOLVE_RETRIES} attempts — ` +
      `falling back to bare "claude", which may fail to resolve inside -NoProfile PowerShell cycles.`,
    ),
  );
  return "claude";
}

// Resolved once per process and shared by every call site.
const CLAUDE_EXE = resolveExecutable();

function buildSpawnPlan({ prompt, budgetUsd, mcpConfigPath, promptFile, isWindows: win }) {
  const budgetArg = String(budgetUsd);
  const mcpArgs = mcpConfigPath ? ["--mcp-config", mcpConfigPath] : [];

  if (win) {
    const mcpConfigFlag = mcpConfigPath ? ` --mcp-config "${mcpConfigPath}"` : "";
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "__PS_FILE__"],
      psContent:
        `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --output-format stream-json --verbose --max-budget-usd ${budgetArg} --dangerously-skip-permissions${mcpConfigFlag}\n`,
    };
  }

  return {
    command: "claude",
    args: [
      "-p", prompt, "--output-format", "stream-json", "--verbose",
      "--max-budget-usd", budgetArg, "--dangerously-skip-permissions",
      ...mcpArgs,
    ],
  };
}

// Same shape as buildSpawnPlan but for short, constrained sub-sessions: the
// turn-cap progress summary (maxTurns 3, no tool restriction — defaults
// preserve that exact behavior), chain-task's chain/no-chain decision
// (maxTurns 1), and pre-smoke URL detection (maxTurns 10, allowedToolPatterns
// ["Read"]). No MCP in any of these uses.
// Uses stream-json (not plain "text") specifically so the system/init event
// — and therefore the model — is actually present in the output. Confirmed
// live that "text" mode emits zero JSON events at all, which silently broke
// model resolution for every buildSummarySpawnPlan caller (chain-task's
// chain-decision log, cycle-runner's turn-cap summary, run-autonomous's
// pre-smoke step) — they'd always report "model unknown" for Claude.
// normalizeAdapterOutput already handles "json-stream" generically for any
// adapter, so downstream callers need no changes.
function buildSummarySpawnPlan({ prompt, budgetUsd, promptFile, isWindows: win, maxTurns = 3, allowedToolPatterns }) {
  const allowedToolsFlag = allowedToolPatterns?.length ? ` --allowedTools "${allowedToolPatterns.join(",")}"` : "";
  const allowedToolsArgs = allowedToolPatterns?.length ? ["--allowedTools", allowedToolPatterns.join(",")] : [];

  if (win) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "__PS_FILE__"],
      psContent:
        `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --output-format stream-json --verbose --max-turns ${maxTurns} --max-budget-usd ${budgetUsd}${allowedToolsFlag} --dangerously-skip-permissions\n`,
      outputFormat: "json-stream",
    };
  }
  return {
    command: "claude",
    args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(maxTurns),
      "--max-budget-usd", String(budgetUsd), ...allowedToolsArgs, "--dangerously-skip-permissions"],
    outputFormat: "json-stream",
  };
}

function mcpToolName(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`;
}

function mcpServerWildcard(serverName) {
  return `mcp__${serverName}__*`;
}

// Smoke-check sub-session: extracted 1:1 from smoke-orchestrator.mjs's prior
// inline spawnMiniClaude logic — same flags, zero behavior change. Distinct
// from buildSpawnPlan (stream-json, no tool restriction) and
// buildSummarySpawnPlan (no MCP, fixed 3-turn cap): smoke needs MCP-restricted,
// text output, a configurable turn/budget cap.
function buildSmokeCheckSpawnPlan({ prompt, mcpConfigPath, isWindows: win, allowedToolPatterns, maxTurns, budgetUsd, promptFile }) {
  const allowedTools = (allowedToolPatterns ?? []).join(",");

  if (win) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "__PS_FILE__"],
      psContent:
        `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --mcp-config "${mcpConfigPath}" --allowedTools "${allowedTools}" --output-format text --max-turns ${maxTurns} --max-budget-usd ${budgetUsd} --dangerously-skip-permissions\n`,
      outputFormat: "text",
    };
  }

  return {
    command: CLAUDE_EXE,
    args: [
      "-p", prompt, "--mcp-config", mcpConfigPath,
      "--allowedTools", allowedTools,
      "--output-format", "text", "--max-turns", String(maxTurns),
      "--max-budget-usd", String(budgetUsd), "--dangerously-skip-permissions",
    ],
    outputFormat: "text",
  };
}

function parseEventLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Normalizes Claude's stream-json event shapes into the kinds cycle-runner
// switches on. Raw tool_use/tool_result payloads are passed through mostly
// as-is (just unwrapped from Claude's message/content nesting) since
// cycle-runner's turn-cap bookkeeping needs the actual id/name/input shape.
function extractResult(event) {
  // Fires once, immediately, on the system/init event every Claude session
  // emits first — confirmed live the "model" field is present there
  // (e.g. "claude-sonnet-4-6"), so this is available synchronously from the
  // stream with no extra round-trip, unlike OpenCode (see opencode-adapter's
  // resolveModelInfo).
  if (event.type === "system" && event.subtype === "init" && event.model) {
    return { kind: "model_info", model: event.model };
  }

  if (event.type === "rate_limit_event" && event.rate_limit_info?.resetsAt) {
    return { kind: "rate_limit", resetsAt: event.rate_limit_info.resetsAt };
  }

  if (event.type === "assistant" || event.role === "assistant") {
    const content = event.message?.content ?? [];
    const textBlock = content.find((c) => c.type === "text");
    const toolCalls = content.filter((c) => c.type === "tool_use");
    return {
      kind: "assistant",
      text: textBlock?.text?.trim() || null,
      toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name, input: t.input })),
    };
  }

  if (event.type === "user") {
    const resultBlocks = Array.isArray(event.message?.content)
      ? event.message.content.filter((c) => c.type === "tool_result")
      : [];
    return {
      kind: "tool_result",
      results: resultBlocks.map((r) => ({ toolUseId: r.tool_use_id, isError: !!r.is_error })),
    };
  }

  // A hard provider failure (billing, auth, invalid model) — Claude Code's
  // stream-json "result" event carries is_error:true with the failure text in
  // `result` instead of a separate event type (unlike OpenCode's dedicated
  // "error" event — see opencode-adapter.mjs). Routed to the same
  // 'stream_error' kind so every call site checks both adapters identically
  // via extractStreamError() rather than adapter-specific branching.
  if (event.type === "result" && event.is_error === true) {
    return {
      kind: "stream_error",
      text: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "Unknown provider error"),
    };
  }

  if (event.type === "result") {
    return {
      kind: "final",
      finalMessage:
        typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
      numTurns: typeof event.num_turns === "number" ? event.num_turns : null,
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
    };
  }

  if (typeof event.cost_usd === "number") {
    return { kind: "cost", costUsd: event.cost_usd };
  }

  return null;
}

function detectRateLimit(message) {
  return (
    message.includes("You've hit your session limit") ||
    message.includes("You've hit your weekly limit") ||
    message.includes("session limit") ||
    message.includes("weekly limit") ||
    message.includes("rate limit") ||
    message.includes("rate-limit")
  );
}

export const claudeAdapter = {
  name: "claude",
  resolveExecutable,
  buildSpawnPlan,
  buildSummarySpawnPlan,
  buildSmokeCheckSpawnPlan,
  mcpToolName,
  mcpServerWildcard,
  parseEventLine,
  extractResult,
  detectRateLimit,
  capabilities: {
    supportsMcp: true,
    supportsCostTelemetry: true,
    supportsStreamEvents: true,
    mcpScopeMechanism: "flag",
  },
};

export { CLAUDE_EXE, resolveExecutable as resolveClaudeExe };
