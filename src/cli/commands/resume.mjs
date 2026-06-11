import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import chalk from "chalk";
import { resumeBlockedCycles } from "../helpers/run-control.mjs";
import { confirm } from "../helpers/ui.mjs";

// ctx: { pkgRoot }
export function registerResumeCommand(program, ctx) {
  program
    .command("resume")
    .description(
      "Resume a blocked run — walks through each blocked cycle interactively",
    )
    .action(async () => {
      process.once("SIGINT", () => {
        console.log(
          chalk.yellow(
            "\n\n  Cancelled — no changes saved. Cycles remain blocked.",
          ),
        );
        process.exit(0);
      });

      const cwd = process.cwd();
      const result = await resumeBlockedCycles(cwd);

      if (result === "nothing-blocked") {
        const queueFile = path.join(cwd, ".harness", "task-queue.json");
        if (!fs.existsSync(queueFile)) {
          console.error(
            chalk.red("[ERROR] No task-queue.json found. Nothing to resume."),
          );
          process.exit(1);
        }
        console.log(chalk.dim("[INFO] No blocked cycles found. Starting run..."));
      }

      // Ask whether to start the run
      console.log();
      const startRun = await confirm({
        message: "Start run now?",
        initialValue: true,
        fallback: true,
      });
      if (!startRun) {
        console.log(
          chalk.dim("\n  Run skipped. Start manually with: cortex-harness run"),
        );
        return;
      }
      console.log();

      const runPath = path.join(ctx.pkgRoot, "src", "run-autonomous.mjs");
      const proc = spawn("node", [runPath], { stdio: "inherit", cwd });
      proc.on("exit", (code) => process.exit(code ?? 0));
    });
}
