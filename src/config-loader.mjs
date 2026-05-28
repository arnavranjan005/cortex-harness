import fs from "fs-extra";
import path from "path";

export async function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    throw new Error(`Config file not found at ${configPath}. Run "npx open-agent-harness init" first.`);
  }

  const config = await fs.readJson(configPath);

  // Normalize paths relative to cwd
  const normalize = (p) => path.join(cwd, p);

  return {
    ...config,
    harnessDir: normalize(config.harnessDir || ".harness"),
    promptsDir: normalize(config.promptsDir || ".harness/prompts"),
    agentsDir: normalize(config.agentsDir || ".harness/agents"),
    agents: config.agents || {},
    cwd
  };
}

