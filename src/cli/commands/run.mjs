import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import chalk from "chalk";
import { logger } from "../../logger.mjs";

// ctx: { pkgRoot }
export function registerRunCommand(program, ctx) {
  program
    .command("run")
    .description("Run the autonomous loop with a task description")
    .argument("[task...]", "The task for the agent to perform")
    .option(
      "-f, --task-file <file>",
      "Read task from a file (avoids shell quoting issues with JSON/logs)",
    )
    .action(async (taskParts, options) => {
      let task;

      if (options.taskFile) {
        const taskFilePath = path.resolve(process.cwd(), options.taskFile);
        if (!fs.existsSync(taskFilePath)) {
          logger.error(chalk.red(`  Task file not found: ${taskFilePath}`));
          process.exit(1);
        }
        task = fs.readFileSync(taskFilePath, "utf8").trim();
      } else if (!process.stdin.isTTY) {
        // Piped input — read full stdin (handles PowerShell here-strings and any shell piping)
        task = await new Promise((resolve) => {
          let buf = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buf += chunk;
          });
          process.stdin.on("end", () => resolve(buf.trim()));
        });
      } else {
        task = taskParts.join(" ").trim();
      }

      if (!task) {
        logger.error(
          chalk.red(
            "  No task provided. Pass a task string, pipe via stdin, or use --task-file.",
          ),
        );
        logger.error(
          chalk.dim('  Example: cortex-harness run "fix the login bug"'),
        );
        logger.error(
          chalk.dim('  Pipe:    echo "fix the login bug" | cortex-harness run'),
        );
        process.exit(1);
      }

      const enginePath = path.join(ctx.pkgRoot, "src", "run-autonomous.mjs");
      const args = [enginePath, task];

      const proc = spawn("node", args, {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      proc.on("exit", (code) => process.exit(code ?? 0));
    });
}
