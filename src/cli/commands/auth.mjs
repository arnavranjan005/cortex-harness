import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { createInterface } from "readline";
import chalk from "chalk";
import { loadConfig } from "../../config-loader.mjs";
import { intro, outro, log, note } from "../helpers/ui.mjs";
import { startDevServer, killProc } from "../../engine/process-utils.mjs";
import { resolveAdapter, DEFAULT_CLI_PROVIDER } from "../../engine/cli-adapters/registry.mjs";
import { logger } from "../../logger.mjs";

export const SMOKE_AUTH_FILE = ".harness/smoke-auth.json";

/** Returns the storage file path for a named auth profile. */
export function profileStorageFile(name) {
  return `.harness/smoke-auth-${name}.json`;
}

export function registerAuthCommand(program) {
  program
    .command("auth")
    .description(
      "Save browser auth state for smoke tests — opens a browser, log in, then close it",
    )
    .option("--url <url>", "URL to open (defaults to devServer.browserUrl in harness.config.json)")
    .option("--out <path>", "Where to save auth state (ignored when --profile is set)")
    .option("--profile <name>", "Named auth profile (e.g. admin, user). Saves to .harness/smoke-auth-<name>.json and does NOT patch .mcp.json")
    .option("--no-server", "Skip auto-starting the dev server")
    .action(async (opts) => {
      intro(chalk.bold.cyan("cortex-harness") + chalk.dim(" · auth"));

      // Load config once — used for both browserUrl and devServer config
      let config = null;
      try { config = await loadConfig(); } catch { /* no config — proceed with flag values */ }

      const browserUrl = opts.url ?? config?.devServer?.browserUrl;
      if (!browserUrl) {
        log.error("No URL found. Pass --url <url> or configure devServer.browserUrl in harness.config.json");
        process.exit(1);
      }

      // Always use a named profile — default when no --profile flag is given.
      // The base playwright session in .mcp.json stays unauthenticated (used as the probe).
      const profileName = (opts.profile ?? "default")
        .trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const resolvedOut = opts.out ?? profileStorageFile(profileName);

      const outPath = path.resolve(process.cwd(), resolvedOut);
      await fs.ensureDir(path.dirname(outPath));

      // Auto-start dev servers unless --no-server was passed
      let spawnedProcs = [];
      if (opts.server !== false && config?.devServer) {
        log.step("Starting dev servers…");
        const result = await startDevServer(config.devServer, { ROOT: process.cwd() });
        spawnedProcs = result.procs;
        if (result.procs.length === 0 && !result.browserUrl) {
          // startDevServer already printed the "not ready" warning — servers may already be up
          // or timed out. Either way, attempt to open the browser and let Playwright report.
          log.warn("Dev server did not become ready within the timeout — attempting anyway");
        }
      }

      note(
        [
          `${chalk.dim("URL    :")} ${chalk.cyan(browserUrl)}`,
          `${chalk.dim("Saving :")} ${chalk.cyan(resolvedOut)}`,
          `${chalk.dim("Profile:")} ${chalk.cyan(profileName)}`,
          "",
          "A fresh browser window will open. Log in — including SSO, OAuth",
          "redirects, or MFA — then press " + chalk.bold("Enter") + " here.",
          "",
          chalk.dim("Wrong credentials?  Retry in the browser, then press Enter when done."),
          chalk.dim("Want to switch accounts?  Log out in the browser first, then log in."),
          chalk.dim("Abort without saving?  Press Ctrl+C."),
        ].filter(Boolean).join("\n"),
        "Smoke auth setup",
      );

      log.step("Opening browser — complete login, then press Enter here");

      let exitCode;
      try {
        exitCode = await openBrowserAndSave(browserUrl, resolvedOut);
      } finally {
        // Always kill any servers we started, regardless of browser outcome
        spawnedProcs.forEach((p) => killProc(p));
      }

      if (exitCode !== 0 && exitCode !== null) {
        log.error(
          `Auth session failed (exit code ${exitCode}).\n` +
          chalk.dim("  Make sure @playwright/mcp is configured in .mcp.json and its browsers are installed."),
        );
        process.exit(1);
      }

      if (!(await fs.pathExists(outPath))) {
        log.warn("Auth state file was not written — did you close the browser before logging in?");
        process.exit(1);
      }

      // Profiles are injected at runtime — never patch .mcp.json (keeps base playwright unauthenticated).
      const gitignored = await patchGitignore(process.cwd(), resolvedOut);
      const configPatched = await upsertAuthProfile(process.cwd(), profileName, resolvedOut);

      // Use the project's actual configured provider's own MCP-tool naming
      // convention for this message — confirmed live this session that
      // Claude's "mcp__<server>__*" and OpenCode's "<server>_*" genuinely
      // differ, so a hardcoded Claude-style name here would be factually
      // wrong (though harmless to the profile's actual function) for an
      // OpenCode project.
      const adapter = resolveAdapter(config?.cliProvider ?? DEFAULT_CLI_PROVIDER);
      const profileToolWildcard = adapter.mcpServerWildcard
        ? adapter.mcpServerWildcard(`playwright-${profileName}`)
        : `playwright-${profileName}*`;

      const noteLines = [
        `${chalk.green("✓")} Auth state saved  ${chalk.dim(resolvedOut)}`,
        gitignored
          ? `${chalk.green("✓")} .gitignore updated`
          : `${chalk.dim("–")} .gitignore already had entry`,
        configPatched
          ? `${chalk.green("✓")} harness.config.json updated  ${chalk.dim(`authProfiles["${profileName}"]`)}`
          : `${chalk.yellow("!")} harness.config.json not found — add manually:\n` +
            chalk.dim(`      { "name": "${profileName}", "storageFile": "${resolvedOut}" }  to authProfiles[]`),
        "",
        `Profile "${chalk.cyan(profileName)}" ready as ${chalk.cyan(profileToolWildcard)} in smoke cycles.`,
        chalk.dim(`Re-run \`cortex-harness auth --profile ${profileName}\` if your session expires.`),
      ];

      note(noteLines.join("\n"), "Done");

      outro(chalk.green.bold("✓ Auth state saved"));
    });
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function openBrowserAndSave(url, storageOut) {
  // Spawn the playwright MCP server the user already has configured in .mcp.json.
  // No `playwright` library required in the user's project — uses the MCP they already have.
  //
  // Storage state is captured via the `browser_storage_state` MCP tool (requires --caps=storage),
  // which calls browserContext.storageState() and writes ALL cookies (including httpOnly) to a
  // file within the workspace. The MCP's default persistent mode opens a headed browser on
  // non-Linux systems — no --user-data-dir or --storage-state flags needed.
  const cwd = process.cwd();

  // Read playwright MCP entry from .mcp.json, falling back to npx defaults
  let mcpCmd = "npx";
  let mcpBaseArgs = ["-y", "@playwright/mcp@latest"];
  try {
    const mcpConfig = JSON.parse(readFileSync(path.join(cwd, ".mcp.json"), "utf8"));
    const pw = mcpConfig.mcpServers?.playwright;
    if (pw?.command) {
      mcpCmd = pw.command;
      // Strip flags we own so we can set them ourselves
      mcpBaseArgs = (pw.args ?? []).filter(a =>
        !String(a).startsWith("--storage-state") &&
        !String(a).includes("headless") &&
        !String(a).startsWith("--user-data-dir") &&
        String(a) !== "--isolated"
      );
    }
  } catch { /* no .mcp.json or no playwright entry — use npx defaults */ }

  // Ensure storage capability is enabled so browser_storage_state tool is available.
  // Append "storage" to an existing --caps arg, or add a new one.
  const capsIdx = mcpBaseArgs.findIndex(a => String(a).startsWith("--caps="));
  if (capsIdx === -1) {
    mcpBaseArgs = [...mcpBaseArgs, "--caps=storage"];
  } else {
    const existing = String(mcpBaseArgs[capsIdx]).slice("--caps=".length).split(",");
    if (!existing.includes("storage")) existing.push("storage");
    mcpBaseArgs = [...mcpBaseArgs.slice(0, capsIdx), `--caps=${existing.join(",")}`, ...mcpBaseArgs.slice(capsIdx + 1)];
  }

  // --isolated: always start with a blank context (no prior cookies/session) so the user
  // always sees the login page. This makes re-auth work without manually logging out first.
  // --allow-unrestricted-file-access: lets browser_storage_state write to any path (e.g. --out).
  const mcpArgs = [...mcpBaseArgs, "--isolated", "--allow-unrestricted-file-access"];

  const proc = spawn(mcpCmd, mcpArgs, {
    stdio: ["pipe", "pipe", "inherit"], // inherit stderr so MCP startup errors are visible
    cwd,
    shell: process.platform === "win32",
  });

  let aborted = false;
  const sigintHandler = () => {
    aborted = true;
    logger.info("\n  Aborted — browser closed, no auth state saved.");
    proc.kill("SIGTERM");
    process.exit(1);
  };
  process.once("SIGINT", sigintHandler);

  // ── Minimal MCP stdio client (newline-delimited JSON per MCP spec) ───────────
  let msgId = 1;
  const pending = new Map();
  let lineBuf = "";

  proc.stdout.on("data", chunk => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop(); // keep any incomplete trailing line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* malformed line — ignore */ }
    }
  });

  const mcpSend = msg => proc.stdin.write(JSON.stringify(msg) + "\n");

  const mcpRequest = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
      mcpSend({ jsonrpc: "2.0", id, method, params });
    });

  const mcpNotify = (method, params) =>
    mcpSend({ jsonrpc: "2.0", method, params });

  let exitCode = 0;
  try {
    // MCP is passive — it writes nothing until it receives a message.
    // Send initialize immediately; the OS stdin buffer holds it until the server reads.
    // Use a long timeout to allow npx to download @playwright/mcp on first run.
    await mcpRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cortex-harness-auth", version: "1.0.0" },
    }, 60_000); // 60s — allows npx to download @playwright/mcp on first run
    mcpNotify("notifications/initialized", {});

    await mcpRequest("tools/call", {
      name: "browser_navigate",
      arguments: { url },
    }, 60_000);

    // Wait for user to complete login
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => rl.question(
      "\n  Logged in? Press Enter to save and close the browser... ",
      resolve,
    ));
    rl.close();

    // Capture full storage state (cookies + localStorage, including httpOnly cookies) via MCP tool.
    // browser_storage_state resolves `storageOut` relative to the MCP's cwd (= project root),
    // writes the JSON file, and returns a text link to it.
    const saveResult = await mcpRequest("tools/call", {
      name: "browser_storage_state",
      arguments: { filename: storageOut },
    }, 15_000);

    if (saveResult?.error) {
      throw new Error("browser_storage_state RPC error: " + (saveResult.error.message ?? JSON.stringify(saveResult.error)));
    }
    if (saveResult?.result?.isError) {
      throw new Error(
        "browser_storage_state failed: " +
        (saveResult.result.content?.[0]?.text ?? JSON.stringify(saveResult.result))
      );
    }

    // Close the browser now that state is saved
    try {
      await mcpRequest("tools/call", { name: "browser_close", arguments: {} }, 10_000);
    } catch { /* ignore — process will be killed in finally */ }

  } catch (err) {
    if (!aborted) logger.error(chalk.red(`\n  Browser session error: ${err.message}`));
    exitCode = 1;
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    proc.kill("SIGTERM");
    await new Promise(r => proc.on("close", r));
  }

  return exitCode;
}

// Upserts a profile entry in harness.config.json authProfiles[].
// Returns true if the file was updated.
async function upsertAuthProfile(cwd, name, storageFile) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) return false;
  const config = await fs.readJson(configPath);
  if (!Array.isArray(config.authProfiles)) config.authProfiles = [];
  const idx = config.authProfiles.findIndex(p => p?.name === name);
  const entry = { name, storageFile };
  if (idx >= 0) config.authProfiles[idx] = entry;
  else config.authProfiles.push(entry);
  await fs.writeJson(configPath, config, { spaces: 2 });
  return true;
}

// Adds --storage-state to the playwright entry in .mcp.json.
// Returns true if a change was made.
async function patchMcpConfig(cwd, statePath) {
  const mcpPath = path.join(cwd, ".mcp.json");
  if (!(await fs.pathExists(mcpPath))) return false;

  const mcp = await fs.readJson(mcpPath);
  const pw = mcp.mcpServers?.playwright;
  if (!pw) return false;

  if (!Array.isArray(pw.args)) pw.args = [];

  // Remove any stale --storage-state arg
  pw.args = pw.args.filter((a) => !String(a).startsWith("--storage-state"));
  pw.args.push(`--storage-state=${statePath}`);

  await fs.writeJson(mcpPath, mcp, { spaces: 2 });
  return true;
}

// Appends the auth state path to .gitignore if not already present.
// Returns true if appended.
async function patchGitignore(cwd, statePath) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = statePath.replace(/\\/g, "/");

  if (await fs.pathExists(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, "utf8");
    if (content.includes(entry)) return false;
    const sep = content.endsWith("\n") ? "" : "\n";
    await fs.appendFile(gitignorePath, `${sep}${entry}\n`);
  } else {
    await fs.writeFile(gitignorePath, `${entry}\n`);
  }
  return true;
}
