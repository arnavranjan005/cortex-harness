import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
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
        console.error(chalk.red("  --max-runs must be a positive integer."));
        process.exit(1);
      }
      if (isNaN(globalBudget) || globalBudget <= 0) {
        console.error(chalk.red("  --budget must be a positive number."));
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
          console.error(
            chalk.red("  No task provided and no delivery file found in .harness/output/."),
          );
          console.error(chalk.dim('  Provide a task: cortex-harness chain "your task"'));
          process.exit(1);
        }
        const markdown = await fs.readFile(deliveryPath, "utf8");
        console.log(chalk.dim("  Asking LLM whether chaining is needed..."));
        currentTask = await buildChainTask(markdown);
        if (!currentTask) {
          console.log(
            chalk.green("  No actionable residual risks in last delivery — nothing to chain."),
          );
          process.exit(0);
        }
        console.log(chalk.dim("  Seeding chain from last delivery."));
      }

      console.log(chalk.bold.cyan("\n  cortex-harness chain"));
      console.log(chalk.dim(`  Max runs: ${maxRuns}  |  Global budget: $${globalBudget}`));
      console.log(chalk.dim("─".repeat(60)));

      while (runNumber < maxRuns) {
        runNumber++;
        const remainingBudget = globalBudget - globalSpent;

        console.log(
          chalk.bold(`\n  ══ Chain run ${runNumber}/${maxRuns}  ($${globalSpent.toFixed(2)} / $${globalBudget} spent) ══\n`),
        );

        if (remainingBudget <= 0) {
          console.log(chalk.red("  Global budget exhausted. Stopping chain."));
          break;
        }

        const deliveryBeforeRun = await findLatestDelivery(cwd);
        const existingBlocked = readBlockedTypes(queueFile);

        const shouldResume =
          existingBlocked.hasAny &&
          (existingBlocked.hasSessionLimit ||
            (existingBlocked.hasHumanInput && options.resumeOnBlock));

        let exitCode;
        if (shouldResume) {
          if (existingBlocked.hasHumanInput) {
            console.log(
              chalk.yellow("  Blocked queue detected (needs human input) — collecting answers...\n"),
            );
          } else {
            console.log(chalk.dim("  Blocked queue detected (session limit) — auto-resuming...\n"));
          }
          const resumeResult = await resumeBlockedCycles(cwd);
          if (resumeResult === "nothing-blocked") {
            console.log(chalk.yellow("  No blocked cycles found — unexpected state. Stopping chain."));
            break;
          }
          console.log(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
          exitCode = await spawnResumedRun(cwd, pkgRoot);
        } else if (existingBlocked.hasHumanInput && !options.resumeOnBlock) {
          console.log(chalk.yellow("  Blocked queue detected (needs human input). Stopping chain."));
          console.log(
            chalk.dim("  Re-run with --resume-on-block to answer inline, or: cortex-harness resume"),
          );
          break;
        } else {
          console.log(chalk.dim("  Clearing state for fresh run..."));
          await clearHarnessState(cwd);
          exitCode = await spawnRun(currentTask, cwd, pkgRoot);
        }

        const runSpent = await readRunEndSpend(runsDir);
        globalSpent += runSpent;

        console.log(
          chalk.dim(`\n  Run ${runNumber} complete. Exit: ${exitCode} | this run: $${runSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
        );

        if (exitCode !== 0) {
          console.log(chalk.red(`  Run exited with code ${exitCode}. Stopping chain.`));
          break;
        }

        if (globalSpent >= globalBudget) {
          console.log(
            chalk.red(`  Global budget cap reached ($${globalSpent.toFixed(2)} >= $${globalBudget}). Stopping.`),
          );
          break;
        }

        let deliveryPath = await findLatestDelivery(cwd);
        if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
          const midRunBlocked = readBlockedTypes(queueFile);

          const canAutoResume = midRunBlocked.hasSessionLimit && !midRunBlocked.hasHumanInput;
          const canInteractiveResume = midRunBlocked.hasHumanInput && options.resumeOnBlock;

          if (!midRunBlocked.hasAny) {
            console.log(
              chalk.yellow("  Run did not produce a new delivery and no blocked cycles found (aborted). Stopping chain."),
            );
            break;
          } else if (!canAutoResume && !canInteractiveResume) {
            console.log(chalk.yellow("  Run was blocked (needs human input). Stopping chain."));
            console.log(
              chalk.dim("  Re-run with --resume-on-block to answer inline, or: cortex-harness resume"),
            );
            break;
          }

          if (midRunBlocked.hasHumanInput) {
            console.log(chalk.yellow("\n  Run was blocked — collecting answers to continue chain...\n"));
          } else {
            console.log(chalk.dim("\n  Run hit session limit — auto-resuming...\n"));
          }
          const resumeResult = await resumeBlockedCycles(cwd);
          if (resumeResult === "nothing-blocked") {
            console.log(chalk.yellow("  No blocked cycles found — unexpected state. Stopping chain."));
            break;
          }

          console.log(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
          const resumeExitCode = await spawnResumedRun(cwd, pkgRoot);
          const resumeSpent = await readRunEndSpend(runsDir);
          globalSpent += resumeSpent;
          console.log(
            chalk.dim(`  Resumed run complete. Exit: ${resumeExitCode} | this run: $${resumeSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`),
          );

          if (resumeExitCode !== 0) {
            console.log(chalk.red(`  Resumed run exited with code ${resumeExitCode}. Stopping chain.`));
            break;
          }

          deliveryPath = await findLatestDelivery(cwd);
          if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
            console.log(chalk.yellow("  Resumed run still did not produce a delivery. Stopping chain."));
            break;
          }
        }

        const markdown = await fs.readFile(deliveryPath, "utf8");

        const rawSection = findResidualRisksSection(markdown);
        if (rawSection?.includes("NEEDS_HUMAN_INPUT")) {
          console.log(
            chalk.yellow("\n  NEEDS_HUMAN_INPUT detected in residual risks. Stopping chain — human input required."),
          );
          console.log(chalk.dim("  Run: cortex-harness resume"));
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

        currentTask = nextTask;
        console.log(chalk.bold("\n  Actionable work found → chaining next run..."));
        console.log(chalk.dim(`    ${nextTask.split("\n")[0].slice(0, 120)}`));
      }

      console.log(chalk.bold.blue("\n━━━ Chain Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      console.log(`${chalk.dim("Runs completed:")} ${runNumber}`);
      console.log(`${chalk.dim("Global spend  :")} $${globalSpent.toFixed(2)} / $${globalBudget}`);
      console.log(chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

      process.exit(0);
    });

  registerChainResumeSubcommand(chainCmd, { pkgRoot, buildChainTask });
}
