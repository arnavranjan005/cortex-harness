#!/usr/bin/env node
import { Command, Option } from "commander";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";

import { createRequire } from "module";
const _require = createRequire(import.meta.url);

import {
  createEmptyNotificationConfig,
  getDiscordRegistrations,
  NOTIFICATION_CONFIG_FILE,
  readNotificationConfig,
  redactWebhook,
  validateDiscordWebhookUrl,
  writeNotificationConfig,
} from "../src/notification-config.mjs";
import { sendWindowsNotification } from "../src/notifications/notification-windows.mjs";
import { sendDiscordNotification } from "../src/notifications/notify-discord.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.join(__dirname, "..");

const { version: pkgVersion } = _require("../package.json");

const program = new Command();

program
  .name("cortex-harness")
  .description("CLI to scaffold and run an autonomous agent harness")
  .version(pkgVersion);

// ─── helpers ────────────────────────────────────────────────────────────────

const GITIGNORE_BLOCK_START = "# cortex-harness";
const GITIGNORE_BLOCK_END = "# /cortex-harness";
const GITIGNORE_RUNTIME_ENTRIES = [
  ".harness/runs/",
  ".harness/cycle-state/",
  ".harness/output/",
  ".harness/session.json",
  ".harness/notification-channels.local.json",
];

async function patchGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const block =
    `${GITIGNORE_BLOCK_START}\n` +
    GITIGNORE_RUNTIME_ENTRIES.join("\n") +
    `\n${GITIGNORE_BLOCK_END}`;

  if (await fs.pathExists(gitignorePath)) {
    const existing = await fs.readFile(gitignorePath, "utf8");
    if (existing.includes(GITIGNORE_BLOCK_START)) {
      return "present";
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await fs.appendFile(gitignorePath, `${separator}${block}\n`);
    return "appended";
  } else {
    await fs.writeFile(gitignorePath, `${block}\n`);
    return "created";
  }
}

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

function fileIcon(status) {
  if (status === "created") return chalk.green("+");
  if (status === "updated") return chalk.yellow("↑");
  return chalk.dim("–");
}

// Copy a single file, prompting keep/update if it already exists.
// Returns "created" | "updated" | "kept"
async function copyFile(src, dest, rel, rl) {
  const exists = await fs.pathExists(dest);
  if (exists) {
    const answer = await rl.question(
      `  ${chalk.yellow("?")} ${chalk.dim(rel)} already exists — update? ${chalk.dim("[y/N]")}: `
    );
    if (!answer.toLowerCase().startsWith("y")) {
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
    console.log(`  ${fileIcon(status)} ${chalk.dim(rel)}`);
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
    backend:      await ask("Backend / serverless paths", d.backend      ?? []),
    frontend:     await ask("Frontend paths            ", d.frontend     ?? []),
    distributed:  await ask("Worker / queue paths      ", d.distributed  ?? []),
    sharedSchema: await ask("Shared schema lib paths   ", d.sharedSchema ?? []),
    sharedTypes:  await ask("Shared types lib paths    ", d.sharedTypes  ?? []),
    sharedUi:     await ask("Shared UI lib paths       ", d.sharedUi     ?? []),
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

    const W = Math.min(process.stdout.columns || 72, 72);
    const line = chalk.dim("─".repeat(W));

    console.log();
    console.log(chalk.bold.cyan("  cortex-harness") + chalk.dim(` v${pkgVersion}  —  init`));
    console.log(line);

    function section(label) {
      console.log("\n" + chalk.bold(`  ${label}`));
    }

    // 1. Prompts
    section("Scaffolding prompts");
    await copyDir(
      path.join(templatesDir, "prompts"),
      path.join(targetHarnessDir, "prompts"),
      rl, ".harness/prompts"
    );

    // 2. Agents
    section("Scaffolding agents");
    await copyDir(
      path.join(templatesDir, "agents"),
      path.join(targetHarnessDir, "agents"),
      rl, ".harness/agents"
    );

    // 3. Memory
    if (await fs.pathExists(path.join(templatesDir, "memory"))) {
      section("Scaffolding memory");
      await copyDir(
        path.join(templatesDir, "memory"),
        path.join(targetHarnessDir, "memory"),
        rl, ".harness/memory"
      );
    }

    // 4. Scripts
    if (await fs.pathExists(path.join(templatesDir, "scripts"))) {
      section("Scaffolding scripts");
      await fs.ensureDir(path.join(targetHarnessDir, "scripts"));
      await copyDir(
        path.join(templatesDir, "scripts"),
        path.join(targetHarnessDir, "scripts"),
        rl, ".harness/scripts"
      );
    }

    // 5. .claude/settings.json — always merge hooks, never prompt (additive only)
    section("Wiring Claude hooks");
    await fs.ensureDir(targetClaudeDir);
    const settingsPath = path.join(targetClaudeDir, "settings.json");
    const settingsTemplatePath = path.join(templatesDir, ".claude", "settings.json");
    if (await fs.pathExists(settingsTemplatePath)) {
      const templateSettings = await fs.readJson(settingsTemplatePath);
      if (await fs.pathExists(settingsPath)) {
        const existing = await fs.readJson(settingsPath);
        existing.hooks = { ...existing.hooks, ...templateSettings.hooks };
        await fs.writeJson(settingsPath, existing, { spaces: 2 });
        console.log(`  ${chalk.yellow("↑")} ${chalk.dim(".claude/settings.json")}  ${chalk.dim("(merged harness hooks)")}`);
      } else {
        await fs.writeJson(settingsPath, templateSettings, { spaces: 2 });
        console.log(`  ${chalk.green("+")} ${chalk.dim(".claude/settings.json")}`);
      }
    }

    // 6. harness.config.json + CLAUDE.md — root config files
    section("Writing root config files");
    const configPath = path.join(process.cwd(), "harness.config.json");
    const configTemplatePath = path.join(templatesDir, "harness.config.json");
    if (await fs.pathExists(configTemplatePath)) {
      const status = await copyFile(configTemplatePath, configPath, "harness.config.json", rl);
      console.log(`  ${fileIcon(status)} ${chalk.dim("harness.config.json")}`);
    }

    const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
    const claudeMdTemplatePath = path.join(templatesDir, "CLAUDE.md");
    if (await fs.pathExists(claudeMdTemplatePath)) {
      const status = await copyFile(claudeMdTemplatePath, claudeMdPath, "CLAUDE.md", rl);
      console.log(`  ${fileIcon(status)} ${chalk.dim("CLAUDE.md")}`);
    }

    // 7. .gitignore
    {
      const result = await patchGitignore(process.cwd());
      const note = result === "present" ? chalk.dim("  (already present)") : "";
      console.log(`  ${fileIcon(result === "present" ? "kept" : result === "appended" ? "updated" : "created")} ${chalk.dim(".gitignore")}${note}`);
    }

    // 8. Surface configuration
    console.log("\n" + line);
    console.log(chalk.bold("  Surface configuration"));
    console.log(line);
    const detected = await detectSurfaces(process.cwd());
    const surfaces = await confirmSurfaces(detected, rl);

    if (await fs.pathExists(configPath)) {
      await applySurfaces(configPath, surfaces, path.join(targetHarnessDir, "agents"));
      console.log(`\n  ${chalk.green("✓")} harness.config.json updated`);
      console.log(`  ${chalk.green("✓")} .harness/agents/*.agent.md scope sections patched`);
    }

    const allEmpty = Object.values(surfaces).every((v) => v.length === 0);
    if (allEmpty) {
      console.log(`\n  ${chalk.yellow("!")} No surfaces configured — edit harness.config.json before running`);
    } else {
      const missing = Object.entries(surfaces)
        .flatMap(([, paths]) => paths)
        .filter((p) => !fs.pathExistsSync(path.join(process.cwd(), p)));
      if (missing.length) {
        console.log(`\n  ${chalk.yellow("!")} These paths don't exist yet:`);
        missing.forEach((p) => console.log(`      ${chalk.yellow(p)}`));
      }
    }

    rl.close();

    // Success footer
    console.log("\n" + line);
    console.log(chalk.green.bold("  ✓ Harness initialized successfully"));
    console.log(line);
    console.log(chalk.bold("\n  Next steps\n"));
    console.log(`  ${chalk.dim("1.")} Review ${chalk.cyan("harness.config.json")} — scope paths are set to your surfaces`);
    console.log(`  ${chalk.dim("2.")} Review ${chalk.cyan(".harness/agents/*.agent.md")} — Scope sections have been auto-patched`);
    console.log(`  ${chalk.dim("3.")} Run: ${chalk.cyan('cortex-harness run "your task description"')}`);
    console.log();
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
    await repatchFromConfig(process.cwd(), config);
    console.log(chalk.green("\n  harness.config.json saved and agent .md scope sections updated."));
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

// ─── gitignore command ────────────────────────────────────────────────────────

program
  .command("gitignore")
  .description("Append harness runtime entries to .gitignore (safe to run on existing projects)")
  .action(async () => {
    const result = await patchGitignore(process.cwd());
    if (result === "present") {
      console.log(chalk.dim("  – .gitignore already contains harness entries — nothing to do."));
    } else if (result === "appended") {
      console.log(chalk.green("  ✓ Appended harness runtime entries to .gitignore"));
      console.log(chalk.dim("\n  Entries added:"));
      GITIGNORE_RUNTIME_ENTRIES.forEach((e) => console.log(chalk.dim(`    ${e}`)));
    } else {
      console.log(chalk.green("  ✓ Created .gitignore with harness runtime entries"));
      console.log(chalk.dim("\n  Entries added:"));
      GITIGNORE_RUNTIME_ENTRIES.forEach((e) => console.log(chalk.dim(`    ${e}`)));
    }
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

// ─── status command ───────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show the current run status — blocked questions, pending cycles, progress")
  .action(async () => {
    const queuePath = path.join(process.cwd(), ".harness", "task-queue.json");
    if (!(await fs.pathExists(queuePath))) {
      console.log(chalk.dim("  No active run found (task-queue.json missing)."));
      console.log(chalk.dim("  Start one with: cortex-harness run \"your task\""));
      return;
    }

    let queue;
    try {
      queue = await fs.readJson(queuePath);
    } catch {
      console.log(chalk.red("  task-queue.json exists but could not be parsed."));
      return;
    }

    // Build a map of cycleId → full finalMessage from the most recent run log.
    // Used to recover full question text when blockedReason was saved with the
    // old 300-char truncation.
    const fullMessages = {};
    const runsDir = path.join(process.cwd(), ".harness", "runs");
    if (await fs.pathExists(runsDir)) {
      const logs = (await fs.readdir(runsDir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse(); // most recent first
      if (logs.length) {
        try {
          const lines = (await fs.readFile(path.join(runsDir, logs[0]), "utf8"))
            .split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === "cycle-result" && ev.cycleId && ev.finalMessage) {
                // Keep only the last result per cycleId (latest attempt)
                fullMessages[ev.cycleId] = ev.finalMessage;
              }
            } catch { /* skip malformed lines */ }
          }
        } catch { /* log unreadable — skip */ }
      }
    }

    // Return the best available question text for a blocked cycle.
    // Priority: run-log finalMessage > stored blockedReason + cycle output file gaps.
    function getQuestionText(c) {
      const stored = c.blockedReason ?? "";

      // 1. Run log — use NEEDS_HUMAN_INPUT-extracted text if present and non-empty
      if (fullMessages[c.id]) {
        const full = fullMessages[c.id];
        const nhiIdx = full.indexOf("NEEDS_HUMAN_INPUT");
        const extracted = nhiIdx !== -1
          ? full.slice(nhiIdx + "NEEDS_HUMAN_INPUT".length).replace(/^[:\s–-]+/, "").trim()
          : "";
        if (extracted) return extracted;
        // extraction was empty (keyword absent) — fall through to augment with cycle state
      }

      // 2. Append outOfScopeGaps from cycle output file only when stored text looks truncated
      // (legacy runs had a 300-char hard cap; skip gaps if stored is clearly full text)
      const TRUNCATION_THRESHOLD = 350;
      if (c.outputFile && stored.length < TRUNCATION_THRESHOLD) {
        try {
          const cycleStatePath = path.join(process.cwd(), ".harness", "cycle-state", c.outputFile);
          const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
          const gaps = data.outOfScopeGaps ?? [];
          if (gaps.length) {
            const lines = gaps.map((g) => {
              if (typeof g === "string") return `• ${g}`;
              const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
              if (g.reason) parts.push(`  ${g.reason}`);
              if (g.proposedModel) parts.push(`  Proposed model: ${g.proposedModel}`);
              return parts.join("\n");
            });
            const suffix = "\n\nBlocking gaps:\n" + lines.join("\n\n");
            return stored ? stored + suffix : suffix.trim();
          }
        } catch { /* output file missing or unparseable — fall through */ }
      }

      return stored;
    }

    // Word-wrap a string to fit within `width` columns, indented by `indent` spaces.
    const TERM_WIDTH = Math.min(process.stdout.columns || 80, 100);
    function wrap(text, indent = 2) {
      const prefix = " ".repeat(indent);
      const maxLen = TERM_WIDTH - indent;
      const words = String(text ?? "").split(" ");
      const lines = [];
      let current = "";
      for (const word of words) {
        if (!current) { current = word; continue; }
        if (current.length + 1 + word.length <= maxLen) {
          current += " " + word;
        } else {
          lines.push(prefix + current);
          current = word;
        }
      }
      if (current) lines.push(prefix + current);
      return lines.join("\n");
    }

    // Print a multi-line block, respecting existing newlines and wrapping long lines.
    function printWrapped(text, indent = 2) {
      for (const para of String(text ?? "").split("\n")) {
        if (para.trim() === "") { console.log(); continue; }
        console.log(wrap(para, indent));
      }
    }

    const cycles = queue.cycles ?? [];
    const done     = cycles.filter((c) => c.status === "done");
    const pending  = cycles.filter((c) => c.status === "pending");
    const partial  = cycles.filter((c) => c.status === "partial");
    const blocked  = cycles.filter((c) => c.status === "blocked");
    const needsInput = blocked.filter((c) => c.blockedType === "needs-human-input");
    const limitHit   = blocked.filter((c) => c.blockedType === "session-limit");

    const taskDisplay = (queue.task ?? "(unknown)").length > 100
      ? (queue.task ?? "").slice(0, 100) + "…"
      : (queue.task ?? "(unknown)");

    console.log(`\n${chalk.bold.blue("━━━ Harness Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
    console.log(`${chalk.dim("Task   :")} ${taskDisplay}`);
    console.log(`${chalk.dim("Type   :")} ${queue.promptType ?? "(unknown)"}`);
    console.log(
      `${chalk.dim("Queue  :")} ${chalk.green(done.length + " done")}  ` +
      `${chalk.yellow(pending.length + " pending")}  ` +
      `${chalk.yellow(partial.length + " partial")}  ` +
      `${chalk.red(blocked.length + " blocked")}`
    );

    // ── Blocked: needs human input ──────────────────────────────────────────
    if (needsInput.length) {
      console.log(`\n${chalk.red.bold("  Waiting for your input:")}`);
      for (const c of needsInput) {
        console.log(`\n  ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)}`);
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
        const questionText = getQuestionText(c);
        if (questionText) {
          printWrapped(questionText, 2);
        } else {
          console.log(chalk.dim("  (no question text recorded)"));
        }
        console.log(chalk.dim("  ─────────────────────────────────────────────"));
      }
      console.log(chalk.yellow(`\n  Answer: cortex-harness resume`));
    }

    // ── Blocked: session/weekly limit ───────────────────────────────────────
    if (limitHit.length) {
      console.log(`\n${chalk.red("  Usage limit hit:")}`);
      for (const c of limitHit) {
        const reason = c.blockedReason ?? "unknown — check your Claude plan";
        console.log(`  ${chalk.cyan(c.id)}`);
        console.log(wrap(reason, 4));
      }
      console.log(chalk.dim("\n  Resume after the limit resets: cortex-harness resume"));
    }

    // ── Partial ─────────────────────────────────────────────────────────────
    if (partial.length) {
      console.log(`\n${chalk.yellow("  Partial cycles (incomplete):")}`);
      for (const c of partial) {
        console.log(`  ${chalk.cyan(c.id)}`);
        if (c.partialReason) console.log(wrap(c.partialReason, 4));
      }
    }

    // ── Pending ─────────────────────────────────────────────────────────────
    if (pending.length) {
      console.log(`\n${chalk.dim("  Pending:")}`);
      for (const c of pending) {
        const group = c.taskGroup ? chalk.dim(` [${c.taskGroup}]`) : "";
        console.log(`  ${chalk.dim("·")} ${chalk.cyan(c.id)}${group}`);
      }
    }

    if (!blocked.length && !pending.length && !partial.length) {
      console.log(chalk.green("\n  All cycles complete. Run is finished."));
    }

    console.log();
  });

// ─── resume command ───────────────────────────────────────────────────────────

program
  .command("resume")
  .description("Resume a blocked run — walks through each blocked cycle interactively")
  .action(async () => {
    // Ctrl+C during prompts — exit cleanly without saving partial state
    let cancelled = false;
    process.once("SIGINT", () => {
      cancelled = true;
      console.log(chalk.yellow("\n\n  Cancelled — no changes saved. Cycles remain blocked."));
      process.exit(0);
    });

    const queueFile = path.join(process.cwd(), ".harness", "task-queue.json");
    if (!fs.existsSync(queueFile)) {
      console.error(chalk.red("[ERROR] No task-queue.json found. Nothing to resume."));
      process.exit(1);
    }

    let queue;
    try {
      queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    } catch (err) {
      console.error(chalk.red("[ERROR] Failed to parse task-queue.json:", err.message));
      process.exit(1);
    }

    const blocked = (queue.cycles ?? []).filter((c) => c.status === "blocked");
    const needsInput = blocked.filter((c) => c.blockedType === "needs-human-input");
    const sessionLimit = blocked.filter((c) => c.blockedType === "session-limit");

    if (!blocked.length) {
      console.log(chalk.dim("[INFO] No blocked cycles found. Starting run..."));
    } else if (!needsInput.length) {
      if (sessionLimit.length) {
        console.log(chalk.yellow(`[RESUME] ${sessionLimit.length} session-limit cycle(s) will retry — no answer needed.`));
      }
    } else {
      // Interactive per-cycle question flow
      const TERM_WIDTH = Math.min(process.stdout.columns || 80, 100);
      const SEP = chalk.dim("─".repeat(TERM_WIDTH - 2));

      console.log("\n" + chalk.bold.cyan(`  ${needsInput.length} cycle${needsInput.length > 1 ? "s" : ""} waiting for your input\n`));

      const cycleAnswerDir = path.join(process.cwd(), ".harness", "cycle-state");
      const answersFile = path.join(cycleAnswerDir, "human-answers.json");

      const decisions = [];

      for (let i = 0; i < needsInput.length; i++) {
        const c = needsInput[i];
        console.log(SEP);
        console.log(`\n  ${chalk.bold(`[${i + 1}/${needsInput.length}]`)} ${chalk.cyan(c.id)}  ${chalk.dim(`(${c.type})`)}\n`);

        let questionText = c.blockedReason ?? "";
        if (questionText.length < 350 && c.outputFile) {
          try {
            const cycleStatePath = path.join(process.cwd(), ".harness", "cycle-state", c.outputFile);
            const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
            const gaps = (data.outOfScopeGaps ?? []);
            if (gaps.length) {
              const gapLines = gaps.map((g) => {
                if (typeof g === "string") return `• ${g}`;
                const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
                if (g.reason) parts.push(`  ${g.reason}`);
                if (g.proposedModel) parts.push(`  Proposed:\n${g.proposedModel.split("\n").map((l) => "    " + l).join("\n")}`);
                return parts.join("\n");
              });
              const suffix = "\n\nBlocking gaps:\n" + gapLines.join("\n\n");
              questionText = questionText ? questionText + suffix : suffix.trim();
            }
          } catch { /* missing output file — use blockedReason as-is */ }
        }

        if (questionText) {
          for (const line of questionText.split("\n")) {
            if (line.trim() === "") { console.log(); continue; }
            const indent = "  ";
            const maxLen = TERM_WIDTH - indent.length;
            const words = line.split(" ");
            let current = "";
            for (const word of words) {
              if (!current) { current = word; continue; }
              if (current.length + 1 + word.length <= maxLen) current += " " + word;
              else { console.log(indent + current); current = word; }
            }
            if (current) console.log(indent + current);
          }
        } else {
          console.log(chalk.dim("  (no question text recorded)"));
        }

        console.log();
        const rl = createInterface({ input, output });
        let userAnswer = "";
        try {
          userAnswer = (await rl.question(chalk.bold("  Your answer: "))).trim();
        } finally {
          rl.close();
        }
        console.log();

        decisions.push({ cycleId: c.id, questions: questionText ? [{ text: questionText }] : [], answer: userAnswer });
      }

      // All cycles answered — write answers and update queue together before anything else
      fs.mkdirSync(cycleAnswerDir, { recursive: true });
      const existing = fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, "utf8")) : [];
      existing.push({
        answeredAt: new Date().toISOString(),
        resolvedCycles: needsInput.map((c) => c.id),
        decisions,
      });

      // Mark blocked as pending in-memory first, then write both files
      for (const c of blocked) {
        c.status = "pending";
        delete c.blockedType;
        delete c.blockedReason;
        delete c.blockedAt;
      }
      fs.writeFileSync(answersFile, JSON.stringify(existing, null, 2), "utf8");
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

      console.log(chalk.green(`  Answers saved for ${needsInput.length} cycle(s).`));
      console.log(chalk.dim(`  Marked ${blocked.length} cycle(s) for retry.`));

      if (sessionLimit.length) {
        console.log(chalk.yellow(`\n  ${sessionLimit.length} session-limit cycle(s) will also retry — no answer needed.`));
      }

      // Ask whether to start the run
      console.log();
      const rlRun = createInterface({ input, output });
      let startRun = "y";
      try {
        startRun = (await rlRun.question(chalk.bold("  Start run now? [Y/n]: "))).trim().toLowerCase() || "y";
      } finally {
        rlRun.close();
      }
      if (startRun === "n" || startRun === "no") {
        console.log(chalk.dim("\n  Run skipped. Start manually with: cortex-harness run"));
        return;
      }
      console.log();

      const runPath = path.join(pkgRoot, "src", "run-autonomous.mjs");
      const proc = spawn("node", [runPath], { stdio: "inherit", cwd: process.cwd() });
      proc.on("exit", (code) => process.exit(code ?? 0));
      return;
    }

    // Session-limit / no-blocked path — mark pending and auto-start
    for (const c of blocked) {
      c.status = "pending";
      delete c.blockedType;
      delete c.blockedReason;
      delete c.blockedAt;
    }
    if (blocked.length) {
      fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");
      console.log(chalk.dim(`\n  Marked ${blocked.length} cycle(s) for retry.`));
    }

    const runPath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [runPath], { stdio: "inherit", cwd: process.cwd() });
    proc.on("exit", (code) => process.exit(code ?? 0));
  });


// ─── logs command ─────────────────────────────────────────────────────────────

const logsCmd = program
  .command("logs")
  .description("Print events from a .jsonl run log in a readable format")
  .addOption(
    new Option("--run <timestamp>", "Specific run timestamp to view (filename without .jsonl)")
      .default(null)
  );

logsCmd.action(async (options) => {
  const runsDir = path.join(process.cwd(), ".harness", "runs");

  if (!(await fs.pathExists(runsDir))) {
    console.log(chalk.dim("  No runs directory found (.harness/runs/ missing)."));
    console.log(chalk.dim("  Start a run first: cortex-harness run \"your task\""));
    return;
  }

  const runFiles = (await fs.readdir(runsDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (!runFiles.length) {
    console.log(chalk.dim("  No run logs found."));
    return;
  }

  let targetFile;
  if (options.run) {
    targetFile = `${options.run}.jsonl`;
    if (!runFiles.includes(targetFile)) {
      console.log(chalk.red(`  Run "${options.run}" not found.`));
      console.log(chalk.dim("  Available runs:"));
      for (const f of runFiles.slice(0, 10)) {
        console.log(chalk.dim(`   ${f.replace(".jsonl", "")}`));
      }
      if (runFiles.length > 10) console.log(chalk.dim(`   ... and ${runFiles.length - 10} more`));
      process.exit(1);
    }
  } else {
    targetFile = runFiles[0];
  }

  const runPath = path.join(runsDir, targetFile);
  const lines = (await fs.readFile(runPath, "utf8")).split("\n").filter(Boolean);

  if (!lines.length) {
    console.log(chalk.dim("  Run log is empty."));
    return;
  }

  console.log(chalk.bold("\n  Run: ", targetFile.replace(".jsonl", ""), "  (" + lines.length + " events)"));
  console.log(chalk.dim("  ─────────────────────────────────────────────────────────\n"));

  let count = 0;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      const t = ev.timestamp ?? ev.ts ?? "";
      const ts = t ? chalk.dim("[" + t.slice(11, 19) + "] ") : chalk.dim("[           ] ");

      if (ev.type === "harness") {
        if (ev.event === "run-start") {
          console.log(ts + chalk.green("▶ RUN START  "), chalk.dim("task:"), ev.task ?? "");
        } else if (ev.event === "run-end") {
          const summary = [
            ev.done ? chalk.green("✓ done:" + ev.done) : "",
            ev.blocked ? chalk.yellow("⊘ blocked:" + ev.blocked) : "",
            ev.pending ? chalk.blue("○ pending:" + ev.pending) : "",
          ].filter(Boolean).join("  ");
          console.log(ts + chalk.red("■ RUN END    "), summary);
          if (ev.totalSpentUsd !== undefined) {
            console.log(chalk.dim("             spent: $" + ev.totalSpentUsd.toFixed(2)));
          }
        } else if (ev.event === "fatal") {
          console.log(ts + chalk.red("✗ FATAL     "), ev.error ?? "");
        } else if (ev.event === "cycle-start") {
          console.log(ts + chalk.blue("→ CYCLE      "), chalk.bold(ev.cycleId ?? ""), ev.taskGroup ? chalk.dim("(" + ev.taskGroup + ")") : "");
        } else if (ev.event === "cycle-result") {
          const ok = ev.cycles ?? ev.delivered ?? 0;
          const fail = ev.blocked ?? 0;
          console.log(ts + chalk.green("← CYCLE END "), chalk.bold(ev.cycleId ?? ""),
            chalk.green(" ✓" + ok), fail > 0 ? chalk.red(" ⊘" + fail) : "",
            ev.partial ? chalk.yellow(" ~" + ev.partial) : "");
          if (ev.totalSpentUsd !== undefined) {
            console.log(chalk.dim("             spent: $" + ev.totalSpentUsd.toFixed(2)));
          }
        } else if (ev.event === "rate_limit") {
          console.log(ts + chalk.yellow("⚠ RATE LIMIT"), ev.service ?? "", ev.resetsAt ? "resets " + ev.resetsAt.slice(11, 16) : "");
        } else {
          console.log(ts + chalk.dim("harness/" + (ev.event ?? "??")));
        }
      } else if (ev.type === "agent_message" || ev.type === "message") {
        const role = ev.role ?? ev.agent ?? "?";
        const content = typeof ev.content === "string"
          ? ev.content.slice(0, 120)
          : JSON.stringify(ev.content ?? "").slice(0, 120);
        console.log(ts + chalk.cyan("◇ " + role.padEnd(10)), chalk.dim(content.slice(0, 80)));
      } else if (ev.type === "tool-call" || ev.type === "tool") {
        console.log(ts + chalk.magenta("⚙ TOOL CALL "), (ev.tool ?? ev.function ?? "").slice(0, 60));
      } else if (ev.type === "tool-result" || ev.type === "tool_result") {
        const ok = ev.success !== false;
        const preview = typeof ev.result === "string" ? ev.result.slice(0, 80) : JSON.stringify(ev.result ?? "").slice(0, 80);
        console.log(ts + (ok ? chalk.green("✓ TOOL OK   ") : chalk.red("✗ TOOL FAIL ")), chalk.dim(preview));
      } else if (ev.type === "notification-warning") {
        console.log(ts + chalk.yellow("⚠ NOTIFY WARN"), (ev.warning ?? "").slice(0, 80));
      } else if (ev.type === "error") {
        console.log(ts + chalk.red("✗ ERROR      "), (ev.message ?? JSON.stringify(ev)).slice(0, 80));
      } else if (ev.raw) {
        // raw LLM output lines
        console.log(ts + chalk.dim("○ raw       "), (ev.raw ?? "").slice(0, 100));
      } else {
        // fallback: show type + key fields
        const summary = Object.entries(ev)
          .filter(([k]) => !["type", "timestamp", "ts"].includes(k))
          .slice(0, 3)
          .map(([k, v]) => k + ":" + (typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)))
          .join(" | ");
        console.log(ts + chalk.dim("? " + (ev.type ?? "unknown") + " | " + summary.slice(0, 80)));
      }
      count++;
    } catch {
      // skip malformed lines
    }
  }

  console.log(chalk.dim("\n  (" + count + " events from " + targetFile.replace(".jsonl", "") + ")"));
});


// ─── notify-setup command ─────────────────────────────────────────────────────

program
  .command("notify-setup")
  .description("Interactive wizard to configure notification channels (Windows toast, Discord webhook)")
  .action(async () => {
    const rl = createInterface({ input, output });

    console.log("\n" + chalk.bold("Notification channel setup"));
    console.log(chalk.dim(`Config file: ${NOTIFICATION_CONFIG_FILE}\n`));

    const state = readNotificationConfig();
    if (!state.valid) {
      console.log(chalk.red(`  Existing config is invalid: ${state.error}`));
      console.log(chalk.yellow("  It will be overwritten if you proceed.\n"));
    }

    const config = state.exists && state.valid ? state.config : createEmptyNotificationConfig();
    let dirty = false;

    // ── Windows ──────────────────────────────────────────────────────────────
    const windowsEnabled = config.channels?.windows?.enabled;
    if (process.platform === "win32") {
      const current = windowsEnabled ? chalk.green("currently enabled") : chalk.dim("currently disabled");
      const answer = await rl.question(`  Set up Windows toast notifications? (${current}) [y/N]: `);
      if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
        console.log("  Sending test toast...");
        const result = await sendWindowsNotification({ title: "Claude Harness", message: "Notification setup test" });
        if (!result.ok) {
          console.log(chalk.red(`  Toast failed: ${result.error}`));
          console.log(chalk.yellow("  Windows notifications were NOT enabled.\n"));
        } else {
          config.channels.windows = { enabled: true };
          dirty = true;
          console.log(chalk.green("  ✓ Windows notifications enabled.\n"));
        }
      } else if (windowsEnabled) {
        const disable = await rl.question("  Disable Windows notifications? [y/N]: ");
        if (disable.trim().toLowerCase() === "y") {
          config.channels.windows = { enabled: false };
          dirty = true;
          console.log(chalk.yellow("  Windows notifications disabled.\n"));
        }
      }
    } else {
      console.log(chalk.dim("  Windows notifications: not available on this platform.\n"));
    }

    // ── Discord ───────────────────────────────────────────────────────────────
    const existing = getDiscordRegistrations(config);
    if (existing.length) {
      console.log("  Registered Discord channels:");
      existing.forEach((r, i) =>
        console.log(`    ${i + 1}. ${r.label ?? r.id} — ${r.enabled ? chalk.green("enabled") : chalk.dim("disabled")} (${redactWebhook(r.webhookUrl)})`)
      );
      console.log();
    }

    const addDiscord = await rl.question("  Add a Discord webhook channel? [y/N]: ");
    if (addDiscord.trim().toLowerCase() === "y" || addDiscord.trim().toLowerCase() === "yes") {
      const labelInput = await rl.question("  Display name for this channel (e.g. ops, alerts): ");
      const label = labelInput.trim() || `discord-${Date.now().toString().slice(-4)}`;
      const webhookInput = await rl.question("  Discord webhook URL: ");
      const validation = validateDiscordWebhookUrl(webhookInput);
      if (!validation.valid) {
        console.log(chalk.red(`  Invalid URL: ${validation.error}`));
        console.log(chalk.yellow("  Discord channel was NOT added.\n"));
      } else {
        console.log(`  Sending test message to ${label} (${redactWebhook(validation.webhookUrl)})...`);
        try {
          await sendDiscordNotification({
            webhookUrl: validation.webhookUrl,
            title: "Claude Harness",
            message: "Notification setup test",
            meta: { task: "Notification channel verification" },
          });
          const confirm = await rl.question("  Test message sent. Enable this channel? [y/N]: ");
          if (confirm.trim().toLowerCase() === "y" || confirm.trim().toLowerCase() === "yes") {
            const registrations = getDiscordRegistrations(config);
            registrations.push({
              id: `${label}-${registrations.length + 1}`,
              label,
              enabled: true,
              webhookUrl: validation.webhookUrl,
            });
            config.channels.discord = registrations;
            dirty = true;
            console.log(chalk.green(`  ✓ Discord channel "${label}" added.\n`));
          } else {
            console.log(chalk.dim("  Discord channel not saved.\n"));
          }
        } catch (err) {
          console.log(chalk.red(`  Discord test failed: ${err.message}`));
          console.log(chalk.yellow("  Channel was NOT added.\n"));
        }
      }
    }

    rl.close();

    if (dirty) {
      writeNotificationConfig(config);
      console.log(chalk.green(`\n  ✓ Config saved to ${NOTIFICATION_CONFIG_FILE}`));
    } else {
      console.log(chalk.dim("\n  No changes made."));
    }

    console.log(chalk.dim("\n  Run `cortex-harness notify list` to review registered channels."));
    console.log(chalk.dim("  Run `cortex-harness notify-setup` again to add more channels.\n"));
  });

// ─── notify command ───────────────────────────────────────────────────────────

program
  .command("notify [subcommand] [channel]")
  .description("Manage notification channels: register, test, list, unregister (see `notify help`)")
  .allowUnknownOption()
  .action((subcommand, channel) => {
    const notifyCliPath = path.join(pkgRoot, "src", "notifications", "notify-cli.mjs");
    const args = [notifyCliPath];
    if (subcommand) args.push(subcommand);
    if (channel) args.push(channel);

    const proc = spawn("node", args, { stdio: "inherit", cwd: process.cwd() });
    proc.on("exit", (code) => process.exit(code ?? 0));
  });

program.parse();
