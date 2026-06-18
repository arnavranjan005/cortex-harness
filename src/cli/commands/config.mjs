import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import {
  loadHarnessConfig,
  saveHarnessConfig,
  repatchFromConfig,
  printScopeTable,
  printMcpScopeTable,
} from "../helpers/harness-config.mjs";
import { detectDevServerConfig } from "../../engine/process-utils.mjs";
import { select, text, confirm, log, multiselect } from "../helpers/ui.mjs";
import { serverScopeOptions, scopeListsEqual } from "../helpers/mcp-config.mjs";

function printDevServerTable(config) {
  const ds = config.devServer;
  if (!ds || !Array.isArray(ds.services) || !ds.services.length) {
    console.log(chalk.dim("  devServer: (not configured)"));
    return;
  }
  console.log(chalk.bold("  Dev server"));
  console.log(`  ${"command".padEnd(52)} ${"readinessUrl".padEnd(30)} cwd`);
  console.log("  " + "─".repeat(90));
  for (const svc of ds.services) {
    const cmd = svc.command.length > 50 ? svc.command.slice(0, 47) + "..." : svc.command;
    console.log(`  ${cmd.padEnd(52)} ${svc.readinessUrl.padEnd(30)} ${svc.cwd ?? ""}`);
  }
  console.log(`  ${chalk.dim("browser:")} ${ds.browserUrl}   ${chalk.dim("timeout:")} ${(ds.startupTimeoutMs ?? 120000) / 1000}s`);
  console.log();
}

export function registerConfigCommand(program) {
  const configCmd = program
    .command("config")
    .description(
      "View and edit harness.config.json without touching JSON manually",
    );

  // bare `cortex-harness config` → interactive wizard
  configCmd.action(async () => {
    const { config, configPath } = await loadHarnessConfig(process.cwd());

    printScopeTable(config);

    const agents = Object.keys(config.agents || {});
    const editable = agents.filter(
      (a) =>
        !["explorer-subagent", "planner-subagent", "tester-subagent"].includes(a),
    );

    let dirty = false;
    const top = await select({
      message: "What do you want to edit?",
      options: [
        { value: "scopes", label: "Agent file scopes" },
        { value: "mcp", label: "MCP server scope", hint: "which servers each agent can use" },
        { value: "devserver", label: "Dev server services" },
        { value: "exit", label: "Exit" },
      ],
      initialValue: "scopes",
      fallback: "exit",
    });

    if (top === "scopes") {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const agent = await select({
          message: "Which agent scope do you want to edit?",
          options: [
            ...editable.map((a) => ({ value: a, label: a })),
            { value: "__back", label: "← Back" },
          ],
          fallback: "__back",
        });
        if (agent === "__back") break;
        const current = (config.agents[agent]?.scope || []).join(", ");
        const raw = await text({
          message: `${agent} scope`,
          placeholder: "comma-separated paths",
          initialValue: current,
        });
        const trimmed = (raw ?? "").trim();
        if (trimmed && trimmed !== current) {
          config.agents[agent].scope = trimmed
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          log.success(`Updated ${agent}`);
          dirty = true;
        }
        printScopeTable(config);
      }
    } else if (top === "mcp") {
      if (!config.mcpScope) config.mcpScope = {};
      printMcpScopeTable(config);

      // Pick from servers actually registered in .mcp.json — no typing agent
      // or server names by hand, so nothing here can typo into a no-op.
      let serverNames = [];
      try {
        const mcp = await fs.readJson(path.join(process.cwd(), ".mcp.json"));
        serverNames = Object.keys(mcp.mcpServers ?? {});
      } catch { /* no .mcp.json yet */ }

      if (!serverNames.length) {
        log.warn(
          "No servers found in .mcp.json — register one first (cortex-harness init, or add it to .mcp.json) before scoping.",
        );
      } else {
        const scopeKeys = ["*", ...agents];
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const key = await select({
            message: "Which agent's MCP scope do you want to edit?",
            options: [
              ...scopeKeys.map((k) => ({ value: k, label: k === "*" ? "* (all agents)" : k })),
              { value: "__back", label: "← Back" },
            ],
            fallback: "__back",
          });
          if (key === "__back") break;

          const current = config.mcpScope[key] ?? [];
          const label = key === "*" ? "* (all agents)" : key;
          const chosen = await multiselect({
            message: `${label} — pick MCP servers to allow`,
            options: serverScopeOptions(serverNames),
            initialValues: current.filter((s) => serverNames.includes(s)),
            required: false,
            fallback: current,
          });
          if (!scopeListsEqual(chosen, current)) {
            config.mcpScope[key] = chosen;
            log.success(`Updated ${label}`);
            dirty = true;
          }
          printMcpScopeTable(config);
        }
      }
    } else if (top === "devserver") {
      printDevServerTable(config);
      const dsChoice = await select({
        message: "Dev server",
        options: [
          { value: "detect", label: "Auto-detect from project" },
          { value: "clear", label: "Clear dev server config" },
          { value: "back", label: "← Back" },
        ],
        fallback: "back",
      });
      if (dsChoice === "detect") {
        const detected = detectDevServerConfig(process.cwd());
        if (!detected) {
          console.log(chalk.yellow("  No framework detected in this project."));
        } else {
          console.log(`\n  ${chalk.dim("Detected services:")}`);
          detected.services.forEach((svc, i) => {
            console.log(`    ${chalk.cyan(`[${i + 1}]`)} ${svc.command}`);
            console.log(`         ${chalk.dim("ready:")} ${svc.readinessUrl}`);
            if (svc.cwd) console.log(`         ${chalk.dim("cwd:")}   ${svc.cwd}`);
          });
          console.log(`    ${chalk.dim(`browser: ${detected.browserUrl}`)}\n`);
          const apply = await confirm({
            message: "Apply to harness.config.json?",
            initialValue: true,
          });
          if (apply) {
            config.devServer = {
              browserUrl: detected.browserUrl,
              startupTimeoutMs: detected.startupTimeoutMs,
              services: detected.services,
            };
            dirty = true;
            log.success("devServer updated");
          }
        }
      } else if (dsChoice === "clear") {
        delete config.devServer;
        dirty = true;
        log.success("devServer cleared");
      }
    }

    if (dirty) {
      await saveHarnessConfig(configPath, config);
      await repatchFromConfig(process.cwd(), config);
      console.log(
        chalk.green(
          "\n  harness.config.json saved and agent .md scope sections updated.",
        ),
      );
    } else {
      console.log("  No changes made.");
    }
  });

  // `cortex-harness config list` → print table and exit
  configCmd
    .command("list")
    .description("Print current agent scope configuration")
    .action(async () => {
      const { config } = await loadHarnessConfig(process.cwd());
      printScopeTable(config);
    });

  // `cortex-harness config add-scope <agent> <path>` → append a scope path
  configCmd
    .command("add-scope <agent> <scopePath>")
    .description("Add a path to an agent's scope")
    .action(async (agent, scopePath) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.agents[agent]) {
        console.error(chalk.red(`  Unknown agent: ${agent}`));
        console.log("  Available:", Object.keys(config.agents).join(", "));
        process.exit(1);
      }
      const scope = config.agents[agent].scope || [];
      const normalized = scopePath.endsWith("/") ? scopePath : scopePath + "/";
      if (scope.includes(normalized) || scope.includes(scopePath)) {
        console.log(
          chalk.yellow(
            `  "${scopePath}" is already in ${agent}'s scope — no change.`,
          ),
        );
        process.exit(0);
      }
      config.agents[agent].scope = [...scope, normalized];
      await saveHarnessConfig(configPath, config);
      await repatchFromConfig(process.cwd(), config);
      console.log(chalk.green(`  ✓ Added "${normalized}" to ${agent}`));
      printScopeTable(config);
    });

  // `cortex-harness config remove-scope <agent> <path>` → remove a scope path
  configCmd
    .command("remove-scope <agent> <scopePath>")
    .description("Remove a path from an agent's scope")
    .action(async (agent, scopePath) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.agents[agent]) {
        console.error(chalk.red(`  Unknown agent: ${agent}`));
        process.exit(1);
      }
      const before = config.agents[agent].scope || [];
      const after = before.filter(
        (s) =>
          s !== scopePath &&
          s !== scopePath + "/" &&
          s !== scopePath.replace(/\/$/, ""),
      );
      if (after.length === before.length) {
        console.log(
          chalk.yellow(`  "${scopePath}" not found in ${agent}'s scope.`),
        );
        console.log("  Current scope:", before.join(", ") || "(none)");
        process.exit(0);
      }
      config.agents[agent].scope = after;
      await saveHarnessConfig(configPath, config);
      await repatchFromConfig(process.cwd(), config);
      console.log(chalk.green(`  ✓ Removed "${scopePath}" from ${agent}`));
      printScopeTable(config);
    });

  // `cortex-harness config mcp-scope` → print MCP scope table
  configCmd
    .command("mcp-scope")
    .description("Print current MCP server scope per agent")
    .action(async () => {
      const { config } = await loadHarnessConfig(process.cwd());
      printMcpScopeTable(config);
    });

  // `cortex-harness config add-mcp-scope <agent> <server>` → add MCP server to agent
  configCmd
    .command("add-mcp-scope <agent> <serverName>")
    .description("Allow an MCP server for an agent (use * for all agents)")
    .action(async (agent, serverName) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      const validKeys = ["*", ...Object.keys(config.agents || {})];
      if (!validKeys.includes(agent)) {
        console.error(chalk.red(`  Unknown key: ${agent}`));
        console.log("  Valid keys:", validKeys.join(", "));
        process.exit(1);
      }
      if (!config.mcpScope) config.mcpScope = {};
      const current = config.mcpScope[agent] ?? [];
      if (current.includes(serverName)) {
        console.log(chalk.yellow(`  "${serverName}" already in ${agent}'s MCP scope — no change.`));
        process.exit(0);
      }
      config.mcpScope[agent] = [...current, serverName];
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green(`  ✓ Added "${serverName}" to ${agent}'s MCP scope`));
      printMcpScopeTable(config);
    });

  // `cortex-harness config remove-mcp-scope <agent> <server>` → remove MCP server from agent
  configCmd
    .command("remove-mcp-scope <agent> <serverName>")
    .description("Remove an MCP server from an agent's allowed list")
    .action(async (agent, serverName) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.mcpScope || !config.mcpScope[agent]) {
        console.log(chalk.yellow(`  No MCP scope configured for "${agent}".`));
        process.exit(0);
      }
      const before = config.mcpScope[agent];
      const after = before.filter((s) => s !== serverName);
      if (after.length === before.length) {
        console.log(chalk.yellow(`  "${serverName}" not in ${agent}'s MCP scope.`));
        console.log("  Current:", before.join(", ") || "(none)");
        process.exit(0);
      }
      config.mcpScope[agent] = after;
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green(`  ✓ Removed "${serverName}" from ${agent}'s MCP scope`));
      printMcpScopeTable(config);
    });

  // `cortex-harness config dev-server` subcommand tree
  const dsCmd = configCmd
    .command("dev-server")
    .description("View and configure the devServer section of harness.config.json");

  // bare `cortex-harness config dev-server` → print current config
  dsCmd.action(async () => {
    const { config } = await loadHarnessConfig(process.cwd());
    printDevServerTable(config);
  });

  // `cortex-harness config dev-server detect` → auto-detect and write
  dsCmd
    .command("detect")
    .description("Auto-detect dev server services from the project and write to harness.config.json")
    .action(async () => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      const detected = detectDevServerConfig(process.cwd());
      if (!detected) {
        console.log(chalk.yellow("  No framework detected in this project."));
        console.log(chalk.dim("  Configure devServer manually in harness.config.json if needed."));
        process.exit(0);
      }
      console.log(`\n  ${chalk.dim("Detected services:")}`);
      detected.services.forEach((svc, i) => {
        console.log(`    ${chalk.cyan(`[${i + 1}]`)} ${svc.command}`);
        console.log(`         ${chalk.dim("ready:")} ${svc.readinessUrl}`);
        if (svc.cwd) console.log(`         ${chalk.dim("cwd:")}   ${svc.cwd}`);
      });
      console.log(`    ${chalk.dim(`browser: ${detected.browserUrl}`)}\n`);

      config.devServer = {
        browserUrl: detected.browserUrl,
        startupTimeoutMs: detected.startupTimeoutMs,
        services: detected.services,
      };
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green("  ✓ devServer written to harness.config.json"));
    });

  // `cortex-harness config dev-server clear` → remove devServer from config
  dsCmd
    .command("clear")
    .description("Remove the devServer section from harness.config.json")
    .action(async () => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.devServer) {
        console.log(chalk.dim("  devServer is not configured — nothing to clear."));
        process.exit(0);
      }
      delete config.devServer;
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green("  ✓ devServer removed from harness.config.json"));
    });
}
