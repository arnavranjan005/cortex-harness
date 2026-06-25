import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { patchAgentScopes } from "./surfaces.mjs";
import { listProviders, isProviderInstalled, DEFAULT_CLI_PROVIDER } from "../../engine/cli-adapters/registry.mjs";
import { logger } from "../../logger.mjs";

export async function loadHarnessConfig(cwd) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    logger.error(
      chalk.red(
        '  harness.config.json not found. Run "cortex-harness init" first.',
      ),
    );
    process.exit(1);
  }
  return { config: await fs.readJson(configPath), configPath };
}

export async function saveHarnessConfig(configPath, config) {
  await fs.writeJson(configPath, config, { spaces: 2 });
}

// Derive surface buckets from live harness.config.json for md patching.
export function surfacesFromConfig(config) {
  const get = (agent) => config.agents?.[agent]?.scope ?? [];
  const backendScope = get("backend-subagent");
  const frontendScope = get("frontend-subagent");
  const distScope = get("distributed-subagent");

  // shared libs appear in both backend and frontend scopes; collect unique shared paths
  const allShared = [...new Set([...backendScope, ...frontendScope])].filter(
    (p) => p.startsWith("libs/"),
  );
  const sharedSchema = allShared.filter((p) =>
    /\b(schema|zod|validation|models?)\b/.test(p),
  );
  const sharedTypes = allShared.filter((p) =>
    /\b(types?|entit(y|ies)|interfaces?|domain)\b/.test(p),
  );
  const sharedUi = allShared.filter((p) =>
    /\bui\b|\b(components?|design[-_]system)\b/.test(p),
  );

  return {
    backend: backendScope.filter((p) => !p.startsWith("libs/")),
    frontend: frontendScope.filter((p) => !p.startsWith("libs/")),
    distributed: distScope,
    sharedSchema,
    sharedTypes,
    sharedUi,
  };
}

// Re-patch agent md files from live config (called after any config mutation).
// Patches every provider variant that's been scaffolded (agents/, agents-opencode/, ...)
// so scope edits stay in sync across CLI backends regardless of which one is active.
export async function repatchFromConfig(cwd, config) {
  const harnessDir = path.join(cwd, config.harnessDir ?? ".harness");
  const surfaces = surfacesFromConfig(config);
  const agentDirs = [path.join(harnessDir, "agents"), path.join(harnessDir, "agents-opencode")];
  for (const agentsDir of agentDirs) {
    if (!(await fs.pathExists(agentsDir))) continue;
    await patchAgentScopes(agentsDir, surfaces);
  }
}

export function printMcpScopeTable(config) {
  const scope = config.mcpScope ?? {};
  const keys = Object.keys(scope);
  if (!keys.length) {
    logger.info(chalk.dim("  No mcpScope configured. All MCP servers load for every cycle."));
    logger.info();
    return;
  }
  const nameWidth = Math.max(...keys.map((k) => k.length), 6);
  logger.info();
  logger.info(chalk.bold("  MCP scope configuration"));
  logger.info("  " + "─".repeat(nameWidth + 4 + 40));
  for (const [key, servers] of Object.entries(scope)) {
    const label = key === "*" ? chalk.dim("* (all agents)") : chalk.cyan(key.padEnd(nameWidth));
    const val = !servers || servers.length === 0
      ? chalk.dim("(none — MCP disabled)")
      : servers.join(", ");
    logger.info(`  ${label.padEnd(nameWidth + 2)}  ${val}`);
  }
  logger.info("  " + "─".repeat(nameWidth + 4 + 40));
  logger.info();
}

// routeParams entries are either a flat default ("id": "1") or a per-route
// override ("/clients/[id]": { "id": "demo-client-1" }) — see route-scanner.mjs.
export function printRouteParamsTable(config) {
  const params = config.routeParams ?? {};
  const keys = Object.keys(params);
  if (!keys.length) {
    logger.info(chalk.dim("  No routeParams configured. Dynamic segments use generic placeholders (\"1\" / \"test\")."));
    logger.info();
    return;
  }
  logger.info();
  logger.info(chalk.bold("  Dynamic route params"));
  logger.info("  " + "─".repeat(60));
  for (const key of keys) {
    const value = params[key];
    if (key.startsWith("/")) {
      const overrideStr = Object.entries(value ?? {})
        .map(([p, v]) => `${p}=${v}`)
        .join(", ");
      logger.info(`  ${chalk.cyan(key)}  ${chalk.dim("(route override)")}  ${overrideStr}`);
    } else {
      logger.info(`  ${chalk.cyan(key.padEnd(16))}  ${chalk.dim("(flat default)")}  ${value}`);
    }
  }
  logger.info("  " + "─".repeat(60));
  logger.info();
}

export function printCliProviderTable(config) {
  const active = config.cliProvider ?? DEFAULT_CLI_PROVIDER;
  logger.info();
  logger.info(chalk.bold("  CLI backend"));
  logger.info("  " + "─".repeat(50));
  for (const provider of listProviders()) {
    const marker = provider === active ? chalk.green("●") : chalk.dim("○");
    const installed = isProviderInstalled(provider)
      ? chalk.green("installed")
      : chalk.red("not found on PATH");
    logger.info(`  ${marker} ${chalk.cyan(provider.padEnd(10))} ${installed}`);
  }
  logger.info("  " + "─".repeat(50));
  logger.info();
}

export function printScopeTable(config) {
  const agents = config.agents || {};
  const nameWidth = Math.max(...Object.keys(agents).map((k) => k.length), 6);
  logger.info();
  logger.info(chalk.bold("  Agent scope configuration"));
  logger.info("  " + "─".repeat(nameWidth + 4 + 40));
  for (const [agent, cfg] of Object.entries(agents)) {
    const scope = cfg?.scope;
    const scopeStr =
      !scope || scope.length === 0 ? chalk.dim("(none)") : scope.join(", ");
    logger.info(`  ${chalk.cyan(agent.padEnd(nameWidth))}  ${scopeStr}`);
  }
  logger.info("  " + "─".repeat(nameWidth + 4 + 40));
  logger.info();
}
