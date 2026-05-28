#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.join(__dirname, "..");

const program = new Command();

program
  .name("cortex-harness")
  .description("CLI to scaffold and run an autonomous agent harness")
  .version("1.0.0");

// ─── helpers ────────────────────────────────────────────────────────────────

async function getAllFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await getAllFiles(full)));
    else files.push(full);
  }
  return files;
}

// Copy a single file, prompting keep/update if it already exists.
// Returns "created" | "updated" | "kept"
async function copyFile(src, dest, rel, rl) {
  const exists = await fs.pathExists(dest);
  if (exists) {
    const answer = await rl.question(`  ? ${rel} already exists. Keep [k] or update [u]? `);
    if (!answer.toLowerCase().startsWith("u")) {
      return "kept";
    }
  }
  await fs.ensureDir(path.dirname(dest));
  await fs.copy(src, dest, { overwrite: true });
  return exists ? "updated" : "created";
}

// Copy all files in srcDir → destDir, prompting per conflict.
async function copyDir(srcDir, destDir, rl, rootLabel) {
  if (!(await fs.pathExists(srcDir))) return;
  const files = await getAllFiles(srcDir);
  for (const srcFile of files) {
    const rel = path.join(rootLabel, path.relative(srcDir, srcFile));
    const destFile = path.join(destDir, path.relative(srcDir, srcFile));
    const status = await copyFile(srcFile, destFile, rel, rl);
    const icon = status === "kept" ? "–" : status === "updated" ? "↑" : "+";
    console.log(`  ${icon} ${rel}`);
  }
}

// ─── surface detection ───────────────────────────────────────────────────────

// Directories never descended into during project scanning.
const PRUNE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".nx",
  "tmp", ".cache", "coverage", ".turbo",
]);

// Patterns matched against the FULL forward-slash relative path (lowercase).
// Word-boundary (\b) ensures "api" matches "apps/api/" but not "capability/".
// Order matters — first match wins.
const SURFACE_PATTERNS = [
  { key: "backend",      re: /\b(api|backend|server|serverless)\b/ },
  { key: "distributed",  re: /\b(worker|queue|job|processor|consumer|producer)\b/ },
  { key: "sharedSchema", re: /\b(schema|zod|validation|models?)\b/ },
  { key: "sharedTypes",  re: /\b(types?|entit(y|ies)|interfaces?|domain)\b/ },
  { key: "sharedUi",     re: /\bui\b|\b(components?|design[-_]system)\b/ },
  { key: "frontend",     re: /\b(web|frontend|client|shop|store|dashboard|portal)\b/ },
];

// A directory is treated as a project root if it has src/, project.json, or an index file.
async function isProjectRoot(absPath) {
  return (
    (await fs.pathExists(path.join(absPath, "project.json"))) ||
    (await fs.pathExists(path.join(absPath, "src"))) ||
    (await fs.pathExists(path.join(absPath, "index.ts"))) ||
    (await fs.pathExists(path.join(absPath, "index.js")))
  );
}

// Walk the whole project tree; when a project root is found, classify it and stop descending.
async function detectSurfaces(cwd) {
  if (!(await fs.pathExists(path.join(cwd, "nx.json")))) return null;

  const surfaces = {
    backend: [], frontend: [], distributed: [],
    sharedSchema: [], sharedTypes: [], sharedUi: [],
  };

  async function walk(absDir, rel) {
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || PRUNE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const childAbs = path.join(absDir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (await isProjectRoot(childAbs)) {
        const p = childRel + "/";
        const slug = p.toLowerCase();
        if (/\be2e\b/.test(slug)) continue; // skip e2e companion projects
        for (const { key, re } of SURFACE_PATTERNS) {
          if (re.test(slug)) { surfaces[key].push(p); break; }
        }
        // unmatched paths are left unassigned — user fills them in the prompt
      } else {
        await walk(childAbs, childRel);
      }
    }
  }

  await walk(cwd, "");
  return surfaces;
}

// Prompts user to confirm or override each surface. Returns confirmed surface map.
async function confirmSurfaces(detected, rl) {
  const isNx = detected !== null;
  const d = detected ?? {};

  function fmt(paths) {
    return paths && paths.length ? paths.join(", ") : "";
  }

  async function ask(label, defaults) {
    const hint = fmt(defaults);
    const display = hint ? chalk.dim(`[${hint}]`) : chalk.dim("[none detected — enter path or leave blank to skip]");
    const raw = await rl.question(`  ${label} ${display}: `);
    if (!raw.trim()) return defaults ?? [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (!isNx) {
    console.log(chalk.yellow("\n  No nx.json found — this doesn't look like an Nx workspace."));
    console.log("  Enter your project surface paths manually, or press Enter to skip.\n");
  } else {
    console.log("\n  Nx workspace detected. Confirm surface paths (Enter = keep detected value).\n");
  }

  return {
    backend:      await ask("Backend / serverless paths ", d.backend      ?? []),
    frontend:     await ask("Frontend paths             ", d.frontend     ?? []),
    distributed:  await ask("Worker / queue paths       ", d.distributed  ?? []),
    sharedSchema: await ask("Shared schema lib paths    ", d.sharedSchema ?? []),
    sharedTypes:  await ask("Shared types lib paths     ", d.sharedTypes  ?? []),
    sharedUi:     await ask("Shared UI lib paths        ", d.sharedUi     ?? []),
  };
}

// Replaces <!-- cortex:KEY --> ... <!-- /cortex:KEY --> blocks in every .md under agentsDir.
// Uses indexOf to avoid regex escaping issues with multiline content.
async function patchAgentScopes(agentsDir, surfaces) {
  // Derive Nx project names from app-level frontend paths (e.g. "apps/shop/" → "shop").
  // Lib paths are excluded — check commands target runnable apps, not libs.
  const frontendAppNames = surfaces.frontend
    .filter((p) => !p.startsWith("libs/"))
    .map((p) => p.replace(/\/$/, "").split("/").pop())
    .filter(Boolean);

  const frontendChecks =
    frontendAppNames.length === 0
      ? "  - *(no frontend apps configured — run `cortex-harness config` to set)*"
      : frontendAppNames
          .flatMap((name) => [
            `  - \`cmd /c npm exec nx run ${name}:lint\``,
            `  - \`cmd /c npm exec nx run ${name}:test\``,
            `  - \`cmd /c npm exec nx run ${name}:build\``,
          ])
          .join("\n");

  const tagMap = {
    "cortex:backend":         surfaces.backend,
    "cortex:frontend":        surfaces.frontend,
    "cortex:distributed":     surfaces.distributed,
    "cortex:shared-schema":   surfaces.sharedSchema,
    "cortex:shared-types":    surfaces.sharedTypes,
    "cortex:shared-ui":       surfaces.sharedUi,
    "cortex:frontend-checks": { _raw: frontendChecks },
  };

  const mdFiles = (await getAllFiles(agentsDir)).filter((f) => f.endsWith(".md"));
  for (const file of mdFiles) {
    let content = await fs.readFile(file, "utf8");
    let changed = false;

    for (const [tag, value] of Object.entries(tagMap)) {
      const open  = `<!-- ${tag} -->`;
      const close = `<!-- /${tag} -->`;
      // value is either a paths array or a { _raw } object for pre-formatted content
      const list = value?._raw !== undefined
        ? value._raw
        : value.length === 0
          ? "- *(none configured — run `cortex-harness config` to set)*"
          : value.map((p) => `- \`${p}\``).join("\n");
      const replacement = `${open}\n${list}\n${close}`;

      let out = "";
      let cursor = 0;
      let found = false;
      while (true) {
        const openIdx  = content.indexOf(open,  cursor);
        if (openIdx === -1) break;
        const closeIdx = content.indexOf(close, openIdx + open.length);
        if (closeIdx === -1) break;
        out    += content.slice(cursor, openIdx) + replacement;
        cursor  = closeIdx + close.length;
        found   = true;
      }
      if (found) { content = out + content.slice(cursor); changed = true; }
    }

    if (changed) await fs.writeFile(file, content, "utf8");
  }
}

// Writes confirmed surface paths into harness.config.json and patches agent md files.
async function applySurfaces(configPath, surfaces, agentsDir) {
  const config = await fs.readJson(configPath);

  config.agents["backend-subagent"].scope = [
    ...surfaces.backend,
    ...surfaces.sharedSchema,
    ...surfaces.sharedTypes,
  ].filter(Boolean);

  config.agents["frontend-subagent"].scope = [
    ...surfaces.frontend,
    ...surfaces.sharedUi,
  ].filter(Boolean);

  config.agents["distributed-subagent"].scope = [
    ...surfaces.distributed,
  ].filter(Boolean);

  await fs.writeJson(configPath, config, { spaces: 2 });

  if (agentsDir && (await fs.pathExists(agentsDir))) {
    await patchAgentScopes(agentsDir, surfaces);
  }
}

// ─── init command ────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize the harness and lifecycle hooks in the current project")
  .action(async () => {
    const targetHarnessDir = path.join(process.cwd(), ".harness");
    const targetClaudeDir = path.join(process.cwd(), ".claude");
    const templatesDir = path.join(pkgRoot, "templates");

    const rl = createInterface({ input, output });

    console.log("\nInitializing cortex-harness...\n");

    // 1. Prompts
    console.log(".harness/prompts/");
    await copyDir(
      path.join(templatesDir, "prompts"),
      path.join(targetHarnessDir, "prompts"),
      rl, ".harness/prompts"
    );

    // 2. Agents
    console.log("\n.harness/agents/");
    await copyDir(
      path.join(templatesDir, "agents"),
      path.join(targetHarnessDir, "agents"),
      rl, ".harness/agents"
    );

    // 3. Memory
    if (await fs.pathExists(path.join(templatesDir, "memory"))) {
      console.log("\n.harness/memory/");
      await copyDir(
        path.join(templatesDir, "memory"),
        path.join(targetHarnessDir, "memory"),
        rl, ".harness/memory"
      );
    }

    // 4. Scripts
    if (await fs.pathExists(path.join(templatesDir, "scripts"))) {
      console.log("\n.harness/scripts/");
      await fs.ensureDir(path.join(targetHarnessDir, "scripts"));
      await copyDir(
        path.join(templatesDir, "scripts"),
        path.join(targetHarnessDir, "scripts"),
        rl, ".harness/scripts"
      );
    }

    // 5. .claude/settings.json — always merge hooks, never prompt (additive only)
    console.log("\n.claude/");
    await fs.ensureDir(targetClaudeDir);
    const settingsPath = path.join(targetClaudeDir, "settings.json");
    const settingsTemplatePath = path.join(templatesDir, ".claude", "settings.json");
    if (await fs.pathExists(settingsTemplatePath)) {
      const templateSettings = await fs.readJson(settingsTemplatePath);
      if (await fs.pathExists(settingsPath)) {
        const existing = await fs.readJson(settingsPath);
        existing.hooks = { ...existing.hooks, ...templateSettings.hooks };
        await fs.writeJson(settingsPath, existing, { spaces: 2 });
        console.log("  ↑ .claude/settings.json (merged harness hooks)");
      } else {
        await fs.writeJson(settingsPath, templateSettings, { spaces: 2 });
        console.log("  + .claude/settings.json");
      }
    }

    // 6. harness.config.json
    console.log();
    const configPath = path.join(process.cwd(), "harness.config.json");
    const configTemplatePath = path.join(templatesDir, "harness.config.json");
    if (await fs.pathExists(configTemplatePath)) {
      const status = await copyFile(configTemplatePath, configPath, "harness.config.json", rl);
      const icon = status === "kept" ? "–" : status === "updated" ? "↑" : "+";
      console.log(`  ${icon} harness.config.json`);
    }

    // 7. CLAUDE.md
    const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
    const claudeMdTemplatePath = path.join(templatesDir, "CLAUDE.md");
    if (await fs.pathExists(claudeMdTemplatePath)) {
      const status = await copyFile(claudeMdTemplatePath, claudeMdPath, "CLAUDE.md", rl);
      const icon = status === "kept" ? "–" : status === "updated" ? "↑" : "+";
      console.log(`  ${icon} CLAUDE.md`);
    }

    // 8. Surface configuration
    console.log("\n" + chalk.bold("Configuring agent surface scopes..."));
    const detected = await detectSurfaces(process.cwd());
    const surfaces = await confirmSurfaces(detected, rl);

    if (await fs.pathExists(configPath)) {
      await applySurfaces(configPath, surfaces, path.join(targetHarnessDir, "agents"));
      console.log(chalk.green("\n  ✓ harness.config.json updated with your surface paths"));
      console.log(chalk.green("  ✓ .harness/agents/*.agent.md scope sections updated"));
    }

    const allEmpty = Object.values(surfaces).every((v) => v.length === 0);
    if (allEmpty) {
      console.log(chalk.yellow("  ! No surfaces configured — edit harness.config.json manually before running"));
    } else {
      const missing = Object.entries(surfaces)
        .flatMap(([, paths]) => paths)
        .filter((p) => !fs.pathExistsSync(path.join(process.cwd(), p)));
      if (missing.length) {
        console.log(chalk.yellow(`\n  ! These paths don't exist yet and will need to be created:`));
        missing.forEach((p) => console.log(chalk.yellow(`      ${p}`)));
      }
    }

    rl.close();

    console.log("\n" + chalk.green("Harness initialized successfully."));
    console.log("\nNext steps:");
    console.log("  1. Review harness.config.json — scope paths are set to your surfaces");
    console.log("  2. Update .harness/agents/*.agent.md Scope sections to match those paths");
    console.log("  3. Run: cortex-harness run \"your task description\"");
  });

// ─── config helpers ──────────────────────────────────────────────────────────

async function loadHarnessConfig(cwd) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    console.error(chalk.red('  harness.config.json not found. Run "cortex-harness init" first.'));
    process.exit(1);
  }
  return { config: await fs.readJson(configPath), configPath };
}

async function saveHarnessConfig(configPath, config) {
  await fs.writeJson(configPath, config, { spaces: 2 });
}

// Derive surface buckets from live harness.config.json for md patching.
function surfacesFromConfig(config) {
  const get = (agent) => config.agents?.[agent]?.scope ?? [];
  const backendScope = get("backend-subagent");
  const frontendScope = get("frontend-subagent");
  const distScope = get("distributed-subagent");

  // shared libs appear in both backend and frontend scopes; collect unique shared paths
  const allShared = [...new Set([...backendScope, ...frontendScope])].filter(
    (p) => p.startsWith("libs/")
  );
  const sharedSchema = allShared.filter((p) => /\b(schema|zod|validation|models?)\b/.test(p));
  const sharedTypes  = allShared.filter((p) => /\b(types?|entit(y|ies)|interfaces?|domain)\b/.test(p));
  const sharedUi     = allShared.filter((p) => /\bui\b|\b(components?|design[-_]system)\b/.test(p));

  return {
    backend:      backendScope.filter((p) => !p.startsWith("libs/")),
    frontend:     frontendScope.filter((p) => !p.startsWith("libs/")),
    distributed:  distScope,
    sharedSchema,
    sharedTypes,
    sharedUi,
  };
}

// Re-patch agent md files from live config (called after any config mutation).
async function repatchFromConfig(cwd, config) {
  const agentsDir = path.join(cwd, config.harnessDir ?? ".harness", "agents");
  if (!(await fs.pathExists(agentsDir))) return;
  await patchAgentScopes(agentsDir, surfacesFromConfig(config));
}

function printScopeTable(config) {
  const agents = config.agents || {};
  const nameWidth = Math.max(...Object.keys(agents).map((k) => k.length), 6);
  console.log();
  console.log(chalk.bold("  Agent scope configuration"));
  console.log("  " + "─".repeat(nameWidth + 4 + 40));
  for (const [agent, cfg] of Object.entries(agents)) {
    const scope = cfg?.scope;
    const scopeStr =
      !scope || scope.length === 0
        ? chalk.dim("(none)")
        : scope.join(", ");
    console.log(`  ${chalk.cyan(agent.padEnd(nameWidth))}  ${scopeStr}`);
  }
  console.log("  " + "─".repeat(nameWidth + 4 + 40));
  console.log();
}

// ─── config command ───────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("View and edit harness.config.json without touching JSON manually");

// bare `cortex-harness config` → interactive wizard
configCmd.action(async () => {
  const { config, configPath } = await loadHarnessConfig(process.cwd());
  const rl = createInterface({ input, output });

  printScopeTable(config);

  const agents = Object.keys(config.agents || {});
  const editable = agents.filter(
    (a) => !["explorer-subagent", "planner-subagent", "tester-subagent"].includes(a)
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
      console.log(chalk.yellow(`  Enter a number between 0 and ${editable.length}`));
      continue;
    }
    const agent = editable[idx - 1];
    const current = (config.agents[agent]?.scope || []).join(", ");
    const raw = await rl.question(
      `  ${chalk.cyan(agent)} scope ${chalk.dim(`[${current || "none"}]`)}: `
    );
    if (raw.trim()) {
      config.agents[agent].scope = raw.split(",").map((s) => s.trim()).filter(Boolean);
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
    console.log(chalk.green("\n  harness.config.json saved."));
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
      console.log(chalk.yellow(`  "${scopePath}" is already in ${agent}'s scope — no change.`));
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
      (s) => s !== scopePath && s !== scopePath + "/" && s !== scopePath.replace(/\/$/, "")
    );
    if (after.length === before.length) {
      console.log(chalk.yellow(`  "${scopePath}" not found in ${agent}'s scope.`));
      console.log("  Current scope:", before.join(", ") || "(none)");
      process.exit(0);
    }
    config.agents[agent].scope = after;
    await saveHarnessConfig(configPath, config);
    await repatchFromConfig(process.cwd(), config);
    console.log(chalk.green(`  ✓ Removed "${scopePath}" from ${agent}`));
    printScopeTable(config);
  });

// ─── run command ─────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Run the autonomous loop with a task description")
  .argument("[task]", "The task for the agent to perform")
  .action((task) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const args = [enginePath];
    if (task) args.push(task);

    const proc = spawn("node", args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    proc.on("exit", (code) => process.exit(code ?? 0));
  });

// ─── resume command ───────────────────────────────────────────────────────────

program
  .command("resume")
  .description("Resume a blocked run, optionally providing a human answer")
  .argument("[answer]", "Answer to provide to the blocked cycle")
  .action((answer) => {
    const resumePath = path.join(pkgRoot, "src", "resume-autonomous.mjs");
    const args = [resumePath];
    if (answer) args.push(answer);

    const proc = spawn("node", args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    proc.on("exit", (code) => process.exit(code ?? 0));
  });

program.parse();
