import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { findLatestDelivery } from "../helpers/delivery.mjs";
import { clearHarnessState, spawnRun } from "../helpers/run-control.mjs";
import { logger } from "../../logger.mjs";

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
        logger.error(
          chalk.red(
            "  No delivery file found in .harness/output/. Nothing to continue from.",
          ),
        );
        logger.error(chalk.dim('  Run: cortex-harness run "your task" first.'));
        process.exit(1);
      }
      logger.info(chalk.dim(`  Reading: ${path.relative(cwd, deliveryPath)}`));

      const markdown = await fs.readFile(deliveryPath, "utf8");
      logger.info(chalk.dim("  Asking LLM whether chaining is needed..."));
      const decision = await ctx.buildChainTask(markdown);

      if (decision.failed) {
        logger.info(
          chalk.yellow(
            "  Could not determine whether chaining is needed (provider call failed) — stopping without assuming the delivery is clean.",
          ),
        );
        process.exit(1);
      }
      const task = decision.task;

      if (!task) {
        logger.info(
          chalk.green(
            "  No actionable residual risks found — delivery is clean.",
          ),
        );
        process.exit(0);
      }

      logger.info(chalk.bold("\n  Actionable work found. Next task:"));
      logger.info(chalk.dim(`    ${task.split("\n")[0].slice(0, 120)}`));
      logger.info();

      logger.info(
        chalk.dim("  Clearing cycle-state/, task-queue.json, session.json..."),
      );
      await clearHarnessState(cwd);
      logger.info(chalk.dim("  State cleared. Delivery files preserved.\n"));

      logger.info(chalk.bold.cyan("  Starting continuation run...\n"));
      const exitCode = await spawnRun(task, cwd, ctx.pkgRoot);
      process.exit(exitCode);
    });
}
