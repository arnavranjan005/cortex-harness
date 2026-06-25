import { logger } from "./logger.mjs";
﻿import fs from "fs-extra";
import path from "path";
import { DEFAULT_CLI_PROVIDER } from "./engine/cli-adapters/registry.mjs";

// "<dir>-<provider>" sibling, if the provider is non-default — e.g.
// ".harness/prompts-opencode". This is a per-file override directory, not a
// full replacement: most prompt/agent files are identical across providers,
// so only the handful that actually differ need to exist there. The
// per-file fallback (try override dir, fall back to the base dir) lives in
// prompt-builder.mjs — this just computes the path string, with no existence
// check, since most lookups in that directory are expected to miss.
function providerOverrideDir(baseDir, provider) {
  if (!provider || provider === DEFAULT_CLI_PROVIDER) return null;
  return `${baseDir}-${provider}`;
}

export async function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    throw new Error(`Config file not found at ${configPath}. Run "npx cortex-harness init" first.`);
  }

  const config = await fs.readJson(configPath);

  // Normalize paths relative to cwd
  const normalize = (p) => path.join(cwd, p);

  const cliProvider = config.cliProvider ?? DEFAULT_CLI_PROVIDER;
  const promptsDir = normalize(config.promptsDir || ".harness/prompts");
  const agentsDir = normalize(config.agentsDir || ".harness/agents");

  const resolved = {
    ...config,
    cliProvider,
    harnessDir: normalize(config.harnessDir || ".harness"),
    promptsDir,
    agentsDir,
    promptsOverrideDir: providerOverrideDir(promptsDir, cliProvider),
    agentsOverrideDir: providerOverrideDir(agentsDir, cliProvider),
    agents: config.agents || {},
    cwd,
  };

  // Warn about scope paths that don't exist — they'll cause scope-revert loops at runtime.
  for (const [agentName, agentConfig] of Object.entries(resolved.agents)) {
    const scope = agentConfig?.scope;
    if (!scope || scope.length === 0) continue;
    for (const scopePath of scope) {
      if (!(await fs.pathExists(path.join(cwd, scopePath)))) {
        logger.warn(
          `[cortex-harness] Note: scope path "${scopePath}" for ${agentName} does not exist yet — ` +
          `the agent will create it. If this path is wrong, run "cortex-harness config" to update.`
        );
      }
    }
  }

  return resolved;
}

