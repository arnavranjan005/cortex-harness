import { Option } from "commander";
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { spawn } from "child_process";

// Claude Code built-in tools — never come from MCP.
const BUILTIN_TOOLS = new Set([
  "Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent",
  "WebFetch", "WebSearch", "NotebookEdit", "NotebookRead",
  "PowerShell", "TodoRead", "TodoWrite",
  // Skill/tool infrastructure
  "Skill", "ToolSearch",
  // Task tracking
  "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
  // Scheduling / cron
  "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  // Session / workspace modes
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  // Notifications and triggers
  "PushNotification", "RemoteTrigger", "Monitor",
  // MCP resource inspection (built-in, not an MCP server itself)
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  // User interaction
  "AskUserQuestion",
]);

function extractToolCalls(runPath) {
  const lines = fs.readFileSync(runPath, "utf8").split("\n").filter(Boolean);
  const calls = new Map(); // toolName → count

  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      // Tool calls live in raw Claude stream events: type=assistant, content[].type=tool_use
      if (ev.raw) {
        const raw = typeof ev.raw === "string" ? JSON.parse(ev.raw) : ev.raw;
        if ((raw.type === "assistant" || raw.role === "assistant") && Array.isArray(raw.message?.content)) {
          for (const block of raw.message.content) {
            if (block.type === "tool_use" && block.name) {
              calls.set(block.name, (calls.get(block.name) ?? 0) + 1);
            }
          }
        }
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return calls;
}

// Claude Code names every MCP tool call "mcp__<server>__<tool>" — that prefix
// is enough to attribute a call to its server without any per-server pattern,
// known or not. Server names are looked up case-sensitively against the
// names actually registered in .mcp.json so attribution still reflects reality
// (e.g. a server removed from .mcp.json after the run still shows up by name).
function attributeTools(toolCalls) {
  const attribution = new Map(); // serverName → Map<toolName, count>
  const builtins = new Map();    // known Claude Code internal tools
  const unknownMcp = new Map();  // not built-in, no mcp__ prefix → unexpected

  for (const [tool, count] of toolCalls) {
    if (BUILTIN_TOOLS.has(tool)) {
      builtins.set(tool, count);
      continue;
    }

    const parts = tool.split("__");
    if (parts[0] === "mcp" && parts.length >= 3) {
      const serverName = parts[1];
      if (!attribution.has(serverName)) attribution.set(serverName, new Map());
      attribution.get(serverName).set(tool, count);
      continue;
    }

    unknownMcp.set(tool, count);
  }
  return { attribution, builtins, unknownMcp };
}

const MCP_INIT_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cortex-harness", version: "1.0.0" },
  },
}) + "\n";

// Spawns a stdio MCP server, sends the initialize handshake, returns result.
function checkServer(name, serverConfig, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (serverConfig.type && serverConfig.type !== "stdio") {
      resolve({ ok: false, error: `type "${serverConfig.type}" is not supported for health check (only stdio)` });
      return;
    }

    const start = Date.now();
    let stdout = "";
    let proc;

    try {
      proc = spawn(serverConfig.command, serverConfig.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(serverConfig.env ?? {}) },
        // On Windows, npm/npx install as .ps1/.cmd — shell:true lets the OS resolve them.
        shell: process.platform === "win32",
      });
    } catch (err) {
      resolve({ ok: false, error: `Failed to spawn: ${err.message}` });
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: `Timed out after ${timeoutMs / 1000}s — server did not respond` });
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      // MCP responses are newline-delimited JSON; look for the initialize response
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            try { proc.kill(); } catch { /* ignore */ }
            resolve({
              ok: true,
              latencyMs: Date.now() - start,
              serverInfo: msg.result.serverInfo ?? null,
              protocolVersion: msg.result.protocolVersion ?? null,
            });
            return;
          }
          if (msg.id === 1 && msg.error) {
            clearTimeout(timer);
            try { proc.kill(); } catch { /* ignore */ }
            resolve({ ok: false, error: `MCP error: ${msg.error.message ?? JSON.stringify(msg.error)}` });
            return;
          }
        } catch { /* keep buffering */ }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        resolve({ ok: false, error: `Process exited (code ${code}) with no output` });
      }
    });

    // Send initialize request
    try {
      proc.stdin.write(MCP_INIT_REQUEST);
    } catch (err) {
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: `Failed to write to stdin: ${err.message}` });
    }
  });
}

// Simple Levenshtein distance for typo suggestions.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function suggestCommand(input, choices) {
  return choices
    .map((c) => ({ c, d: levenshtein(input, c) }))
    .sort((a, b) => a.d - b.d)[0];
}

export function registerMcpCommand(program) {
  const SUB_COMMANDS = ["list", "check", "usage"];

  const mcpCmd = program
    .command("mcp")
    .description("Manage and inspect MCP servers registered in .mcp.json")
    .addHelpText("after", `
Examples:
  $ cortex-harness mcp                    Show servers and last-run tool usage
  $ cortex-harness mcp list               List all registered MCP servers
  $ cortex-harness mcp check              Verify each server responds (initialize handshake)
  $ cortex-harness mcp usage              Show tool calls from the latest run log
  $ cortex-harness mcp usage --run <ts>   Show tool calls from a specific run log

Subcommands:
  list    Print every server name, type, and command from .mcp.json
  check   Spawn each server and send an MCP initialize handshake — reports latency and version
  usage   Parse a .harness/runs/*.jsonl log and attribute tool calls to their MCP servers
    `);

  // ── unknown subcommand → suggest closest match ────────────────────────────
  mcpCmd.on("command:*", (operands) => {
    const input = operands[0];
    const best = suggestCommand(input, SUB_COMMANDS);
    console.error(chalk.red(`  Unknown mcp subcommand: "${input}"`));
    if (best.d <= 3) {
      console.log(chalk.yellow(`  Did you mean: ${chalk.bold(`cortex-harness mcp ${best.c}`)}`));
    }
    console.log(chalk.dim(`  Available subcommands: ${SUB_COMMANDS.join(", ")}`));
    console.log(chalk.dim(`  Run "cortex-harness mcp --help" for usage.`));
    process.exit(1);
  });

  // ── default: servers + last run usage ────────────────────────────────────────
  mcpCmd.action(async () => {
    await showServers(process.cwd());
    await showUsage(process.cwd(), null);
  });

  // ── mcp list ─────────────────────────────────────────────────────────────────
  mcpCmd
    .command("list")
    .description("List all MCP servers registered in .mcp.json (name, type, command)")
    .action(async () => {
      await showServers(process.cwd());
    });

  // ── mcp check ────────────────────────────────────────────────────────────────
  mcpCmd
    .command("check")
    .description("Spawn each MCP server and verify it responds to the initialize handshake")
    .addHelpText("after", `
  Spawns every server listed in .mcp.json, sends an MCP initialize request,
  and reports whether it responded, its protocol version, and startup latency.
  Useful for confirming a server is installed and reachable before a harness run.
    `)
    .action(async () => {
      await showCheck(process.cwd());
    });

  // ── mcp usage ────────────────────────────────────────────────────────────────
  mcpCmd
    .command("usage")
    .description("Show MCP tool calls from a harness run log, attributed per server")
    .addHelpText("after", `
  Reads .harness/runs/<timestamp>.jsonl and groups every tool call by MCP server.
  Built-in Claude Code tools (Read, Edit, Bash, etc.) are shown separately.
  Tool calls that don't match any registered server are flagged as unregistered.

  Examples:
    $ cortex-harness mcp usage                   Inspect the latest run
    $ cortex-harness mcp usage --run 2024-01-15  Inspect a specific run
    `)
    .addOption(
      new Option(
        "--run <timestamp>",
        "Run timestamp to inspect (filename in .harness/runs/ without .jsonl extension)",
      ).default(null),
    )
    .action(async (options) => {
      await showUsage(process.cwd(), options.run);
    });
}

async function showServers(cwd) {
  const mcpPath = path.join(cwd, ".mcp.json");
  const W = Math.min(process.stdout.columns || 72, 72);
  const line = chalk.dim("─".repeat(W));

  console.log(`\n${chalk.bold.cyan("  Registered MCP Servers")}`);
  console.log(line);

  if (!(await fs.pathExists(mcpPath))) {
    console.log(chalk.dim("  No .mcp.json found in this directory."));
    console.log(chalk.dim('  Run "cortex-harness init" to register the Playwright MCP server.'));
    console.log();
    return;
  }

  let mcp;
  try {
    mcp = await fs.readJson(mcpPath);
  } catch {
    console.log(chalk.red("  .mcp.json exists but could not be parsed."));
    console.log();
    return;
  }

  const servers = mcp.mcpServers ?? {};
  const names = Object.keys(servers);

  if (!names.length) {
    console.log(chalk.dim("  .mcp.json has no servers registered."));
    console.log();
    return;
  }

  // A server only ends up in mcpScope when it arrived via `init`'s template
  // merge (or someone ran `config add-mcp-scope` by hand). Servers added
  // directly to .mcp.json — by editing the file or via another tool — never
  // pass through that flow, so flag any with no scope entry anywhere instead
  // of silently letting every cycle skip it.
  const scopedServers = new Set();
  try {
    const configPath = path.join(cwd, "harness.config.json");
    if (await fs.pathExists(configPath)) {
      const harnessConfig = await fs.readJson(configPath);
      for (const list of Object.values(harnessConfig.mcpScope ?? {})) {
        for (const s of list ?? []) scopedServers.add(s);
      }
    }
  } catch { /* harness.config.json missing or unparsable — skip the scope check */ }

  const unscoped = [];
  for (const name of names) {
    const s = servers[name];
    const cmd = [s.command, ...(s.args ?? [])].join(" ");
    const isUnscoped = scopedServers.size > 0 && !scopedServers.has(name);
    if (isUnscoped) unscoped.push(name);
    console.log(`  ${chalk.green("●")} ${chalk.bold(name)}${isUnscoped ? chalk.yellow("  (not scoped to any agent)") : ""}`);
    console.log(`    ${chalk.dim("type:")} ${s.type ?? "stdio"}  ${chalk.dim("cmd:")} ${chalk.cyan(cmd)}`);
  }
  if (unscoped.length) {
    console.log(chalk.yellow(`\n  ${unscoped.join(", ")} won't load for any agent until scoped.`));
    console.log(chalk.dim(`  Run "cortex-harness config" → MCP server scope, or "cortex-harness config add-mcp-scope <agent> <server>".`));
  }
  console.log(chalk.dim(`\n  Run "cortex-harness mcp check" to verify servers are reachable.`));
  console.log();
}

async function showCheck(cwd) {
  const mcpPath = path.join(cwd, ".mcp.json");
  const W = Math.min(process.stdout.columns || 72, 72);
  const line = chalk.dim("─".repeat(W));

  console.log(`\n${chalk.bold.cyan("  MCP Server Health Check")}`);
  console.log(line);

  if (!(await fs.pathExists(mcpPath))) {
    console.log(chalk.dim("  No .mcp.json found — nothing to check."));
    console.log();
    return;
  }

  let mcp;
  try {
    mcp = await fs.readJson(mcpPath);
  } catch {
    console.log(chalk.red("  .mcp.json could not be parsed."));
    console.log();
    return;
  }

  const servers = mcp.mcpServers ?? {};
  const names = Object.keys(servers);

  if (!names.length) {
    console.log(chalk.dim("  No servers registered."));
    console.log();
    return;
  }

  console.log(chalk.dim(`  Spawning ${names.length} server(s) and sending initialize handshake...\n`));

  const results = await Promise.all(
    names.map(async (name) => ({ name, result: await checkServer(name, servers[name]) }))
  );

  let allOk = true;
  for (const { name, result } of results) {
    if (result.ok) {
      const info = result.serverInfo
        ? chalk.dim(` — ${result.serverInfo.name ?? name}${result.serverInfo.version ? " v" + result.serverInfo.version : ""}`)
        : "";
      const latency = chalk.dim(` (${result.latencyMs}ms)`);
      console.log(`  ${chalk.green("✓")} ${chalk.bold(name)}${info}${latency}`);
    } else {
      allOk = false;
      console.log(`  ${chalk.red("✗")} ${chalk.bold(name)}  ${chalk.red(result.error)}`);
    }
  }

  console.log();
  if (allOk) {
    console.log(chalk.green("  All servers healthy."));
  } else {
    console.log(chalk.yellow("  Some servers failed. Check the command and args in .mcp.json."));
  }
  console.log();
}

async function showUsage(cwd, runArg) {
  const runsDir = path.join(cwd, ".harness", "runs");
  const W = Math.min(process.stdout.columns || 72, 72);
  const line = chalk.dim("─".repeat(W));

  if (!(await fs.pathExists(runsDir))) {
    console.log(chalk.dim("  No run logs found (.harness/runs/ missing)."));
    return;
  }

  const runFiles = (await fs.readdir(runsDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (!runFiles.length) {
    console.log(chalk.dim("  No run logs found."));
    return;
  }

  let targetFile;
  if (runArg) {
    targetFile = `${runArg}.jsonl`;
    if (!runFiles.includes(targetFile)) {
      console.log(chalk.red(`  Run "${runArg}" not found.`));
      console.log(chalk.dim("  Available: " + runFiles.slice(0, 5).map((f) => f.replace(".jsonl", "")).join(", ")));
      process.exit(1);
    }
  } else {
    targetFile = runFiles[0];
  }

  const runPath = path.join(runsDir, targetFile);
  const runLabel = targetFile.replace(".jsonl", "");

  console.log(`${chalk.bold.cyan("  Tool Usage")}  ${chalk.dim("run: " + runLabel)}`);
  console.log(line);

  const toolCalls = extractToolCalls(runPath);

  if (!toolCalls.size) {
    console.log(chalk.dim("  No tool calls recorded in this run."));
    console.log();
    return;
  }

  // Load .mcp.json servers for attribution
  let servers = {};
  try {
    const mcp = await fs.readJson(path.join(cwd, ".mcp.json"));
    servers = mcp.mcpServers ?? {};
  } catch { /* no .mcp.json — show everything as unattributed */ }

  const { attribution, builtins, unknownMcp } = attributeTools(toolCalls);

  // 1. Attributed MCP calls per registered server
  for (const [serverName, tools] of attribution) {
    const total = [...tools.values()].reduce((a, b) => a + b, 0);
    console.log(`\n  ${chalk.green("●")} ${chalk.bold(serverName)} MCP  ${chalk.dim(`(${total} calls)`)}`);
    for (const [tool, count] of [...tools.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${chalk.magenta("⚙")} ${tool.padEnd(36)} ${chalk.dim("×" + count)}`);
    }
  }

  // 2. Unknown MCP — not built-in, not matched to any registered server
  if (unknownMcp.size) {
    const total = [...unknownMcp.values()].reduce((a, b) => a + b, 0);
    console.log(`\n  ${chalk.yellow("●")} ${chalk.yellow("MCP (unregistered server)")}  ${chalk.dim(`(${total} calls)`)}`);
    for (const [tool, count] of [...unknownMcp.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${chalk.yellow("⚙")} ${tool.padEnd(36)} ${chalk.dim("×" + count)}`);
    }
  }

  // 3. Built-in Claude Code tools
  if (builtins.size) {
    const total = [...builtins.values()].reduce((a, b) => a + b, 0);
    console.log(`\n  ${chalk.dim("●")} ${chalk.dim(`built-in  (${total} calls)`)}`);
    for (const [tool, count] of [...builtins.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${chalk.dim("⚙")} ${chalk.dim(tool.padEnd(36) + " ×" + count)}`);
    }
  }

  // Servers registered but with no calls in this run
  const usedServers = new Set(attribution.keys());
  const unusedServers = Object.keys(servers).filter((s) => !usedServers.has(s));
  if (unusedServers.length) {
    console.log(`\n  ${chalk.dim("No calls recorded for:")} ${unusedServers.map((s) => chalk.dim(s)).join(", ")}`);
  }

  console.log();
}
