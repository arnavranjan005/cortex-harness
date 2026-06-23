#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";

import { registerInitCommand } from "../src/cli/commands/init.mjs";
import { registerConfigCommand } from "../src/cli/commands/config.mjs";
import { registerGitignoreCommand } from "../src/cli/commands/gitignore.mjs";
import { registerRunCommand } from "../src/cli/commands/run.mjs";
import { registerContinueCommand } from "../src/cli/commands/continue.mjs";
import { registerChainCommand } from "../src/cli/commands/chain.mjs";
import { registerStatusCommand } from "../src/cli/commands/status.mjs";
import { registerResumeCommand } from "../src/cli/commands/resume.mjs";
import { registerLogsCommand } from "../src/cli/commands/logs.mjs";
import {
  registerNotifySetupCommand,
  registerNotifyCommand,
} from "../src/cli/commands/notify.mjs";
import { registerMcpCommand } from "../src/cli/commands/mcp.mjs";
import { registerAuthCommand } from "../src/cli/commands/auth.mjs";
import { buildChainTask as _buildChainTask } from "../src/cli/helpers/chain-task.mjs";
import { loadConfig } from "../src/config-loader.mjs";
import { resolveAdapter, DEFAULT_CLI_PROVIDER } from "../src/engine/cli-adapters/registry.mjs";

const _require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.join(__dirname, "..");

const { version: pkgVersion } = _require("../package.json");

// Resolve the active adapter fresh per call from the orchestrated project's
// own harness.config.json (process.cwd(), not pkgRoot — that's cortex-harness's
// own install dir) — falls back to the Claude adapter if no config exists yet,
// matching buildChainTask's own default-param behavior.
//
// _buildChainTask's own "pkgRoot" param is actually used as a working
// directory — its tmp file and the LLM sub-process it spawns both need to run
// inside the orchestrated project, not cortex-harness's own install dir.
// Passing pkgRoot here was a real bug: it spawned the chain-decision call
// from cortex-harness's own directory, which has no opencode.json of its own
// and can silently pick a different (and possibly unconfigured/unpaid) default
// model than the project actually uses for its real cycles — confirmed live
// via opencode's session log showing the wrong `directory` and a model the
// project's other calls never hit.
const buildChainTask = async (markdown) => {
  let adapter;
  try {
    const config = await loadConfig();
    adapter = resolveAdapter(config.cliProvider ?? DEFAULT_CLI_PROVIDER);
  } catch {
    adapter = undefined; // buildChainTask defaults to claudeAdapter internally
  }
  return _buildChainTask(markdown, { pkgRoot: process.cwd(), adapter });
};

const program = new Command();
program
  .name("cortex-harness")
  .description("CLI to scaffold and run an autonomous agent harness")
  .version(pkgVersion);

registerInitCommand(program, { pkgRoot, pkgVersion });
registerConfigCommand(program);
registerGitignoreCommand(program);
registerRunCommand(program, { pkgRoot });
registerContinueCommand(program, { pkgRoot, buildChainTask });
registerChainCommand(program, { pkgRoot, buildChainTask });
registerStatusCommand(program);
registerResumeCommand(program, { pkgRoot });
registerLogsCommand(program);
registerNotifySetupCommand(program);
registerNotifyCommand(program, { pkgRoot });
registerMcpCommand(program);
registerAuthCommand(program);

program.parse();
