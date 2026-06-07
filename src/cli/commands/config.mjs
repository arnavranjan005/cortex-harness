import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";
import {
  loadHarnessConfig,
  saveHarnessConfig,
  repatchFromConfig,
  printScopeTable,
} from "../helpers/harness-config.mjs";

export function registerConfigCommand(program) {
  const configCmd = program
    .command("config")
    .description(
      "View and edit harness.config.json without touching JSON manually",
    );

  // bare `cortex-harness config` → interactive wizard
  configCmd.action(async () => {
    const { config, configPath } = await loadHarnessConfig(process.cwd());
    const rl = createInterface({ input, output });

    printScopeTable(config);

    const agents = Object.keys(config.agents || {});
    const editable = agents.filter(
      (a) =>
        !["explorer-subagent", "planner-subagent", "tester-subagent"].includes(a),
    );

    console.log("  Which agent scope do you want to edit?");
    editable.forEach((a, i) => console.log(`    [${i + 1}] ${a}`));
    console.log("    [0] Exit\n");

    let dirty = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const choice = await rl.question("  > ");
      const idx = parseInt(choice, 10);
      if (!choice.trim() || idx === 0) break;
      if (isNaN(idx) || idx < 1 || idx > editable.length) {
        console.log(
          chalk.yellow(`  Enter a number between 0 and ${editable.length}`),
        );
        continue;
      }
      const agent = editable[idx - 1];
      const current = (config.agents[agent]?.scope || []).join(", ");
      const raw = await rl.question(
        `  ${chalk.cyan(agent)} scope ${chalk.dim(`[${current || "none"}]`)}: `,
      );
      if (raw.trim()) {
        config.agents[agent].scope = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        console.log(chalk.green(`  ✓ Updated`));
        dirty = true;
      }
      printScopeTable(config);
      editable.forEach((a, i) => console.log(`    [${i + 1}] ${a}`));
      console.log("    [0] Exit\n");
    }

    rl.close();
    if (dirty) {
      await saveHarnessConfig(configPath, config);
      await repatchFromConfig(process.cwd(), config);
      console.log(
        chalk.green(
          "\n  harness.config.json saved and agent .md scope sections updated.",
        ),
      );
    } else {
      console.log("  No changes made.");
    }
  });

  // `cortex-harness config list` → print table and exit
  configCmd
    .command("list")
    .description("Print current agent scope configuration")
    .action(async () => {
      const { config } = await loadHarnessConfig(process.cwd());
      printScopeTable(config);
    });

  // `cortex-harness config add-scope <agent> <path>` → append a scope path
  configCmd
    .command("add-scope <agent> <scopePath>")
    .description("Add a path to an agent's scope")
    .action(async (agent, scopePath) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.agents[agent]) {
        console.error(chalk.red(`  Unknown agent: ${agent}`));
        console.log("  Available:", Object.keys(config.agents).join(", "));
        process.exit(1);
      }
      const scope = config.agents[agent].scope || [];
      const normalized = scopePath.endsWith("/") ? scopePath : scopePath + "/";
      if (scope.includes(normalized) || scope.includes(scopePath)) {
        console.log(
          chalk.yellow(
            `  "${scopePath}" is already in ${agent}'s scope — no change.`,
          ),
        );
        process.exit(0);
      }
      config.agents[agent].scope = [...scope, normalized];
      await saveHarnessConfig(configPath, config);
      await repatchFromConfig(process.cwd(), config);
      console.log(chalk.green(`  ✓ Added "${normalized}" to ${agent}`));
      printScopeTable(config);
    });

  // `cortex-harness config remove-scope <agent> <path>` → remove a scope path
  configCmd
    .command("remove-scope <agent> <scopePath>")
    .description("Remove a path from an agent's scope")
    .action(async (agent, scopePath) => {
      const { config, configPath } = await loadHarnessConfig(process.cwd());
      if (!config.agents[agent]) {
        console.error(chalk.red(`  Unknown agent: ${agent}`));
        process.exit(1);
      }
      const before = config.agents[agent].scope || [];
      const after = before.filter(
        (s) =>
          s !== scopePath &&
          s !== scopePath + "/" &&
          s !== scopePath.replace(/\/$/, ""),
      );
      if (after.length === before.length) {
        console.log(
          chalk.yellow(`  "${scopePath}" not found in ${agent}'s scope.`),
        );
        console.log("  Current scope:", before.join(", ") || "(none)");
        process.exit(0);
      }
      config.agents[agent].scope = after;
      await saveHarnessConfig(configPath, config);
      await repatchFromConfig(process.cwd(), config);
      console.log(chalk.green(`  ✓ Removed "${scopePath}" from ${agent}`));
      printScopeTable(config);
    });
}
