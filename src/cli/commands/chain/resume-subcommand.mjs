import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
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
 * @param {Function} ctx.buildChainTask - (markdown) => string | null
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
        console.error(chalk.red("  [ERROR] No task-queue.json found. Nothing to resume."));
        console.error(chalk.dim('  Start a run first: cortex-harness run "your task"'));
        process.exit(1);
      }

      let cycles = [];
      try {
        cycles = JSON.parse(fs.readFileSync(queueFile, "utf8")).cycles ?? [];
      } catch {
        console.error(chalk.red("  [ERROR] Could not parse task-queue.json."));
        process.exit(1);
      }

      const blocked = cycles.filter((c) => c.status === "blocked");
      const pending = cycles.filter((c) => c.status === "pending");

      if (!blocked.length && !pending.length) {
        console.error(chalk.red("  [ERROR] No pending or blocked cycles in task-queue.json."));
        console.error(chalk.dim("  Use: cortex-harness chain [task] to start a new chain."));
        process.exit(1);
      }

      const hasHumanInput = blocked.some((c) => c.blockedType === "needs-human-input");
      const hasSessionLimit = blocked.some((c) => c.blockedType === "session-limit");
      const hasPending = pending.length > 0;

      console.log(chalk.bold.cyan("\n  cortex-harness chain resume"));
      console.log(chalk.dim(`  Max runs: ${maxRuns}  |  Global budget: $${globalBudget}`));
      if (hasHumanInput)
        console.log(
          chalk.yellow(`  ${blocked.filter((c) => c.blockedType === "needs-human-input").length} cycle(s) need your input`),
        );
      if (hasSessionLimit)
        console.log(
          chalk.dim(`  ${blocked.filter((c) => c.blockedType === "session-limit").length} session-limit cycle(s) will auto-retry`),
        );
      if (hasPending && !blocked.length)
        console.log(chalk.dim(`  ${pending.length} pending cycle(s) — resuming queue directly`));
      console.log(chalk.dim("─".repeat(60)));

      const deliveryBeforeResume = await findLatestDelivery(cwd);

      // ── Step 2: resolve blocks then run pending ────────────────────────────────

      let resumeExitCode;

      if (blocked.length) {
        // Handle blocked cycles first (human-input or session-limit)
        const resumeResult = await resumeBlockedCycles(cwd);
        if (resumeResult === "nothing-blocked") {
          console.error(chalk.red("  [ERROR] No blocked cycles found — unexpected state."));
          process.exit(1);
        }
        console.log(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
      } else {
        console.log(chalk.dim("\n  Resuming pending queue (state preserved)...\n"));
      }

      resumeExitCode = await spawnResumedRun(cwd, pkgRoot);
      const resumeSpent = await readRunEndSpend(runsDir);
      globalSpent += resumeSpent;

      console.log(
        chalk.dim(`\n  Resumed run complete. Exit: ${resumeExitCode} | this run: $${resumeSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
      );

      if (resumeExitCode !== 0) {
        console.log(chalk.red(`  Resumed run exited with code ${resumeExitCode}. Stopping.`));
        process.exit(resumeExitCode);
      }

      let deliveryPath = await findLatestDelivery(cwd);
      if (!deliveryPath || deliveryPath === deliveryBeforeResume) {
        console.log(chalk.yellow("  Resumed run did not produce a delivery. Cannot continue chain."));
        process.exit(1);
      }

      // ── Step 3: chain from the delivery the resumed run produced ──────────────

      let runNumber = 1;

      while (runNumber < maxRuns) {
        const markdown = await fs.readFile(deliveryPath, "utf8");

        const rawSection = findResidualRisksSection(markdown);
        if (rawSection?.includes("NEEDS_HUMAN_INPUT")) {
          console.log(
            chalk.yellow("\n  NEEDS_HUMAN_INPUT in residual risks. Stopping chain — human input required."),
          );
          console.log(chalk.dim("  Run: cortex-harness chain resume"));
          break;
        }

        console.log(chalk.dim("\n  Asking LLM whether chaining is needed..."));
        const nextTask = await buildChainTask(markdown);
        if (!nextTask) {
          console.log(chalk.green("\n  No actionable residual risks remain. Chain complete."));
          break;
        }

        if (runNumber >= maxRuns) {
          console.log(chalk.yellow(`\n  Max runs (${maxRuns}) reached. Residual work remains:`));
          console.log(chalk.dim(`    ${nextTask.split("\n")[0].slice(0, 120)}`));
          break;
        }

        const remainingBudget = globalBudget - globalSpent;
        if (remainingBudget <= 0) {
          console.log(chalk.red("  Global budget exhausted. Stopping chain."));
          break;
        }

        runNumber++;
        console.log(
          chalk.bold(`\n  ══ Chain run ${runNumber}/${maxRuns}  ($${globalSpent.toFixed(2)} / $${globalBudget} spent) ══\n`),
        );

        const currentTask = nextTask;
        const deliveryBeforeRun = await findLatestDelivery(cwd);
        const midBlocked = readBlockedTypes(queueFile);

        let runExitCode;
        if (midBlocked.hasSessionLimit) {
          console.log(chalk.red("  Run hit session limit. Stopping chain — limit has not reset yet."));
          if (midBlocked.sessionLimitReason) console.log(chalk.dim(`  ${midBlocked.sessionLimitReason}`));
          console.log(chalk.dim("  Run: cortex-harness chain resume  (after your limit resets)"));
          break;
        } else if (midBlocked.hasHumanInput) {
          console.log(chalk.yellow("  Human input required — collecting answers...\n"));
          await resumeBlockedCycles(cwd);
          runExitCode = await spawnResumedRun(cwd, pkgRoot);
        } else {
          console.log(chalk.dim("  Clearing state for fresh run..."));
          await clearHarnessState(cwd);
          runExitCode = await spawnRun(currentTask, cwd, pkgRoot);
        }

        const runSpent = await readRunEndSpend(runsDir);
        globalSpent += runSpent;
        console.log(
          chalk.dim(`\n  Run ${runNumber} complete. Exit: ${runExitCode} | this run: $${runSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
        );

        if (runExitCode !== 0) {
          console.log(chalk.red(`  Run exited with code ${runExitCode}. Stopping chain.`));
          break;
        }

        if (globalSpent >= globalBudget) {
          console.log(chalk.red(`  Global budget cap reached ($${globalSpent.toFixed(2)} >= $${globalBudget}). Stopping.`));
          break;
        }

        deliveryPath = await findLatestDelivery(cwd);
        if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
          console.log(chalk.yellow("  Run did not produce a new delivery (blocked or aborted). Stopping chain."));
          console.log(chalk.dim("  Run: cortex-harness chain resume"));
          break;
        }
      }

      console.log(chalk.bold.blue("\n━━━ Chain Resume Summary ━━━━━━━━━━━━━━━━━━━━━━━━━"));
      console.log(`${chalk.dim("Runs completed:")} ${runNumber}`);
      console.log(`${chalk.dim("Global spend  :")} $${globalSpent.toFixed(2)} / $${globalBudget}`);
      console.log(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

      process.exit(0);
    });
}
