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
import { registerNotifySetupCommand, registerNotifyCommand } from "../src/cli/commands/notify.mjs";
import { registerMcpCommand } from "../src/cli/commands/mcp.mjs";
import { buildChainTask as _buildChainTask } from "../src/cli/helpers/chain-task.mjs";

const _require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.join(__dirname, "..");

const { version: pkgVersion } = _require("../package.json");

// Bind pkgRoot into the shared buildChainTask helper.
const buildChainTask = (markdown) => _buildChainTask(markdown, { pkgRoot });

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

program.parse();
