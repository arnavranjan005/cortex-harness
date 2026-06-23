import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { logger } from "../../logger.mjs";
import {
  findLatestDelivery,
  findResidualRisksSection,
} from "../helpers/delivery.mjs";
import {
  clearHarnessState,
  readRunEndSpend,
  spawnRun,
  spawnResumedRun,
  resumeBlockedCycles,
} from "../helpers/run-control.mjs";
import { readBlockedTypes } from "./chain/blocked-state.mjs";
import { registerChainResumeSubcommand } from "./chain/resume-subcommand.mjs";

// ctx: { pkgRoot, buildChainTask }
export function registerChainCommand(program, ctx) {
  const { pkgRoot, buildChainTask } = ctx;

  const chainCmd = program
    .command("chain")
    .description(
      "Chain multiple runs: run → delivery → extract risks → new run, until clean or cap hit",
    )
    .argument(
      "[task...]",
      "Initial task to run (omit to continue from last delivery)",
    )
    .option("--max-runs <n>", "Maximum number of runs in the chain", "3")
    .option("--budget <usd>", "Global USD budget cap across all chained runs", "60")
    .option(
      "--resume-on-block",
      "When a run is blocked, interactively collect answers and resume within the chain",
    )
    .action(async (taskParts, options) => {
      const cwd = process.cwd();
      const maxRuns = parseInt(options.maxRuns, 10);
      const globalBudget = parseFloat(options.budget);

      if (isNaN(maxRuns) || maxRuns < 1) {
        logger.error(chalk.red("  --max-runs must be a positive integer."));
        process.exit(1);
      }
      if (isNaN(globalBudget) || globalBudget <= 0) {
        logger.error(chalk.red("  --budget must be a positive number."));
        process.exit(1);
      }

      const runsDir = path.join(cwd, ".harness", "runs");
      const queueFile = path.join(cwd, ".harness", "task-queue.json");
      let globalSpent = 0;
      let runNumber = 0;
      let currentTask = taskParts.join(" ").trim() || null;

      if (!currentTask) {
        const deliveryPath = await findLatestDelivery(cwd);
        if (!deliveryPath) {
          logger.error(
            chalk.red("  No task provided and no delivery file found in .harness/output/."),
          );
          logger.error(chalk.dim('  Provide a task: cortex-harness chain "your task"'));
          process.exit(1);
        }
        const markdown = await fs.readFile(deliveryPath, "utf8");
        logger.info(chalk.dim("  Asking LLM whether chaining is needed..."));
        const decision = await buildChainTask(markdown);
        if (decision.failed) {
          logger.info(
            chalk.yellow("  Could not determine whether chaining is needed (provider call failed) — stopping without assuming the delivery is clean."),
          );
          process.exit(1);
        }
        currentTask = decision.task;
        if (!currentTask) {
          logger.info(
            chalk.green("  No actionable residual risks in last delivery — nothing to chain."),
          );
          process.exit(0);
        }
        logger.info(chalk.dim("  Seeding chain from last delivery."));
      }

      logger.info(chalk.bold.cyan("\n  cortex-harness chain"));
      logger.info(chalk.dim(`  Max runs: ${maxRuns}  |  Global budget: $${globalBudget}`));
      logger.info(chalk.dim("─".repeat(60)));

      while (runNumber < maxRuns) {
        runNumber++;
        const remainingBudget = globalBudget - globalSpent;

        logger.info(
          chalk.bold(`\n  ══ Chain run ${runNumber}/${maxRuns}  ($${globalSpent.toFixed(2)} / $${globalBudget} spent) ══\n`),
        );

        if (remainingBudget <= 0) {
          logger.info(chalk.red("  Global budget exhausted. Stopping chain."));
          break;
        }

        const deliveryBeforeRun = await findLatestDelivery(cwd);
        const existingBlocked = readBlockedTypes(queueFile);

        if (existingBlocked.hasSessionLimit) {
          logger.info(chalk.red("  Blocked queue detected (session limit). Stopping chain — limit has not reset yet."));
          if (existingBlocked.sessionLimitReason) logger.info(chalk.dim(`  ${existingBlocked.sessionLimitReason}`));
          logger.info(chalk.dim("  Run: cortex-harness chain resume  (after your limit resets)"));
          break;
        }

        const shouldResume =
          existingBlocked.hasAny &&
          (existingBlocked.hasHumanInput && options.resumeOnBlock);

        let exitCode;
        if (shouldResume) {
          logger.info(
            chalk.yellow("  Blocked queue detected (needs human input) — collecting answers...\n"),
          );
          const resumeResult = await resumeBlockedCycles(cwd);
          if (resumeResult === "nothing-blocked") {
            logger.info(chalk.yellow("  No blocked cycles found — unexpected state. Stopping chain."));
            break;
          }
          logger.info(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
          exitCode = await spawnResumedRun(cwd, pkgRoot);
        } else if (existingBlocked.hasHumanInput && !options.resumeOnBlock) {
          logger.info(chalk.yellow("  Blocked queue detected (needs human input). Stopping chain."));
          logger.info(
            chalk.dim("  Re-run with --resume-on-block to answer inline, or: cortex-harness resume"),
          );
          break;
        } else {
          logger.info(chalk.dim("  Clearing state for fresh run..."));
          await clearHarnessState(cwd);
          exitCode = await spawnRun(currentTask, cwd, pkgRoot);
        }

        const runSpent = await readRunEndSpend(runsDir);
        globalSpent += runSpent;

        logger.info(
          chalk.dim(`\n  Run ${runNumber} complete. Exit: ${exitCode} | this run: $${runSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
        );

        if (exitCode !== 0) {
          logger.info(chalk.red(`  Run exited with code ${exitCode}. Stopping chain.`));
          break;
        }

        if (globalSpent >= globalBudget) {
          logger.info(
            chalk.red(`  Global budget cap reached ($${globalSpent.toFixed(2)} >= $${globalBudget}). Stopping.`),
          );
          break;
        }

        let deliveryPath = await findLatestDelivery(cwd);
        if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
          const midRunBlocked = readBlockedTypes(queueFile);

          if (!midRunBlocked.hasAny) {
            logger.info(
              chalk.yellow("  Run did not produce a new delivery and no blocked cycles found (aborted). Stopping chain."),
            );
            break;
          }

          if (midRunBlocked.hasSessionLimit) {
            logger.info(chalk.red("  Run hit session limit. Stopping chain — limit has not reset yet."));
            if (midRunBlocked.sessionLimitReason) logger.info(chalk.dim(`  ${midRunBlocked.sessionLimitReason}`));
            logger.info(chalk.dim("  Run: cortex-harness chain resume  (after your limit resets)"));
            break;
          }

          if (!midRunBlocked.hasHumanInput || !options.resumeOnBlock) {
            logger.info(chalk.yellow("  Run was blocked (needs human input). Stopping chain."));
            logger.info(
              chalk.dim("  Re-run with --resume-on-block to answer inline, or: cortex-harness resume"),
            );
            break;
          }

          logger.info(chalk.yellow("\n  Run was blocked — collecting answers to continue chain...\n"));
          const resumeResult = await resumeBlockedCycles(cwd);
          if (resumeResult === "nothing-blocked") {
            logger.info(chalk.yellow("  No blocked cycles found — unexpected state. Stopping chain."));
            break;
          }

          logger.info(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
          const resumeExitCode = await spawnResumedRun(cwd, pkgRoot);
          const resumeSpent = await readRunEndSpend(runsDir);
          globalSpent += resumeSpent;
          logger.info(
            chalk.dim(`  Resumed run complete. Exit: ${resumeExitCode} | this run: $${resumeSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
          );

          if (resumeExitCode !== 0) {
            logger.info(chalk.red(`  Resumed run exited with code ${resumeExitCode}. Stopping chain.`));
            break;
          }

          deliveryPath = await findLatestDelivery(cwd);
          if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
            logger.info(chalk.yellow("  Resumed run still did not produce a delivery. Stopping chain."));
            break;
          }
        }

        const markdown = await fs.readFile(deliveryPath, "utf8");

        const rawSection = findResidualRisksSection(markdown);
        if (rawSection?.includes("NEEDS_HUMAN_INPUT")) {
          logger.info(
            chalk.yellow("\n  NEEDS_HUMAN_INPUT detected in residual risks. Stopping chain — human input required."),
          );
          logger.info(chalk.dim("  Run: cortex-harness resume"));
          break;
        }

        logger.info(chalk.dim("\n  Asking LLM whether chaining is needed..."));
        const decision = await buildChainTask(markdown);
        if (decision.failed) {
          logger.info(chalk.yellow("\n  Could not determine whether chaining is needed (provider call failed) — stopping without assuming the delivery is clean."));
          break;
        }
        const nextTask = decision.task;
        if (!nextTask) {
          logger.info(chalk.green("\n  No actionable residual risks remain. Chain complete."));
          break;
        }

        if (runNumber >= maxRuns) {
          logger.info(chalk.yellow(`\n  Max runs (${maxRuns}) reached. Residual work remains:`));
          logger.info(chalk.dim(`    ${nextTask.split("\n")[0].slice(0, 120)}`));
          break;
        }

        currentTask = nextTask;
        logger.info(chalk.bold("\n  Actionable work found → chaining next run..."));
        logger.info(chalk.dim(`    ${nextTask.split("\n")[0].slice(0, 120)}`));
      }

      logger.info(chalk.bold.blue("\n━━━ Chain Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      logger.info(`${chalk.dim("Runs completed:")} ${runNumber}`);
      logger.info(`${chalk.dim("Global spend  :")} $${globalSpent.toFixed(2)} / $${globalBudget}`);
      logger.info(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

      process.exit(0);
    });

  registerChainResumeSubcommand(chainCmd, { pkgRoot, buildChainTask });
}
