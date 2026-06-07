import chalk from "chalk";
import { patchGitignore, GITIGNORE_RUNTIME_ENTRIES } from "../helpers/gitignore.mjs";

export function registerGitignoreCommand(program) {
  program
    .command("gitignore")
    .description(
      "Append harness runtime entries to .gitignore (safe to run on existing projects)",
    )
    .action(async () => {
      const result = await patchGitignore(process.cwd());
      if (result === "present") {
        console.log(
          chalk.dim(
            "  – .gitignore already contains harness entries — nothing to do.",
          ),
        );
      } else if (result === "appended") {
        console.log(
          chalk.green("  ✓ Appended harness runtime entries to .gitignore"),
        );
        console.log(chalk.dim("\n  Entries added:"));
        GITIGNORE_RUNTIME_ENTRIES.forEach((e) =>
          console.log(chalk.dim(`    ${e}`)),
        );
      } else {
        console.log(
          chalk.green("  ✓ Created .gitignore with harness runtime entries"),
        );
        console.log(chalk.dim("\n  Entries added:"));
        GITIGNORE_RUNTIME_ENTRIES.forEach((e) =>
          console.log(chalk.dim(`    ${e}`)),
        );
      }
    });
}
