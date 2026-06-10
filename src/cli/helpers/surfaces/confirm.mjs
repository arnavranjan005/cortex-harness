import chalk from "chalk";

// Prompts user to confirm or override each detected surface. Returns confirmed surface map.
export async function confirmSurfaces(detected, rl, opts = {}) {
  const isNx = detected !== null;
  const d = detected ?? {};

  if (opts.yes || !process.stdin.isTTY) {
    return {
      backend: d.backend ?? [],
      frontend: d.frontend ?? [],
      distributed: d.distributed ?? [],
      sharedSchema: d.sharedSchema ?? [],
      sharedTypes: d.sharedTypes ?? [],
      sharedUi: d.sharedUi ?? [],
    };
  }

  function fmt(paths) {
    return paths && paths.length ? paths.join(", ") : "";
  }

  async function ask(label, defaults) {
    const hint = fmt(defaults);
    const display = hint
      ? chalk.cyan(`[${hint}]`)
      : chalk.dim("[none — enter path or leave blank to skip]");
    const raw = await rl.question(`  ${chalk.bold(label)} ${display}: `);
    if (!raw.trim()) return defaults ?? [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (!isNx) {
    console.log(chalk.yellow("\n  No nx.json found — this doesn't look like an Nx workspace."));
    console.log(chalk.dim("  Enter your project surface paths manually, or press Enter to skip.\n"));
  } else {
    console.log(chalk.dim("\n  Nx workspace detected. Confirm surface paths — press Enter to accept.\n"));
  }

  return {
    backend: await ask("Backend / serverless paths", d.backend ?? []),
    frontend: await ask("Frontend paths            ", d.frontend ?? []),
    distributed: await ask("Worker / queue paths      ", d.distributed ?? []),
    sharedSchema: await ask("Shared schema lib paths   ", d.sharedSchema ?? []),
    sharedTypes: await ask("Shared types lib paths    ", d.sharedTypes ?? []),
    sharedUi: await ask("Shared UI lib paths       ", d.sharedUi ?? []),
  };
}
