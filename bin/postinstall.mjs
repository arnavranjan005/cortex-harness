#!/usr/bin/env node
// Only runs on global install — skip when installed as a project dependency or in CI
if (process.env.npm_config_global !== "true") process.exit(0);
if (process.env.CI) process.exit(0);

const { default: chalk } = await import("chalk");

console.log(`
  ${chalk.bold.cyan("cortex-harness")} ${chalk.dim("installed ✓")}

  Get started in your Nx workspace:

    ${chalk.green("cortex-harness init")}          scaffold .harness/ and detect surfaces
    ${chalk.green('cortex-harness run "..."')}     run your first autonomous task
    ${chalk.green("cortex-harness chain \"...\"")}   run until residual risks are gone
    ${chalk.dim("cortex-harness --help")}      see all commands

  Docs  → ${chalk.cyan("https://github.com/arnavranjan005/cortex-harness")}
  npm   → ${chalk.cyan("https://www.npmjs.com/package/cortex-harness")}
`);
