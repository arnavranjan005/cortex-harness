import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import chalk from "chalk";
import { isWindows } from "../constants.mjs";
import { buildScopedOpenCodeConfigFile } from "./opencode-mcp-config.mjs";
import { logger } from "../../logger.mjs";

// Same where.exe retry pattern as claude-adapter.mjs, targeting "opencode".
const OPENCODE_EXE_RESOLVE_RETRIES = 3;
const OPENCODE_EXE_RESOLVE_RETRY_DELAY_MS = 200;

// npm's global "opencode.cmd" shim is a batch file that ultimately calls a
// real native binary (node_modules/opencode-ai/bin/opencode.exe). Confirmed
// live: invoking the .cmd shim from PowerShell routes through cmd.exe's
// line-based command parser, which silently truncates any argument at its
// first embedded newline (a 3-line test string arrived with everything past
// line 1 dropped) — this is what was actually breaking multi-line prompts,
// not just naive string interpolation. Invoking the real .exe directly
// bypasses cmd.exe and preserves multi-line arguments intact (also verified
// live). This regex extracts that real binary's path out of the shim.
const CMD_SHIM_EXE_PATTERN = /"%dp0%\\(.+?\.exe)"/i;

function resolveRealExeFromCmdShim(cmdPath) {
  try {
    const content = readFileSync(cmdPath, "utf8");
    const match = content.match(CMD_SHIM_EXE_PATTERN);
    if (!match) return null;
    const realExe = join(dirname(cmdPath), match[1]);
    return existsSync(realExe) ? realExe : null;
  } catch {
    return null;
  }
}

function resolveExecutable() {
  if (!isWindows) return "opencode";
  for (let attempt = 1; attempt <= OPENCODE_EXE_RESOLVE_RETRIES; attempt++) {
    try {
      const lines = execSync("where.exe opencode", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const cmdShim = lines.find((l) => l.toLowerCase().endsWith(".cmd"));
      if (cmdShim) {
        const realExe = resolveRealExeFromCmdShim(cmdShim);
        if (realExe) return realExe;
      }
      const resolved = cmdShim ?? lines[0];
      if (resolved) return resolved;
    } catch {
      // fall through to retry
    }
    if (attempt < OPENCODE_EXE_RESOLVE_RETRIES) {
      const until = Date.now() + OPENCODE_EXE_RESOLVE_RETRY_DELAY_MS;
      while (Date.now() < until) { /* brief synchronous wait before retry */ }
    }
  }
  logger.warn(
    chalk.yellow(
      `  [WARN] could not resolve full path to "opencode" via where.exe after ${OPENCODE_EXE_RESOLVE_RETRIES} attempts — ` +
      `falling back to bare "opencode".`,
    ),
  );
  return "opencode";
}

const OPENCODE_EXE = resolveExecutable();

// NOTE: unlike Claude (`-p` with no value reads the prompt from stdin),
// OpenCode's `run` subcommand takes the message as a positional argument —
// confirmed live (`opencode run "<message>" --format json`). Long/multi-line
// prompts on Windows have not been verified through this path yet; if shell
// quoting turns out to be an issue the same write-to-file approach used for
// Claude's PowerShell wrapper would need a stdin-capable invocation, which
// is unconfirmed for `opencode run` as of this writing.
//
// No `--agent <name>` flag — confirmed live this was dead code: an
// unregistered agent name (every Cortex agent name, always) silently falls
// back to the default agent with a stderr warning, and registering a custom
// agent to make it resolve caused an unexplained hang. This isn't a gap —
// Claude's adapter never selects an agent via a CLI flag either. Role
// identity for every cycle, on both adapters, lives entirely in the prompt
// text via {{AGENT_ROLE}} (see prompt-builder.mjs).
//
// `mcpConfigPath`, when present, is applied via the OPENCODE_CONFIG
// environment variable rather than a CLI flag — confirmed live that OpenCode
// reads it, merges it with the project's real opencode.json without
// overwriting keys the project file doesn't itself set, and never touches
// that file on disk. This is what makes per-cycle MCP scoping safe for
// parallel cycles: each cycle's env var points at its own disposable file
// (see opencode-mcp-config.mjs), never a shared one.
// On Windows, the prompt is read from `promptFile` into a PowerShell
// variable and passed as an array element (`& exe run $prompt ...`) rather
// than interpolated into a quoted string literal — confirmed live that
// naive `"${prompt}"` interpolation breaks the PowerShell parser for any
// multi-line/markdown prompt (real task prompts routinely contain lines
// starting with "-", embedded double-quotes, etc., which either close the
// quoted literal early or get parsed as PowerShell operators/statements).
// `opencode run`'s positional message arg has no stdin alternative
// (confirmed via `opencode run --help`), so the value still has to reach it
// as a real argument — just never as literal text inside the .ps1 file.
function buildSpawnPlan({ prompt, isWindows: win, mcpConfigPath, promptFile }) {
  const args = ["run", prompt, "--format", "json"];
  const env = mcpConfigPath ? { OPENCODE_CONFIG: mcpConfigPath } : undefined;

  if (win) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "__PS_FILE__"],
      psContent: `$prompt = Get-Content -Path "${promptFile}" -Raw -Encoding UTF8\n& "${OPENCODE_EXE}" run $prompt --format json\n`,
      env,
    };
  }

  return { command: OPENCODE_EXE, args, env };
}

function mcpToolName(serverName, toolName) {
  return `${serverName}_${toolName}`;
}

function mcpServerWildcard(serverName) {
  return `${serverName}_*`;
}

// Smoke-check sub-session. No flags exist for allowedTools/maxTurns/budgetUsd
// (confirmed via `opencode run --help` — not present), so those params are
// accepted for interface symmetry with claude-adapter but intentionally
// unused here — the caller's existing 90s wall-clock timeout is the only cap
// that applies for this adapter. MCP scoping still works correctly via
// mcpConfigPath -> OPENCODE_CONFIG, same as the main buildSpawnPlan.
function buildSmokeCheckSpawnPlan({ prompt, mcpConfigPath, isWindows: win, promptFile }) {
  const env = mcpConfigPath ? { OPENCODE_CONFIG: mcpConfigPath } : undefined;
  const args = ["run", prompt, "--format", "json"];

  if (win) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "__PS_FILE__"],
      psContent: `$prompt = Get-Content -Path "${promptFile}" -Raw -Encoding UTF8\n& "${OPENCODE_EXE}" run $prompt --format json\n`,
      env,
      outputFormat: "json-stream",
    };
  }

  return { command: OPENCODE_EXE, args, env, outputFormat: "json-stream" };
}

// Same shape as buildSmokeCheckSpawnPlan but for short, MCP-free sub-sessions:
// turn-cap summary, chain-task's chain/no-chain decision, pre-smoke URL
// detection. maxTurns/allowedToolPatterns/budgetUsd accepted for interface
// symmetry with claude-adapter but unused — no such flags exist for
// `opencode run` (confirmed via `opencode run --help`).
function buildSummarySpawnPlan({ prompt, isWindows: win, promptFile }) {
  const args = ["run", prompt, "--format", "json"];

  if (win) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "__PS_FILE__"],
      psContent: `$prompt = Get-Content -Path "${promptFile}" -Raw -Encoding UTF8\n& "${OPENCODE_EXE}" run $prompt --format json\n`,
      outputFormat: "json-stream",
    };
  }

  return { command: OPENCODE_EXE, args, outputFormat: "json-stream" };
}

function parseEventLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Normalizes the real event schema captured from a live `opencode run
// --format json` invocation:
//   {"type":"step_start", "part":{...}}
//   {"type":"text", "part":{"text":"...", ...}}
//   {"type":"tool_use", "part":{"tool":"...", "callID":"...", "state":{"status":...,"input":...,"output":...}}}
//   {"type":"step_finish", "part":{"tokens":{"total":...,"input":...,"output":...,"reasoning":...,"cache":{...}}, "cost":..., "reason":"stop"|"tool-calls"}}
//
// OpenCode has no single terminating "result" event with an overall cost
// total (unlike Claude) — cost/tokens are per step_finish. Callers should
// accumulate costUsd across "turn" events rather than expecting one final
// total, and rely on the existing process-close text-signal fallback
// (CYCLE_COMPLETE / CYCLE_PARTIAL convention) for end-of-cycle detection.
function extractResult(event) {
  // sessionID is passed through on every kind below so callers (cycle-runner)
  // can capture it and resolve the actual model post-hoc via
  // resolveModelInfo() — confirmed live that no event in this stream ever
  // carries the model itself (unlike Claude's system/init event), only
  // `opencode export <sessionID>` exposes it (info.model.id/providerID).
  if (event.type === "text") {
    return { kind: "assistant", text: event.part?.text?.trim() || null, toolCalls: [], sessionID: event.sessionID };
  }

  if (event.type === "tool_use") {
    const part = event.part ?? {};
    return {
      kind: "assistant",
      text: null,
      toolCalls: [{ id: part.callID, name: part.tool, input: part.state?.input, isError: part.state?.status === "error" }],
      sessionID: event.sessionID,
    };
  }

  if (event.type === "step_finish") {
    const part = event.part ?? {};
    return {
      kind: "turn",
      costUsd: typeof part.cost === "number" ? part.cost : null,
      tokens: part.tokens ?? null,
      reason: part.reason ?? null,
      sessionID: event.sessionID,
    };
  }

  // A hard provider failure (billing, invalid model, auth) — confirmed live as
  // {"type":"error","error":{"name":"APIError","data":{"message":"No payment
  // method...","statusCode":401}}}. This arrives in place of any "text" event,
  // so without surfacing it cycle-runner has nothing to classify the failure
  // from: finalMessage/rawText both stay empty, the process exits 0 turns, and
  // it gets misreported as a generic "0-turn cycle wrote no output" partial
  // instead of the actual cause.
  if (event.type === "error") {
    const message = event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? "Unknown provider error";
    return { kind: "stream_error", text: message, sessionID: event.sessionID };
  }

  return null;
}

// Wording unconfirmed against a real OpenCode rate-limit response — this is
// a best-effort generic check, not verified live like the rest of this
// adapter. Revisit once a real rate-limit case is observed.
function detectRateLimit(message) {
  return message.includes("rate limit") || message.includes("rate-limit") || message.includes("usage limit");
}

// Post-hoc model lookup: confirmed live that `opencode export <sessionID>`
// returns `info.model.{id,providerID}` even though the `run --format json`
// stream itself never carries it. `opencode export` prints a leading
// "Exporting session: <id>" line before the JSON body, so this slices from
// the first "{" rather than parsing the whole stdout. Returns null on any
// failure (missing session, opencode not resolvable, etc.) — this is
// best-effort telemetry, never load-bearing for cycle execution.
function resolveModelInfo(sessionID, { cwd } = {}) {
  if (!sessionID) return null;
  try {
    const stdout = execSync(`"${OPENCODE_EXE}" export ${sessionID}`, {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(stdout.slice(jsonStart));
    const model = parsed?.info?.model;
    if (!model?.id) return null;
    return { model: model.id, provider: model.providerID ?? "opencode" };
  } catch {
    return null;
  }
}

export const opencodeAdapter = {
  name: "opencode",
  resolveExecutable,
  buildSpawnPlan,
  buildSmokeCheckSpawnPlan,
  buildSummarySpawnPlan,
  mcpToolName,
  mcpServerWildcard,
  parseEventLine,
  extractResult,
  detectRateLimit,
  resolveModelInfo,
  buildScopedConfig: buildScopedOpenCodeConfigFile,
  capabilities: {
    // false = no per-invocation MCP config override (no --mcp-config
    // equivalent). MCP scoping for OpenCode instead goes through
    // mcpScopeMechanism: "config-file" — see opencode-mcp-config.mjs.
    supportsMcp: false,
    supportsCostTelemetry: true,
    supportsStreamEvents: true,
    mcpScopeMechanism: "config-file",
  },
};

export { OPENCODE_EXE };
