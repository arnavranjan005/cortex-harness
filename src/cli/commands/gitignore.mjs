import chalk from "chalk";
import { patchGitignore, GITIGNORE_RUNTIME_ENTRIES } from "../helpers/gitignore.mjs";
import { logger } from "../../logger.mjs";

export function registerGitignoreCommand(program) {
  program
    .command("gitignore")
    .description(
      "Append harness runtime entries to .gitignore (safe to run on existing projects)",
    )
    .action(async () => {
      const result = await patchGitignore(process.cwd());
      if (result === "present") {
        logger.info(
          chalk.dim(
            "  – .gitignore already contains harness entries — nothing to do.",
          ),
        );
      } else if (result === "appended") {
        logger.info(
          chalk.green("  ✓ Appended harness runtime entries to .gitignore"),
        );
        logger.info(chalk.dim("\n  Entries added:"));
        GITIGNORE_RUNTIME_ENTRIES.forEach((e) =>
          logger.info(chalk.dim(`    ${e}`)),
        );
      } else {
        logger.info(
          chalk.green("  ✓ Created .gitignore with harness runtime entries"),
        );
        logger.info(chalk.dim("\n  Entries added:"));
        GITIGNORE_RUNTIME_ENTRIES.forEach((e) =>
          logger.info(chalk.dim(`    ${e}`)),
        );
      }
    });
}
