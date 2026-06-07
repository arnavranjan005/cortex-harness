import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { findLatestDelivery } from "../helpers/delivery.mjs";
import { clearHarnessState, spawnRun } from "../helpers/run-control.mjs";

// ctx: { pkgRoot, buildChainTask }
export function registerContinueCommand(program, ctx) {
  program
    .command("continue")
    .description(
      "One-shot continuation — extracts residual risks from last delivery and starts a new run",
    )
    .action(async () => {
      const cwd = process.cwd();

      const deliveryPath = await findLatestDelivery(cwd);
      if (!deliveryPath) {
        console.error(
          chalk.red(
            "  No delivery file found in .harness/output/. Nothing to continue from.",
          ),
        );
        console.error(chalk.dim('  Run: cortex-harness run "your task" first.'));
        process.exit(1);
      }
      console.log(chalk.dim(`  Reading: ${path.relative(cwd, deliveryPath)}`));

      const markdown = await fs.readFile(deliveryPath, "utf8");
      console.log(chalk.dim("  Asking LLM whether chaining is needed..."));
      const task = await ctx.buildChainTask(markdown);

      if (!task) {
        console.log(
          chalk.green(
            "  No actionable residual risks found — delivery is clean.",
          ),
        );
        process.exit(0);
      }

      console.log(chalk.bold("\n  Actionable work found. Next task:"));
      console.log(chalk.dim(`    ${task.split("\n")[0].slice(0, 120)}`));
      console.log();

      console.log(
        chalk.dim("  Clearing cycle-state/, task-queue.json, session.json..."),
      );
      await clearHarnessState(cwd);
      console.log(chalk.dim("  State cleared. Delivery files preserved.\n"));

      console.log(chalk.bold.cyan("  Starting continuation run...\n"));
      const exitCode = await spawnRun(task, cwd, ctx.pkgRoot);
      process.exit(exitCode);
    });
}
