import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { logger } from "../../../logger.mjs";
import {
  findLatestDelivery,
  findResidualRisksSection,
} from "../../helpers/delivery.mjs";
import {
  readRunEndSpend,
  spawnResumedRun,
  spawnRun,
  clearHarnessState,
} from "../../helpers/run-control.mjs";
import { resumeBlockedCycles } from "../../helpers/run-control.mjs";
import { readBlockedTypes } from "./blocked-state.mjs";

/**
 * Register the `chain resume` subcommand onto the parent chainCmd.
 *
 * @param {object} chainCmd  - commander Command for `chain`
 * @param {object} ctx
 * @param {string} ctx.pkgRoot       - cortex-harness package root
 * @param {Function} ctx.buildChainTask - (markdown) => Promise<import('../../helpers/chain-task.mjs').ChainDecision>
 */
export function registerChainResumeSubcommand(chainCmd, { pkgRoot, buildChainTask }) {
  chainCmd
    .command("resume")
    .description(
      "Resume a run with pending or blocked cycles, then keep chaining from the resulting delivery",
    )
    .option("--max-runs <n>", "Maximum number of chained runs after the resumed run", "3")
    .option("--budget <usd>", "Global USD budget cap across all runs", "60")
    .action(async (options) => {
      const cwd = process.cwd();
      const runsDir = path.join(cwd, ".harness", "runs");
      const maxRuns = parseInt(options.maxRuns, 10);
      const globalBudget = parseFloat(options.budget);
      let globalSpent = 0;

      // ── Step 1: determine queue state ─────────────────────────────────────────

      const queueFile = path.join(cwd, ".harness", "task-queue.json");
      if (!fs.existsSync(queueFile)) {
        logger.error(chalk.red("  [ERROR] No task-queue.json found. Nothing to resume."));
        logger.error(chalk.dim('  Start a run first: cortex-harness run "your task"'));
        process.exit(1);
      }

      let cycles = [];
      try {
        cycles = JSON.parse(fs.readFileSync(queueFile, "utf8")).cycles ?? [];
      } catch {
        logger.error(chalk.red("  [ERROR] Could not parse task-queue.json."));
        process.exit(1);
      }

      const blocked = cycles.filter((c) => c.status === "blocked");
      const pending = cycles.filter((c) => c.status === "pending");

      if (!blocked.length && !pending.length) {
        logger.error(chalk.red("  [ERROR] No pending or blocked cycles in task-queue.json."));
        logger.error(chalk.dim("  Use: cortex-harness chain [task] to start a new chain."));
        process.exit(1);
      }

      const hasHumanInput = blocked.some((c) => c.blockedType === "needs-human-input");
      const hasSessionLimit = blocked.some((c) => c.blockedType === "session-limit");
      const hasPending = pending.length > 0;

      logger.info(chalk.bold.cyan("\n  cortex-harness chain resume"));
      logger.info(chalk.dim(`  Max runs: ${maxRuns}  |  Global budget: $${globalBudget}`));
      if (hasHumanInput)
        logger.info(
          chalk.yellow(`  ${blocked.filter((c) => c.blockedType === "needs-human-input").length} cycle(s) need your input`),
        );
      if (hasSessionLimit)
        logger.info(
          chalk.dim(`  ${blocked.filter((c) => c.blockedType === "session-limit").length} session-limit cycle(s) will auto-retry`),
        );
      if (hasPending && !blocked.length)
        logger.info(chalk.dim(`  ${pending.length} pending cycle(s) — resuming queue directly`));
      logger.info(chalk.dim("─".repeat(60)));

      const deliveryBeforeResume = await findLatestDelivery(cwd);

      // ── Step 2: resolve blocks then run pending ────────────────────────────────

      let resumeExitCode;

      if (blocked.length) {
        // Handle blocked cycles first (human-input or session-limit)
        const resumeResult = await resumeBlockedCycles(cwd);
        if (resumeResult === "nothing-blocked") {
          logger.error(chalk.red("  [ERROR] No blocked cycles found — unexpected state."));
          process.exit(1);
        }
        logger.info(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
      } else {
        logger.info(chalk.dim("\n  Resuming pending queue (state preserved)...\n"));
      }

      resumeExitCode = await spawnResumedRun(cwd, pkgRoot);
      const resumeSpent = await readRunEndSpend(runsDir);
      globalSpent += resumeSpent;

      logger.info(
        chalk.dim(`\n  Resumed run complete. Exit: ${resumeExitCode} | this run: $${resumeSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
      );

      if (resumeExitCode !== 0) {
        logger.info(chalk.red(`  Resumed run exited with code ${resumeExitCode}. Stopping.`));
        process.exit(resumeExitCode);
      }

      let deliveryPath = await findLatestDelivery(cwd);
      if (!deliveryPath || deliveryPath === deliveryBeforeResume) {
        logger.info(chalk.yellow("  Resumed run did not produce a delivery. Cannot continue chain."));
        process.exit(1);
      }

      // ── Step 3: chain from the delivery the resumed run produced ──────────────

      let runNumber = 1;

      while (runNumber < maxRuns) {
        const markdown = await fs.readFile(deliveryPath, "utf8");

        const rawSection = findResidualRisksSection(markdown);
        if (rawSection?.includes("NEEDS_HUMAN_INPUT")) {
          logger.info(
            chalk.yellow("\n  NEEDS_HUMAN_INPUT in residual risks. Stopping chain — human input required."),
          );
          logger.info(chalk.dim("  Run: cortex-harness chain resume"));
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

        const remainingBudget = globalBudget - globalSpent;
        if (remainingBudget <= 0) {
          logger.info(chalk.red("  Global budget exhausted. Stopping chain."));
          break;
        }

        runNumber++;
        logger.info(
          chalk.bold(`\n  ══ Chain run ${runNumber}/${maxRuns}  ($${globalSpent.toFixed(2)} / $${globalBudget} spent) ══\n`),
        );

        const currentTask = nextTask;
        const deliveryBeforeRun = await findLatestDelivery(cwd);
        const midBlocked = readBlockedTypes(queueFile);

        let runExitCode;
        if (midBlocked.hasSessionLimit) {
          logger.info(chalk.red("  Run hit session limit. Stopping chain — limit has not reset yet."));
          if (midBlocked.sessionLimitReason) logger.info(chalk.dim(`  ${midBlocked.sessionLimitReason}`));
          logger.info(chalk.dim("  Run: cortex-harness chain resume  (after your limit resets)"));
          break;
        } else if (midBlocked.hasHumanInput) {
          logger.info(chalk.yellow("  Human input required — collecting answers...\n"));
          await resumeBlockedCycles(cwd);
          runExitCode = await spawnResumedRun(cwd, pkgRoot);
        } else {
          logger.info(chalk.dim("  Clearing state for fresh run..."));
          await clearHarnessState(cwd);
          runExitCode = await spawnRun(currentTask, cwd, pkgRoot);
        }

        const runSpent = await readRunEndSpend(runsDir);
        globalSpent += runSpent;
        logger.info(
          chalk.dim(`\n  Run ${runNumber} complete. Exit: ${runExitCode} | this run: $${runSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
        );

        if (runExitCode !== 0) {
          logger.info(chalk.red(`  Run exited with code ${runExitCode}. Stopping chain.`));
          break;
        }

        if (globalSpent >= globalBudget) {
          logger.info(chalk.red(`  Global budget cap reached ($${globalSpent.toFixed(2)} >= $${globalBudget}). Stopping.`));
          break;
        }

        deliveryPath = await findLatestDelivery(cwd);
        if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
          logger.info(chalk.yellow("  Run did not produce a new delivery (blocked or aborted). Stopping chain."));
          logger.info(chalk.dim("  Run: cortex-harness chain resume"));
          break;
        }
      }

      logger.info(chalk.bold.blue("\n━━━ Chain Resume Summary ━━━━━━━━━━━━━━━━━━━━━━━━━"));
      logger.info(`${chalk.dim("Runs completed:")} ${runNumber}`);
      logger.info(`${chalk.dim("Global spend  :")} $${globalSpent.toFixed(2)} / $${globalBudget}`);
      logger.info(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

      process.exit(0);
    });
}
