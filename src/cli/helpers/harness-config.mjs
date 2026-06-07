import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { patchAgentScopes } from "./surfaces.mjs";

export async function loadHarnessConfig(cwd) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    console.error(
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
export async function repatchFromConfig(cwd, config) {
  const agentsDir = path.join(cwd, config.harnessDir ?? ".harness", "agents");
  if (!(await fs.pathExists(agentsDir))) return;
  await patchAgentScopes(agentsDir, surfacesFromConfig(config));
}

export function printScopeTable(config) {
  const agents = config.agents || {};
  const nameWidth = Math.max(...Object.keys(agents).map((k) => k.length), 6);
  console.log();
  console.log(chalk.bold("  Agent scope configuration"));
  console.log("  " + "─".repeat(nameWidth + 4 + 40));
  for (const [agent, cfg] of Object.entries(agents)) {
    const scope = cfg?.scope;
    const scopeStr =
      !scope || scope.length === 0 ? chalk.dim("(none)") : scope.join(", ");
    console.log(`  ${chalk.cyan(agent.padEnd(nameWidth))}  ${scopeStr}`);
  }
  console.log("  " + "─".repeat(nameWidth + 4 + 40));
  console.log();
}
