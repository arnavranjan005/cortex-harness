import fs from "fs-extra";
import path from "path";

export async function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    throw new Error(`Config file not found at ${configPath}. Run "npx cortex-harness init" first.`);
  }

  const config = await fs.readJson(configPath);

  // Normalize paths relative to cwd
  const normalize = (p) => path.join(cwd, p);

  const resolved = {
    ...config,
    harnessDir: normalize(config.harnessDir || ".harness"),
    promptsDir: normalize(config.promptsDir || ".harness/prompts"),
    agentsDir: normalize(config.agentsDir || ".harness/agents"),
    agents: config.agents || {},
    cwd,
  };

  // Warn about scope paths that don't exist — they'll cause scope-revert loops at runtime.
  for (const [agentName, agentConfig] of Object.entries(resolved.agents)) {
    const scope = agentConfig?.scope;
    if (!scope || scope.length === 0) continue;
    for (const scopePath of scope) {
      if (!(await fs.pathExists(path.join(cwd, scopePath)))) {
        console.warn(
          `[cortex-harness] Note: scope path "${scopePath}" for ${agentName} does not exist yet — ` +
          `the agent will create it. If this path is wrong, run "cortex-harness config" to update.`
        );
      }
    }
  }

  return resolved;
}

