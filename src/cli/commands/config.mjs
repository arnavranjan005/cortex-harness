import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import {
  loadHarnessConfig,
  saveHarnessConfig,
  repatchFromConfig,
  printScopeTable,
  printMcpScopeTable,
  printRouteParamsTable,
} from "../helpers/harness-config.mjs";
import { detectDevServerConfig } from "../../engine/process-utils.mjs";
import { select, text, confirm, log, multiselect, note } from "../helpers/ui.mjs";
import { serverScopeOptions, scopeListsEqual } from "../helpers/mcp-config.mjs";
import { deriveFrontendRoot, detectFramework, scanDynamicRoutes, extractParamNames } from "../../engine/route-scanner.mjs";

// Plain-language label for an existing routeParams entry, used in the "remove" picker
// so a user isn't asked to recognize their own raw JSON key/value shape.
function describeRouteParamEntry(key, value) {
  if (key.startsWith("/")) {
    const pairs = Object.entries(value ?? {}).map(([n, v]) => `${n}=${v}`).join(", ");
    return `${key} → ${pairs}  (only this page)`;
  }
  return `[${key}] = "${value}"  (every page with a [${key}] segment)`;
}

// Walks the user through giving a value to each param a route needs, asking for
// each one whether it should apply everywhere that param name is used or only to
// this specific page — written as a plain choice, not as "flat default" jargon.
async function setValuesForRoute(config, route, log, text, confirm) {
  let changed = false;
  for (const name of route.paramNames) {
    const value = (await text({
      message: `Value for "${name}" on ${route.routePattern} (currently shown as ${route.exampleUrl})`,
      placeholder: "e.g. 1, demo-client, my-first-post",
      fallback: "",
    })).trim();
    if (!value) { log.warn(`Skipped "${name}" — no value entered.`); continue; }

    const everywhere = await confirm({
      message: `Use "${value}" for every page that has a [${name}] segment, not just this one?`,
      initialValue: false,
      fallback: false,
    });

    if (everywhere) {
      config.routeParams[name] = value;
      log.success(`"${name}" = "${value}" will be used on every page with a [${name}] segment.`);
    } else {
      if (typeof config.routeParams[route.routePattern] !== "object" || config.routeParams[route.routePattern] === null || Array.isArray(config.routeParams[route.routePattern])) {
        config.routeParams[route.routePattern] = {};
      }
      config.routeParams[route.routePattern][name] = value;
      log.success(`"${name}" = "${value}" will be used only on ${route.routePattern}.`);
    }
    changed = true;
  }
  return changed;
}

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
        { value: "routeparams", label: "Dynamic route params", hint: "values for [id]-style segments during smoke scans" },
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
    } else if (top === "routeparams") {
      if (!config.routeParams) config.routeParams = {};

      note(
        "Some pages have a placeholder in their URL, like [id] in /clients/[id].\n" +
          "When Cortex test-visits these pages it fills that in with a fake value\n" +
          "(\"1\" or \"test\") unless you give it a real one here — e.g. a real client ID\n" +
          "so the page actually loads instead of showing a 404.",
        "Dynamic route params",
      );

      const frontendRoot = deriveFrontendRoot(config);
      const framework = detectFramework(process.cwd(), frontendRoot);
      let detected = [];
      try {
        detected = scanDynamicRoutes(process.cwd(), frontendRoot, framework);
      } catch { /* best-effort detection */ }

      printRouteParamsTable(config);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pickOptions = detected.map((d) => ({
          value: d.routePattern,
          label: d.routePattern,
          hint: `e.g. ${d.exampleUrl} right now`,
        }));

        const action = await select({
          message: "What do you want to do?",
          options: [
            ...(pickOptions.length
              ? [{ value: "__pick", label: "Set a value for a detected page", hint: `${pickOptions.length} found in this project` }]
              : []),
            { value: "__manual", label: "Set a value by typing a route myself" },
            { value: "__remove", label: "Remove a value I already set" },
            { value: "__back", label: "← Back" },
          ],
          fallback: "__back",
        });
        if (action === "__back") break;

        if (action === "__pick") {
          if (!pickOptions.length) { log.warn("No dynamic pages detected in this project."); continue; }
          const routePattern = await select({
            message: "Which page?",
            options: [...pickOptions, { value: "__cancel", label: "← Cancel" }],
            fallback: "__cancel",
          });
          if (routePattern === "__cancel") continue;
          const route = detected.find((d) => d.routePattern === routePattern);
          if (await setValuesForRoute(config, route, log, text, confirm)) dirty = true;
        } else if (action === "__manual") {
          const route = (await text({
            message: "Route pattern, written like it appears in your code (e.g. /clients/[id])",
            placeholder: "/clients/[id]",
            fallback: "",
          })).trim();
          if (!route || !route.startsWith("/") || !route.includes("[")) {
            log.warn('Enter a path starting with "/" that contains a [param] segment, e.g. /clients/[id].');
            continue;
          }
          const paramNames = extractParamNames(route);
          if (!paramNames.length) { log.warn("Couldn't find a [param] segment in that path."); continue; }
          if (await setValuesForRoute(config, { routePattern: route, paramNames, exampleUrl: route }, log, text, confirm)) dirty = true;
        } else if (action === "__remove") {
          const keys = Object.keys(config.routeParams);
          if (!keys.length) { log.warn("Nothing configured yet."); continue; }
          const key = await select({
            message: "Remove which one?",
            options: [
              ...keys.map((k) => ({ value: k, label: describeRouteParamEntry(k, config.routeParams[k]) })),
              { value: "__cancel", label: "← Cancel" },
            ],
            fallback: "__cancel",
          });
          if (key === "__cancel") continue;
          delete config.routeParams[key];
          dirty = true;
          log.success(`Removed "${key}"`);
        }
        printRouteParamsTable(config);
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

  // `cortex-harness config route-params` → print routeParams table
  configCmd
    .command("route-params")
    .description("Print configured dynamic route param values (used when scanning [id]-style segments for smoke checks)")
    .action(async () => {
      const { config } = await loadHarnessConfig(process.cwd());
      printRouteParamsTable(config);
    });

  // `cortex-harness config set-route-param <name> <value>` → flat default, applies to every route using that param name
  configCmd
    .command("set-route-param <name> <value>")
    .description("Set a flat default value for a route param name (e.g. id → 1)")
    .action(async (name, value) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.routeParams) config.routeParams = {};
      config.routeParams[name] = value;
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green(`  ✓ Set flat default "${name}" = "${value}"`));
      printRouteParamsTable(config);
    });

  // `cortex-harness config set-route-override <routePattern> <name> <value>` → per-route override, wins over flat default
  configCmd
    .command("set-route-override <routePattern> <name> <value>")
    .description("Set a route-specific param override (e.g. /clients/[id] id demo-client-1) — wins over a flat default")
    .action(async (routePattern, name, value) => {
      if (!routePattern.startsWith("/")) {
        console.error(chalk.red('  routePattern must start with "/" (e.g. /clients/[id])'));
        process.exit(1);
      }
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.routeParams) config.routeParams = {};
      const existing = config.routeParams[routePattern];
      config.routeParams[routePattern] =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...existing, [name]: value }
          : { [name]: value };
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green(`  ✓ Set override ${routePattern} → "${name}" = "${value}"`));
      printRouteParamsTable(config);
    });

  // `cortex-harness config remove-route-param <key>` → remove a flat default or an entire route override entry
  configCmd
    .command("remove-route-param <key>")
    .description("Remove a flat default (by param name) or an entire route override entry (by route pattern)")
    .action(async (key) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.routeParams || !(key in config.routeParams)) {
        console.log(chalk.yellow(`  "${key}" not found in routeParams.`));
        process.exit(0);
      }
      delete config.routeParams[key];
      await saveHarnessConfig(configPath, config);
      console.log(chalk.green(`  ✓ Removed "${key}" from routeParams`));
      printRouteParamsTable(config);
    });
}
