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
  ".harness/task-queue.json",
  ".harness/sessions/",
  ".harness/pre-run-snapshot/",
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
    if (!process.stdin.isTTY) return "kept";
    const answer = await rl.question(
      `  ${chalk.yellow("?")} ${chalk.dim(rel)} already exists — update? ${chalk.dim("[y/N]")}: `,
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
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".nx",
  "tmp",
  ".cache",
  "coverage",
  ".turbo",
]);

// Patterns matched against the FULL forward-slash relative path (lowercase).
// Word-boundary (\b) ensures "api" matches "apps/api/" but not "capability/".
// Order matters — first match wins.
const SURFACE_PATTERNS = [
  { key: "backend", re: /\b(api|backend|server|serverless)\b/ },
  {
    key: "distributed",
    re: /\b(worker|queue|job|processor|consumer|producer)\b/,
  },
  { key: "sharedSchema", re: /\b(schema|zod|validation|models?)\b/ },
  { key: "sharedTypes", re: /\b(types?|entit(y|ies)|interfaces?|domain)\b/ },
  { key: "sharedUi", re: /\bui\b|\b(components?|design[-_]system)\b/ },
  {
    key: "frontend",
    re: /\b(web|frontend|client|shop|store|dashboard|portal)\b/,
  },
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
    backend: [],
    frontend: [],
    distributed: [],
    sharedSchema: [],
    sharedTypes: [],
    sharedUi: [],
  };

  async function walk(absDir, rel) {
    const entries = await fs
      .readdir(absDir, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || PRUNE_DIRS.has(e.name) || e.name.startsWith("."))
        continue;
      const childAbs = path.join(absDir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (await isProjectRoot(childAbs)) {
        const p = childRel + "/";
        const slug = p.toLowerCase();
        if (/\be2e\b/.test(slug)) continue; // skip e2e companion projects
        for (const { key, re } of SURFACE_PATTERNS) {
          if (re.test(slug)) {
            surfaces[key].push(p);
            break;
          }
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

  if (!process.stdin.isTTY) {
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
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!isNx) {
    console.log(
      chalk.yellow(
        "\n  No nx.json found — this doesn't look like an Nx workspace.",
      ),
    );
    console.log(
      chalk.dim(
        "  Enter your project surface paths manually, or press Enter to skip.\n",
      ),
    );
  } else {
    console.log(
      chalk.dim(
        "\n  Nx workspace detected. Confirm surface paths — press Enter to accept.\n",
      ),
    );
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
    "cortex:backend": surfaces.backend,
    "cortex:frontend": surfaces.frontend,
    "cortex:distributed": surfaces.distributed,
    "cortex:shared-schema": surfaces.sharedSchema,
    "cortex:shared-types": surfaces.sharedTypes,
    "cortex:shared-ui": surfaces.sharedUi,
    "cortex:frontend-checks": { _raw: frontendChecks },
  };

  const mdFiles = (await getAllFiles(agentsDir)).filter((f) =>
    f.endsWith(".md"),
  );
  for (const file of mdFiles) {
    let content = await fs.readFile(file, "utf8");
    let changed = false;

    for (const [tag, value] of Object.entries(tagMap)) {
      const open = `<!-- ${tag} -->`;
      const close = `<!-- /${tag} -->`;
      // value is either a paths array or a { _raw } object for pre-formatted content
      const list =
        value?._raw !== undefined
          ? value._raw
          : value.length === 0
            ? "- *(none configured — run `cortex-harness config` to set)*"
            : value.map((p) => `- \`${p}\``).join("\n");
      const replacement = `${open}\n${list}\n${close}`;

      let out = "";
      let cursor = 0;
      let found = false;
      while (true) {
        const openIdx = content.indexOf(open, cursor);
        if (openIdx === -1) break;
        const closeIdx = content.indexOf(close, openIdx + open.length);
        if (closeIdx === -1) break;
        out += content.slice(cursor, openIdx) + replacement;
        cursor = closeIdx + close.length;
        found = true;
      }
      if (found) {
        content = out + content.slice(cursor);
        changed = true;
      }
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
  .description(
    "Initialize the harness and lifecycle hooks in the current project",
  )
  .action(async () => {
    const targetHarnessDir = path.join(process.cwd(), ".harness");
    const targetClaudeDir = path.join(process.cwd(), ".claude");
    const templatesDir = path.join(pkgRoot, "templates");

    const rl = createInterface({ input, output });

    const W = Math.min(process.stdout.columns || 72, 72);
    const line = chalk.dim("─".repeat(W));

    console.log();
    console.log(
      chalk.bold.cyan("  cortex-harness") +
        chalk.dim(` v${pkgVersion}  —  init`),
    );
    console.log(line);

    function section(label) {
      console.log("\n" + chalk.bold(`  ${label}`));
    }

    // 1. Prompts
    section("Scaffolding prompts");
    await copyDir(
      path.join(templatesDir, "prompts"),
      path.join(targetHarnessDir, "prompts"),
      rl,
      ".harness/prompts",
    );

    // 2. Agents
    section("Scaffolding agents");
    await copyDir(
      path.join(templatesDir, "agents"),
      path.join(targetHarnessDir, "agents"),
      rl,
      ".harness/agents",
    );

    // 3. Memory
    if (await fs.pathExists(path.join(templatesDir, "memory"))) {
      section("Scaffolding memory");
      await copyDir(
        path.join(templatesDir, "memory"),
        path.join(targetHarnessDir, "memory"),
        rl,
        ".harness/memory",
      );
    }

    // 4. Scripts
    if (await fs.pathExists(path.join(templatesDir, "scripts"))) {
      section("Scaffolding scripts");
      await fs.ensureDir(path.join(targetHarnessDir, "scripts"));
      await copyDir(
        path.join(templatesDir, "scripts"),
        path.join(targetHarnessDir, "scripts"),
        rl,
        ".harness/scripts",
      );
    }

    // 5. .claude/settings.json — always merge hooks, never prompt (additive only)
    section("Wiring Claude hooks");
    await fs.ensureDir(targetClaudeDir);
    const settingsPath = path.join(targetClaudeDir, "settings.json");
    const settingsTemplatePath = path.join(
      templatesDir,
      ".claude",
      "settings.json",
    );
    if (await fs.pathExists(settingsTemplatePath)) {
      const templateSettings = await fs.readJson(settingsTemplatePath);
      if (await fs.pathExists(settingsPath)) {
        const existing = await fs.readJson(settingsPath);
        existing.hooks = { ...existing.hooks, ...templateSettings.hooks };
        await fs.writeJson(settingsPath, existing, { spaces: 2 });
        console.log(
          `  ${chalk.yellow("↑")} ${chalk.dim(".claude/settings.json")}  ${chalk.dim("(merged harness hooks)")}`,
        );
      } else {
        await fs.writeJson(settingsPath, templateSettings, { spaces: 2 });
        console.log(
          `  ${chalk.green("+")} ${chalk.dim(".claude/settings.json")}`,
        );
      }
    }

    // 6. harness.config.json + CLAUDE.md — root config files
    section("Writing root config files");
    const configPath = path.join(process.cwd(), "harness.config.json");
    const configTemplatePath = path.join(templatesDir, "harness.config.json");
    if (await fs.pathExists(configTemplatePath)) {
      const status = await copyFile(
        configTemplatePath,
        configPath,
        "harness.config.json",
        rl,
      );
      console.log(`  ${fileIcon(status)} ${chalk.dim("harness.config.json")}`);
    }

    const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
    const claudeMdTemplatePath = path.join(templatesDir, "CLAUDE.md");
    if (await fs.pathExists(claudeMdTemplatePath)) {
      const status = await copyFile(
        claudeMdTemplatePath,
        claudeMdPath,
        "CLAUDE.md",
        rl,
      );
      console.log(`  ${fileIcon(status)} ${chalk.dim("CLAUDE.md")}`);
    }

    // 7. .gitignore
    {
      const result = await patchGitignore(process.cwd());
      const note = result === "present" ? chalk.dim("  (already present)") : "";
      console.log(
        `  ${fileIcon(result === "present" ? "kept" : result === "appended" ? "updated" : "created")} ${chalk.dim(".gitignore")}${note}`,
      );
    }

    // 8. Surface configuration
    console.log("\n" + line);
    console.log(chalk.bold("  Surface configuration"));
    console.log(line);
    const detected = await detectSurfaces(process.cwd());
    const surfaces = await confirmSurfaces(detected, rl);

    if (await fs.pathExists(configPath)) {
      await applySurfaces(
        configPath,
        surfaces,
        path.join(targetHarnessDir, "agents"),
      );
      console.log(`\n  ${chalk.green("✓")} harness.config.json updated`);
      console.log(
        `  ${chalk.green("✓")} .harness/agents/*.agent.md scope sections patched`,
      );
    }

    const allEmpty = Object.values(surfaces).every((v) => v.length === 0);
    if (allEmpty) {
      console.log(
        `\n  ${chalk.yellow("!")} No surfaces configured — edit harness.config.json before running`,
      );
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
    console.log(
      `  ${chalk.dim("1.")} Review ${chalk.cyan("harness.config.json")} — scope paths are set to your surfaces`,
    );
    console.log(
      `  ${chalk.dim("2.")} Review ${chalk.cyan(".harness/agents/*.agent.md")} — Scope sections have been auto-patched`,
    );
    console.log(
      `  ${chalk.dim("3.")} Run: ${chalk.cyan('cortex-harness run "your task description"')}`,
    );
    console.log();
  });

// ─── config helpers ──────────────────────────────────────────────────────────

async function loadHarnessConfig(cwd) {
  const configPath = path.join(cwd, "harness.config.json");
  if (!(await fs.pathExists(configPath))) {
    console.error(
      chalk.red(
        '  harness.config.json not found. Run "cortex-harness init" first.',
      ),
    );
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
    (p) => p.startsWith("libs/"),
  );
  const sharedSchema = allShared.filter((p) =>
    /\b(schema|zod|validation|models?)\b/.test(p),
  );
  const sharedTypes = allShared.filter((p) =>
    /\b(types?|entit(y|ies)|interfaces?|domain)\b/.test(p),
  );
  const sharedUi = allShared.filter((p) =>
    /\bui\b|\b(components?|design[-_]system)\b/.test(p),
  );

  return {
    backend: backendScope.filter((p) => !p.startsWith("libs/")),
    frontend: frontendScope.filter((p) => !p.startsWith("libs/")),
    distributed: distScope,
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
      !scope || scope.length === 0 ? chalk.dim("(none)") : scope.join(", ");
    console.log(`  ${chalk.cyan(agent.padEnd(nameWidth))}  ${scopeStr}`);
  }
  console.log("  " + "─".repeat(nameWidth + 4 + 40));
  console.log();
}

// ─── config command ───────────────────────────────────────────────────────────

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

// ─── gitignore command ────────────────────────────────────────────────────────

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

// ─── run command ─────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Run the autonomous loop with a task description")
  .argument("[task...]", "The task for the agent to perform")
  .option(
    "-f, --task-file <file>",
    "Read task from a file (avoids shell quoting issues with JSON/logs)",
  )
  .action(async (taskParts, options) => {
    let task;

    if (options.taskFile) {
      const taskFilePath = path.resolve(process.cwd(), options.taskFile);
      if (!fs.existsSync(taskFilePath)) {
        console.error(chalk.red(`  Task file not found: ${taskFilePath}`));
        process.exit(1);
      }
      task = fs.readFileSync(taskFilePath, "utf8").trim();
    } else if (!process.stdin.isTTY) {
      // Piped input — read full stdin (handles PowerShell here-strings and any shell piping)
      task = await new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buf += chunk;
        });
        process.stdin.on("end", () => resolve(buf.trim()));
      });
    } else {
      task = taskParts.join(" ").trim();
    }

    if (!task) {
      console.error(
        chalk.red(
          "  No task provided. Pass a task string, pipe via stdin, or use --task-file.",
        ),
      );
      console.error(
        chalk.dim('  Example: cortex-harness run "fix the login bug"'),
      );
      console.error(
        chalk.dim('  Pipe:    echo "fix the login bug" | cortex-harness run'),
      );
      process.exit(1);
    }

    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const args = [enginePath, task];

    const proc = spawn("node", args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    proc.on("exit", (code) => process.exit(code ?? 0));
  });

// ─── continue / chain helpers ─────────────────────────────────────────────────

async function findLatestDelivery(cwd) {
  const outputDir = path.join(cwd, ".harness", "output");
  if (!(await fs.pathExists(outputDir))) return null;
  const files = (await fs.readdir(outputDir))
    .filter((f) => f.startsWith("delivery-") && f.endsWith(".md"))
    .sort(); // ISO timestamps sort lexicographically
  if (!files.length) return null;
  return path.join(outputDir, files[files.length - 1]);
}

function findResidualRisksSection(markdown) {
  const h2Idx = markdown.indexOf("## Residual risks");
  const h3Idx = markdown.indexOf("### Residual risks");
  const sectionIdx =
    h2Idx === -1 ? h3Idx : h3Idx === -1 ? h2Idx : Math.min(h2Idx, h3Idx);
  if (sectionIdx === -1) return null;
  const heading =
    markdown[sectionIdx + 2] === "#"
      ? "### Residual risks"
      : "## Residual risks";
  const sectionStart = sectionIdx + heading.length;
  const nextHeading = markdown.slice(sectionStart).search(/^#{2,3} /m);
  return nextHeading === -1
    ? markdown.slice(sectionStart)
    : markdown.slice(sectionStart, sectionStart + nextHeading);
}

// Passes the full delivery markdown to the LLM. Returns the next task string
// if chaining is needed, or null if the delivery is clean / all risks are
// non-actionable (pre-existing, HUMAN_APPROVAL_REQUIRED, needs production creds).
async function buildChainTask(markdown) {
  const prompt = `You are deciding whether an automated software delivery requires a follow-up run.

Read the full delivery summary below. Decide if there are residual risks that a follow-up code change in the local codebase can resolve.

Return ONLY a raw JSON object (no markdown fences, no explanation):
{ "chain": true, "task": "<task description for the next run>" }
OR
{ "chain": false, "task": null }

Set chain=true only when ALL of the following are true for at least one risk:
- It requires a code change that can be made locally.
- It is NOT described as pre-existing.
- It does NOT contain or imply HUMAN_APPROVAL_REQUIRED.
- It does NOT require external credentials, production/staging access, or environment variables unavailable locally.

When chain=true, the task string must:
- Describe exactly what to fix with enough detail for an agent to act without reading this delivery.
- Reference specific files, functions, or behaviors where known.
- NOT reference commands that have not been verified to exist in the codebase.

--- Full delivery summary ---
${markdown.trim()}
--- End ---`;

  const tmpDir = path.join(pkgRoot, ".tmp-extract");
  fs.mkdirSync(tmpDir, { recursive: true });

  let rawOutput = "";
  try {
    rawOutput = await new Promise((resolve, reject) => {
      let stdout = "";
      let proc;

      if (process.platform === "win32") {
        const promptFile = path.join(tmpDir, "chain-task-prompt.txt");
        const psFile = path.join(tmpDir, "chain-task.ps1");
        fs.writeFileSync(promptFile, prompt, "utf8");
        fs.writeFileSync(
          psFile,
          `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & claude --print --output-format text --max-turns 1 --max-budget-usd 0.05 --dangerously-skip-permissions\n`,
          "utf8",
        );
        proc = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            psFile,
          ],
          { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      } else {
        proc = spawn(
          "claude",
          [
            "-p",
            prompt,
            "--output-format",
            "text",
            "--max-turns",
            "1",
            "--max-budget-usd",
            "0.05",
            "--dangerously-skip-permissions",
          ],
          { cwd: pkgRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
      }

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("LLM chain-task build timed out"));
      }, 60000);
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.on("close", () => {
        clearTimeout(timer);
        resolve(stdout);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    console.warn(
      chalk.yellow(
        `  [warn] LLM chain-task build failed: ${err.message}. Treating as no chain needed.`,
      ),
    );
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const cleaned = rawOutput
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.chain || typeof parsed.task !== "string" || !parsed.task.trim())
      return null;
    return parsed.task.trim();
  } catch {
    console.warn(
      chalk.yellow(
        "  [warn] LLM returned non-JSON for chain-task build. Treating as no chain needed.",
      ),
    );
    console.warn(chalk.dim(`  Raw: ${rawOutput.slice(0, 300)}`));
    return null;
  }
}

async function clearHarnessState(cwd) {
  const harnessDir = path.join(cwd, ".harness");
  const queueFile = path.join(harnessDir, "task-queue.json");
  const sessionFile = path.join(harnessDir, "session.json");
  const cycleDir = path.join(harnessDir, "cycle-state");

  if (await fs.pathExists(queueFile)) await fs.remove(queueFile);
  if (await fs.pathExists(sessionFile)) await fs.remove(sessionFile);
  if (await fs.pathExists(cycleDir)) {
    const entries = await fs.readdir(cycleDir);
    for (const entry of entries) await fs.remove(path.join(cycleDir, entry));
  }
}

async function readRunEndSpend(runsDir) {
  if (!(await fs.pathExists(runsDir))) return 0;
  const files = (await fs.readdir(runsDir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();
  if (!files.length) return 0;
  try {
    const lines = (await fs.readFile(path.join(runsDir, files[0]), "utf8"))
      .split("\n")
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (
          ev.type === "harness" &&
          ev.event === "run-end" &&
          ev.totalSpentUsd !== undefined
        ) {
          return Number(ev.totalSpentUsd) || 0;
        }
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* file unreadable */
  }
  return 0;
}

function spawnRun(task, cwd) {
  return new Promise((resolve) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [enginePath, task], { stdio: "inherit", cwd });
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

// Spawn the engine with no task arg — resumes an existing queue in-place
function spawnResumedRun(cwd) {
  return new Promise((resolve) => {
    const enginePath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [enginePath], { stdio: "inherit", cwd });
    proc.on("exit", (code) => resolve(code ?? 0));
  });
}

// Collect human answers for blocked cycles and mark them pending.
// Does NOT spawn the engine — caller decides what to do next.
// Returns: "answered" | "session-limit-only" | "nothing-blocked"
async function resumeBlockedCycles(cwd) {
  const queueFile = path.join(cwd, ".harness", "task-queue.json");
  if (!fs.existsSync(queueFile)) return "nothing-blocked";

  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  } catch {
    return "nothing-blocked";
  }

  const blocked = (queue.cycles ?? []).filter((c) => c.status === "blocked");
  const needsInput = blocked.filter(
    (c) => c.blockedType === "needs-human-input",
  );
  const sessionLimit = blocked.filter((c) => c.blockedType === "session-limit");

  if (!blocked.length) return "nothing-blocked";

  if (!needsInput.length) {
    for (const c of blocked) {
      c.status = "pending";
      delete c.blockedType;
      delete c.blockedReason;
      delete c.blockedAt;
    }
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");
    console.log(
      chalk.dim(`  Marked ${blocked.length} session-limit cycle(s) for retry.`),
    );
    return "session-limit-only";
  }

  const TERM_WIDTH = Math.min(process.stdout.columns || 80, 100);
  const SEP = chalk.dim("─".repeat(TERM_WIDTH - 2));

  console.log(
    "\n" +
      chalk.bold.cyan(
        `  ${needsInput.length} cycle${needsInput.length > 1 ? "s" : ""} waiting for your input\n`,
      ),
  );

  const cycleAnswerDir = path.join(cwd, ".harness", "cycle-state");
  const answersFile = path.join(cycleAnswerDir, "human-answers.json");
  const decisions = [];

  for (let i = 0; i < needsInput.length; i++) {
    const c = needsInput[i];
    console.log(SEP);
    console.log(
      `\n  ${chalk.bold(`[${i + 1}/${needsInput.length}]`)} ${chalk.cyan(c.id)}  ${chalk.dim(`(${c.type})`)}\n`,
    );

    let questionText = c.blockedReason ?? "";
    if (questionText.length < 350 && c.outputFile) {
      try {
        const cycleStatePath = path.join(
          cwd,
          ".harness",
          "cycle-state",
          c.outputFile,
        );
        const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
        const gaps = data.outOfScopeGaps ?? [];
        if (gaps.length) {
          const gapLines = gaps.map((g) => {
            if (typeof g === "string") return `• ${g}`;
            const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
            if (g.reason) parts.push(`  ${g.reason}`);
            if (g.proposedModel)
              parts.push(
                `  Proposed:\n${g.proposedModel
                  .split("\n")
                  .map((l) => "    " + l)
                  .join("\n")}`,
              );
            return parts.join("\n");
          });
          const suffix = "\n\nBlocking gaps:\n" + gapLines.join("\n\n");
          questionText = questionText ? questionText + suffix : suffix.trim();
        }
      } catch {
        /* use blockedReason as-is */
      }
    }

    if (questionText) {
      const indent = "  ";
      const maxLen = TERM_WIDTH - indent.length;
      for (const line of questionText.split("\n")) {
        if (line.trim() === "") {
          console.log();
          continue;
        }
        const words = line.split(" ");
        let current = "";
        for (const word of words) {
          if (!current) {
            current = word;
            continue;
          }
          if (current.length + 1 + word.length <= maxLen) current += " " + word;
          else {
            console.log(indent + current);
            current = word;
          }
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

    decisions.push({
      cycleId: c.id,
      questions: questionText ? [{ text: questionText }] : [],
      answer: userAnswer,
    });
  }

  fs.mkdirSync(cycleAnswerDir, { recursive: true });
  const existing = fs.existsSync(answersFile)
    ? JSON.parse(fs.readFileSync(answersFile, "utf8"))
    : [];
  existing.push({
    answeredAt: new Date().toISOString(),
    resolvedCycles: needsInput.map((c) => c.id),
    decisions,
  });
  for (const c of blocked) {
    c.status = "pending";
    delete c.blockedType;
    delete c.blockedReason;
    delete c.blockedAt;
  }
  fs.writeFileSync(answersFile, JSON.stringify(existing, null, 2), "utf8");
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

  console.log(
    chalk.green(`  Answers saved for ${needsInput.length} cycle(s).`),
  );
  console.log(chalk.dim(`  Marked ${blocked.length} cycle(s) for retry.`));
  if (sessionLimit.length) {
    console.log(
      chalk.yellow(
        `\n  ${sessionLimit.length} session-limit cycle(s) will also retry — no answer needed.`,
      ),
    );
  }

  return "answered";
}

// ─── continue command ─────────────────────────────────────────────────────────

program
  .command("continue")
  .description(
    "One-shot continuation — extracts residual risks from last delivery and starts a new run",
  )
  .action(async () => {
    const cwd = process.cwd();

    const deliveryPath = await findLatestDelivery(cwd);
    if (!deliveryPath) {
      console.error(
        chalk.red(
          "  No delivery file found in .harness/output/. Nothing to continue from.",
        ),
      );
      console.error(chalk.dim('  Run: cortex-harness run "your task" first.'));
      process.exit(1);
    }
    console.log(chalk.dim(`  Reading: ${path.relative(cwd, deliveryPath)}`));

    const markdown = await fs.readFile(deliveryPath, "utf8");
    console.log(chalk.dim("  Asking LLM whether chaining is needed..."));
    const task = await buildChainTask(markdown);

    if (!task) {
      console.log(
        chalk.green(
          "  No actionable residual risks found — delivery is clean.",
        ),
      );
      process.exit(0);
    }

    console.log(chalk.bold("\n  Actionable work found. Next task:"));
    console.log(chalk.dim(`    ${task.split("\n")[0].slice(0, 120)}`));
    console.log();

    console.log(
      chalk.dim("  Clearing cycle-state/, task-queue.json, session.json..."),
    );
    await clearHarnessState(cwd);
    console.log(chalk.dim("  State cleared. Delivery files preserved.\n"));

    console.log(chalk.bold.cyan("  Starting continuation run...\n"));
    const exitCode = await spawnRun(task, cwd);
    process.exit(exitCode);
  });

// ─── chain command ────────────────────────────────────────────────────────────

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
  .option(
    "--budget <usd>",
    "Global USD budget cap across all chained runs",
    "60",
  )
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
    let globalSpent = 0;
    let runNumber = 0;
    let currentTask = taskParts.join(" ").trim() || null;

    if (!currentTask) {
      const deliveryPath = await findLatestDelivery(cwd);
      if (!deliveryPath) {
        console.error(
          chalk.red(
            "  No task provided and no delivery file found in .harness/output/.",
          ),
        );
        console.error(
          chalk.dim('  Provide a task: cortex-harness chain "your task"'),
        );
        process.exit(1);
      }
      const markdown = await fs.readFile(deliveryPath, "utf8");
      console.log(chalk.dim("  Asking LLM whether chaining is needed..."));
      currentTask = await buildChainTask(markdown);
      if (!currentTask) {
        console.log(
          chalk.green(
            "  No actionable residual risks in last delivery — nothing to chain.",
          ),
        );
        process.exit(0);
      }
      console.log(chalk.dim("  Seeding chain from last delivery."));
    }

    console.log(chalk.bold.cyan("\n  cortex-harness chain"));
    console.log(
      chalk.dim(`  Max runs: ${maxRuns}  |  Global budget: $${globalBudget}`),
    );
    console.log(chalk.dim("─".repeat(60)));

    while (runNumber < maxRuns) {
      runNumber++;
      const remainingBudget = globalBudget - globalSpent;

      console.log(
        chalk.bold(
          `\n  ══ Chain run ${runNumber}/${maxRuns}  ($${globalSpent.toFixed(2)} / $${globalBudget} spent) ══\n`,
        ),
      );

      if (remainingBudget <= 0) {
        console.log(chalk.red("  Global budget exhausted. Stopping chain."));
        break;
      }

      // Snapshot delivery state before this run so we can detect stale files afterward
      const deliveryBeforeRun = await findLatestDelivery(cwd);

      // Check for a blocked queue from a previous session before deciding whether to
      // clear state and start fresh, or resume in-place.
      let exitCode;
      const existingQueueFile = path.join(cwd, ".harness", "task-queue.json");
      const existingBlockedTypes = (() => {
        try {
          const q = JSON.parse(fs.readFileSync(existingQueueFile, "utf8"));
          const blocked = (q.cycles ?? []).filter(
            (c) => c.status === "blocked",
          );
          return {
            hasAny: blocked.length > 0,
            hasHumanInput: blocked.some(
              (c) => c.blockedType === "needs-human-input",
            ),
            hasSessionLimit: blocked.some(
              (c) => c.blockedType === "session-limit",
            ),
          };
        } catch {
          return {
            hasAny: false,
            hasHumanInput: false,
            hasSessionLimit: false,
          };
        }
      })();

      const shouldResume =
        existingBlockedTypes.hasAny &&
        (existingBlockedTypes.hasSessionLimit || // session-limit: always auto-resume
          (existingBlockedTypes.hasHumanInput && options.resumeOnBlock)); // human-input: requires flag

      if (shouldResume) {
        if (existingBlockedTypes.hasHumanInput) {
          console.log(
            chalk.yellow(
              "  Blocked queue detected (needs human input) — collecting answers...\n",
            ),
          );
        } else {
          console.log(
            chalk.dim(
              "  Blocked queue detected (session limit) — auto-resuming...\n",
            ),
          );
        }
        const resumeResult = await resumeBlockedCycles(cwd);
        if (resumeResult === "nothing-blocked") {
          console.log(
            chalk.yellow(
              "  No blocked cycles found — unexpected state. Stopping chain.",
            ),
          );
          break;
        }
        console.log(
          chalk.dim("\n  Resuming blocked run (state preserved)...\n"),
        );
        exitCode = await spawnResumedRun(cwd);
      } else if (existingBlockedTypes.hasHumanInput && !options.resumeOnBlock) {
        console.log(
          chalk.yellow(
            "  Blocked queue detected (needs human input). Stopping chain.",
          ),
        );
        console.log(
          chalk.dim(
            "  Re-run with --resume-on-block to answer inline, or: cortex-harness resume",
          ),
        );
        break;
      } else {
        console.log(chalk.dim("  Clearing state for fresh run..."));
        await clearHarnessState(cwd);
        exitCode = await spawnRun(currentTask, cwd);
      }

      const runSpent = await readRunEndSpend(runsDir);
      globalSpent += runSpent;

      console.log(
        chalk.dim(
          `\n  Run ${runNumber} complete. Exit: ${exitCode} | this run: $${runSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`,
        ),
      );

      if (exitCode !== 0) {
        console.log(
          chalk.red(`  Run exited with code ${exitCode}. Stopping chain.`),
        );
        break;
      }

      if (globalSpent >= globalBudget) {
        console.log(
          chalk.red(
            `  Global budget cap reached ($${globalSpent.toFixed(2)} >= $${globalBudget}). Stopping.`,
          ),
        );
        break;
      }

      let deliveryPath = await findLatestDelivery(cwd);
      if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
        // Determine what kind of block this is
        const midRunBlocked = (() => {
          try {
            const q = JSON.parse(fs.readFileSync(existingQueueFile, "utf8"));
            const blocked = (q.cycles ?? []).filter(
              (c) => c.status === "blocked",
            );
            return {
              hasHumanInput: blocked.some(
                (c) => c.blockedType === "needs-human-input",
              ),
              hasSessionLimit: blocked.some(
                (c) => c.blockedType === "session-limit",
              ),
              hasAny: blocked.length > 0,
            };
          } catch {
            return {
              hasHumanInput: false,
              hasSessionLimit: false,
              hasAny: false,
            };
          }
        })();

        const canAutoResume =
          midRunBlocked.hasSessionLimit && !midRunBlocked.hasHumanInput;
        const canInteractiveResume =
          midRunBlocked.hasHumanInput && options.resumeOnBlock;

        if (!midRunBlocked.hasAny) {
          console.log(
            chalk.yellow(
              "  Run did not produce a new delivery and no blocked cycles found (aborted). Stopping chain.",
            ),
          );
          break;
        } else if (!canAutoResume && !canInteractiveResume) {
          console.log(
            chalk.yellow(
              "  Run was blocked (needs human input). Stopping chain.",
            ),
          );
          console.log(
            chalk.dim(
              "  Re-run with --resume-on-block to answer inline, or: cortex-harness resume",
            ),
          );
          break;
        }

        if (midRunBlocked.hasHumanInput) {
          console.log(
            chalk.yellow(
              "\n  Run was blocked — collecting answers to continue chain...\n",
            ),
          );
        } else {
          console.log(
            chalk.dim("\n  Run hit session limit — auto-resuming...\n"),
          );
        }
        const resumeResult = await resumeBlockedCycles(cwd);
        if (resumeResult === "nothing-blocked") {
          console.log(
            chalk.yellow(
              "  No blocked cycles found — unexpected state. Stopping chain.",
            ),
          );
          break;
        }

        console.log(
          chalk.dim("\n  Resuming blocked run (state preserved)...\n"),
        );
        const resumeExitCode = await spawnResumedRun(cwd);
        const resumeSpent = await readRunEndSpend(runsDir);
        globalSpent += resumeSpent;
        console.log(
          chalk.dim(
            `  Resumed run complete. Exit: ${resumeExitCode} | this run: $${resumeSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`,
          ),
        );

        if (resumeExitCode !== 0) {
          console.log(
            chalk.red(
              `  Resumed run exited with code ${resumeExitCode}. Stopping chain.`,
            ),
          );
          break;
        }

        deliveryPath = await findLatestDelivery(cwd);
        if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
          console.log(
            chalk.yellow(
              "  Resumed run still did not produce a delivery. Stopping chain.",
            ),
          );
          break;
        }
      }

      const markdown = await fs.readFile(deliveryPath, "utf8");

      // Belt-and-suspenders: check raw section for NEEDS_HUMAN_INPUT before filtering
      const rawSection = findResidualRisksSection(markdown);
      if (rawSection?.includes("NEEDS_HUMAN_INPUT")) {
        console.log(
          chalk.yellow(
            "\n  NEEDS_HUMAN_INPUT detected in residual risks. Stopping chain — human input required.",
          ),
        );
        console.log(chalk.dim("  Run: cortex-harness resume"));
        break;
      }

      console.log(chalk.dim("\n  Asking LLM whether chaining is needed..."));
      const nextTask = await buildChainTask(markdown);
      if (!nextTask) {
        console.log(
          chalk.green(
            "\n  No actionable residual risks remain. Chain complete.",
          ),
        );
        break;
      }

      if (runNumber >= maxRuns) {
        console.log(
          chalk.yellow(
            `\n  Max runs (${maxRuns}) reached. Residual work remains:`,
          ),
        );
        console.log(chalk.dim(`    ${nextTask.split("\n")[0].slice(0, 120)}`));
        break;
      }

      currentTask = nextTask;
      console.log(
        chalk.bold("\n  Actionable work found → chaining next run..."),
      );
      console.log(chalk.dim(`    ${nextTask.split("\n")[0].slice(0, 120)}`));
    }

    console.log(
      chalk.bold.blue("\n━━━ Chain Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"),
    );
    console.log(`${chalk.dim("Runs completed:")} ${runNumber}`);
    console.log(
      `${chalk.dim("Global spend  :")} $${globalSpent.toFixed(2)} / $${globalBudget}`,
    );
    console.log(
      chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"),
    );

    process.exit(0);
  });

// ─── chain resume subcommand ──────────────────────────────────────────────────

chainCmd
  .command("resume")
  .description(
    "Resume a blocked run (human-input or session-limit), then keep chaining from the resulting delivery",
  )
  .option(
    "--max-runs <n>",
    "Maximum number of chained runs after the resumed run",
    "3",
  )
  .option("--budget <usd>", "Global USD budget cap across all runs", "60")
  .action(async (options) => {
    const cwd = process.cwd();
    const runsDir = path.join(cwd, ".harness", "runs");
    const maxRuns = parseInt(options.maxRuns, 10);
    const globalBudget = parseFloat(options.budget);
    let globalSpent = 0;

    // ── Step 1: resume the blocked run ────────────────────────────────────────
    const queueFile = path.join(cwd, ".harness", "task-queue.json");
    if (!fs.existsSync(queueFile)) {
      console.error(
        chalk.red("  [ERROR] No task-queue.json found. Nothing to resume."),
      );
      console.error(
        chalk.dim('  Start a run first: cortex-harness run "your task"'),
      );
      process.exit(1);
    }

    const blocked = (() => {
      try {
        const q = JSON.parse(fs.readFileSync(queueFile, "utf8"));
        return (q.cycles ?? []).filter((c) => c.status === "blocked");
      } catch {
        return [];
      }
    })();

    if (!blocked.length) {
      console.error(
        chalk.red("  [ERROR] No blocked cycles in task-queue.json."),
      );
      console.error(
        chalk.dim("  Use: cortex-harness chain [task] to start a new chain."),
      );
      process.exit(1);
    }

    const hasHumanInput = blocked.some(
      (c) => c.blockedType === "needs-human-input",
    );
    const hasSessionLimit = blocked.some(
      (c) => c.blockedType === "session-limit",
    );

    console.log(chalk.bold.cyan("\n  cortex-harness chain resume"));
    console.log(
      chalk.dim(`  Max runs: ${maxRuns}  |  Global budget: $${globalBudget}`),
    );
    if (hasHumanInput)
      console.log(
        chalk.yellow(
          `  ${blocked.filter((c) => c.blockedType === "needs-human-input").length} cycle(s) need your input`,
        ),
      );
    if (hasSessionLimit)
      console.log(
        chalk.dim(
          `  ${blocked.filter((c) => c.blockedType === "session-limit").length} session-limit cycle(s) will auto-retry`,
        ),
      );
    console.log(chalk.dim("─".repeat(60)));

    const deliveryBeforeResume = await findLatestDelivery(cwd);

    const resumeResult = await resumeBlockedCycles(cwd);
    if (resumeResult === "nothing-blocked") {
      console.error(
        chalk.red("  [ERROR] No blocked cycles found — unexpected state."),
      );
      process.exit(1);
    }

    console.log(chalk.dim("\n  Resuming blocked run (state preserved)...\n"));
    const resumeExitCode = await spawnResumedRun(cwd);
    const resumeSpent = await readRunEndSpend(runsDir);
    globalSpent += resumeSpent;

    console.log(
      chalk.dim(
        `\n  Resumed run complete. Exit: ${resumeExitCode} | this run: $${resumeSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`,
      ),
    );

    if (resumeExitCode !== 0) {
      console.log(
        chalk.red(
          `  Resumed run exited with code ${resumeExitCode}. Stopping.`,
        ),
      );
      process.exit(resumeExitCode);
    }

    let deliveryPath = await findLatestDelivery(cwd);
    if (!deliveryPath || deliveryPath === deliveryBeforeResume) {
      console.log(
        chalk.yellow(
          "  Resumed run did not produce a delivery. Cannot continue chain.",
        ),
      );
      process.exit(1);
    }

    // ── Step 2: chain from the delivery the resumed run produced ──────────────
    let runNumber = 1;

    while (runNumber < maxRuns) {
      const markdown = await fs.readFile(deliveryPath, "utf8");

      // Stop if residual risks contain NEEDS_HUMAN_INPUT
      const rawSection = findResidualRisksSection(markdown);
      if (rawSection?.includes("NEEDS_HUMAN_INPUT")) {
        console.log(
          chalk.yellow(
            "\n  NEEDS_HUMAN_INPUT in residual risks. Stopping chain — human input required.",
          ),
        );
        console.log(chalk.dim("  Run: cortex-harness chain resume"));
        break;
      }

      console.log(chalk.dim("\n  Asking LLM whether chaining is needed..."));
      const nextTask = await buildChainTask(markdown);
      if (!nextTask) {
        console.log(
          chalk.green(
            "\n  No actionable residual risks remain. Chain complete.",
          ),
        );
        break;
      }

      if (runNumber >= maxRuns) {
        console.log(
          chalk.yellow(
            `\n  Max runs (${maxRuns}) reached. Residual work remains:`,
          ),
        );
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
        chalk.bold(
          `\n  ══ Chain run ${runNumber}/${maxRuns}  ($${globalSpent.toFixed(2)} / $${globalBudget} spent) ══\n`,
        ),
      );

      const currentTask = nextTask;
      const deliveryBeforeRun = await findLatestDelivery(cwd);

      // Check for a new block before clearing state
      const midBlocked = (() => {
        try {
          const q = JSON.parse(fs.readFileSync(queueFile, "utf8"));
          const b = (q.cycles ?? []).filter((c) => c.status === "blocked");
          return {
            hasAny: b.length > 0,
            hasHumanInput: b.some((c) => c.blockedType === "needs-human-input"),
            hasSessionLimit: b.some((c) => c.blockedType === "session-limit"),
          };
        } catch {
          return {
            hasAny: false,
            hasHumanInput: false,
            hasSessionLimit: false,
          };
        }
      })();

      let runExitCode;
      if (midBlocked.hasSessionLimit && !midBlocked.hasHumanInput) {
        console.log(
          chalk.dim("  Session-limit block detected — auto-resuming...\n"),
        );
        await resumeBlockedCycles(cwd);
        runExitCode = await spawnResumedRun(cwd);
      } else if (midBlocked.hasHumanInput) {
        console.log(
          chalk.yellow("  Human input required — collecting answers...\n"),
        );
        await resumeBlockedCycles(cwd);
        runExitCode = await spawnResumedRun(cwd);
      } else {
        console.log(chalk.dim("  Clearing state for fresh run..."));
        await clearHarnessState(cwd);
        runExitCode = await spawnRun(currentTask, cwd);
      }

      const runSpent = await readRunEndSpend(runsDir);
      globalSpent += runSpent;
      console.log(
        chalk.dim(
          `\n  Run ${runNumber} complete. Exit: ${runExitCode} | this run: $${runSpent.toFixed(2)} | total: $${globalSpent.toFixed(2)}`,
        ),
      );

      if (runExitCode !== 0) {
        console.log(
          chalk.red(`  Run exited with code ${runExitCode}. Stopping chain.`),
        );
        break;
      }

      if (globalSpent >= globalBudget) {
        console.log(
          chalk.red(
            `  Global budget cap reached ($${globalSpent.toFixed(2)} >= $${globalBudget}). Stopping.`,
          ),
        );
        break;
      }

      deliveryPath = await findLatestDelivery(cwd);
      if (!deliveryPath || deliveryPath === deliveryBeforeRun) {
        console.log(
          chalk.yellow(
            "  Run did not produce a new delivery (blocked or aborted). Stopping chain.",
          ),
        );
        console.log(chalk.dim("  Run: cortex-harness chain resume"));
        break;
      }
    }

    console.log(
      chalk.bold.blue("\n━━━ Chain Resume Summary ━━━━━━━━━━━━━━━━━━━━━━━━━"),
    );
    console.log(`${chalk.dim("Runs completed:")} ${runNumber}`);
    console.log(
      `${chalk.dim("Global spend  :")} $${globalSpent.toFixed(2)} / $${globalBudget}`,
    );
    console.log(
      chalk.bold.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"),
    );

    process.exit(0);
  });

// ─── status command ───────────────────────────────────────────────────────────

program
  .command("status")
  .description(
    "Show the current run status — blocked questions, pending cycles, progress",
  )
  .action(async () => {
    const queuePath = path.join(process.cwd(), ".harness", "task-queue.json");
    if (!(await fs.pathExists(queuePath))) {
      console.log(
        chalk.dim("  No active run found (task-queue.json missing)."),
      );
      console.log(
        chalk.dim('  Start one with: cortex-harness run "your task"'),
      );
      return;
    }

    let queue;
    try {
      queue = await fs.readJson(queuePath);
    } catch {
      console.log(
        chalk.red("  task-queue.json exists but could not be parsed."),
      );
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
            .split("\n")
            .filter(Boolean);
          for (const line of lines) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === "cycle-result" && ev.cycleId && ev.finalMessage) {
                // Keep only the last result per cycleId (latest attempt)
                fullMessages[ev.cycleId] = ev.finalMessage;
              }
            } catch {
              /* skip malformed lines */
            }
          }
        } catch {
          /* log unreadable — skip */
        }
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
        const extracted =
          nhiIdx !== -1
            ? full
                .slice(nhiIdx + "NEEDS_HUMAN_INPUT".length)
                .replace(/^[:\s–-]+/, "")
                .trim()
            : "";
        if (extracted) return extracted;
        // extraction was empty (keyword absent) — fall through to augment with cycle state
      }

      // 2. Append outOfScopeGaps from cycle output file only when stored text looks truncated
      // (legacy runs had a 300-char hard cap; skip gaps if stored is clearly full text)
      const TRUNCATION_THRESHOLD = 350;
      if (c.outputFile && stored.length < TRUNCATION_THRESHOLD) {
        try {
          const cycleStatePath = path.join(
            process.cwd(),
            ".harness",
            "cycle-state",
            c.outputFile,
          );
          const data = JSON.parse(fs.readFileSync(cycleStatePath, "utf8"));
          const gaps = data.outOfScopeGaps ?? [];
          if (gaps.length) {
            const lines = gaps.map((g) => {
              if (typeof g === "string") return `• ${g}`;
              const parts = [`• ${g.gap ?? g.description ?? "(gap)"}`];
              if (g.reason) parts.push(`  ${g.reason}`);
              if (g.proposedModel)
                parts.push(`  Proposed model: ${g.proposedModel}`);
              return parts.join("\n");
            });
            const suffix = "\n\nBlocking gaps:\n" + lines.join("\n\n");
            return stored ? stored + suffix : suffix.trim();
          }
        } catch {
          /* output file missing or unparseable — fall through */
        }
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
        if (!current) {
          current = word;
          continue;
        }
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
        if (para.trim() === "") {
          console.log();
          continue;
        }
        console.log(wrap(para, indent));
      }
    }

    const cycles = queue.cycles ?? [];
    const done = cycles.filter((c) => c.status === "done");
    const pending = cycles.filter((c) => c.status === "pending");
    const partial = cycles.filter((c) => c.status === "partial");
    const blocked = cycles.filter((c) => c.status === "blocked");
    const needsInput = blocked.filter(
      (c) => c.blockedType === "needs-human-input",
    );
    const limitHit = blocked.filter((c) => c.blockedType === "session-limit");

    const taskDisplay =
      (queue.task ?? "(unknown)").length > 100
        ? (queue.task ?? "").slice(0, 100) + "…"
        : (queue.task ?? "(unknown)");

    console.log(
      `\n${chalk.bold.blue("━━━ Harness Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`,
    );
    console.log(`${chalk.dim("Task   :")} ${taskDisplay}`);
    console.log(`${chalk.dim("Type   :")} ${queue.promptType ?? "(unknown)"}`);
    console.log(
      `${chalk.dim("Queue  :")} ${chalk.green(done.length + " done")}  ` +
        `${chalk.yellow(pending.length + " pending")}  ` +
        `${chalk.yellow(partial.length + " partial")}  ` +
        `${chalk.red(blocked.length + " blocked")}`,
    );

    // ── Blocked: needs human input ──────────────────────────────────────────
    if (needsInput.length) {
      console.log(`\n${chalk.red.bold("  Waiting for your input:")}`);
      for (const c of needsInput) {
        console.log(`\n  ${chalk.cyan(c.id)} ${chalk.dim(`(${c.type})`)}`);
        console.log(
          chalk.dim("  ─────────────────────────────────────────────"),
        );
        const questionText = getQuestionText(c);
        if (questionText) {
          printWrapped(questionText, 2);
        } else {
          console.log(chalk.dim("  (no question text recorded)"));
        }
        console.log(
          chalk.dim("  ─────────────────────────────────────────────"),
        );
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
      console.log(
        chalk.dim("\n  Resume after the limit resets: cortex-harness resume"),
      );
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
    const rlRun = createInterface({ input, output });
    let startRun = "y";
    try {
      startRun =
        (await rlRun.question(chalk.bold("  Start run now? [Y/n]: ")))
          .trim()
          .toLowerCase() || "y";
    } finally {
      rlRun.close();
    }
    if (startRun === "n" || startRun === "no") {
      console.log(
        chalk.dim("\n  Run skipped. Start manually with: cortex-harness run"),
      );
      return;
    }
    console.log();

    const runPath = path.join(pkgRoot, "src", "run-autonomous.mjs");
    const proc = spawn("node", [runPath], { stdio: "inherit", cwd });
    proc.on("exit", (code) => process.exit(code ?? 0));
  });

// ─── logs command ─────────────────────────────────────────────────────────────

const logsCmd = program
  .command("logs")
  .description("Print events from a .jsonl run log in a readable format")
  .addOption(
    new Option(
      "--run <timestamp>",
      "Specific run timestamp to view (filename without .jsonl)",
    ).default(null),
  );

logsCmd.action(async (options) => {
  const runsDir = path.join(process.cwd(), ".harness", "runs");

  if (!(await fs.pathExists(runsDir))) {
    console.log(
      chalk.dim("  No runs directory found (.harness/runs/ missing)."),
    );
    console.log(
      chalk.dim('  Start a run first: cortex-harness run "your task"'),
    );
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
      if (runFiles.length > 10)
        console.log(chalk.dim(`   ... and ${runFiles.length - 10} more`));
      process.exit(1);
    }
  } else {
    targetFile = runFiles[0];
  }

  const runPath = path.join(runsDir, targetFile);
  const lines = (await fs.readFile(runPath, "utf8"))
    .split("\n")
    .filter(Boolean);

  if (!lines.length) {
    console.log(chalk.dim("  Run log is empty."));
    return;
  }

  console.log(
    chalk.bold(
      "\n  Run: ",
      targetFile.replace(".jsonl", ""),
      "  (" + lines.length + " events)",
    ),
  );
  console.log(
    chalk.dim("  ─────────────────────────────────────────────────────────\n"),
  );

  let count = 0;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      const t = ev.timestamp ?? ev.ts ?? "";
      const ts = t
        ? chalk.dim("[" + t.slice(11, 19) + "] ")
        : chalk.dim("[" + String(count + 1).padStart(5) + "] ");

      if (ev.type === "harness") {
        if (ev.event === "run-start") {
          console.log(
            ts + chalk.green("▶ RUN START  "),
            chalk.dim("task:"),
            ev.task ?? "",
          );
        } else if (ev.event === "run-end") {
          const summary = [
            ev.done ? chalk.green("✓ done:" + ev.done) : "",
            ev.blocked ? chalk.yellow("⊘ blocked:" + ev.blocked) : "",
            ev.pending ? chalk.blue("○ pending:" + ev.pending) : "",
          ]
            .filter(Boolean)
            .join("  ");
          console.log(ts + chalk.red("■ RUN END    "), summary);
          if (ev.totalSpentUsd !== undefined) {
            console.log(
              chalk.dim("              spent: $" + ev.totalSpentUsd.toFixed(2)),
            );
          }
        } else if (ev.event === "fatal") {
          console.log(ts + chalk.red("✗ FATAL     "), ev.error ?? "");
        } else if (ev.event === "cycle-start") {
          console.log(
            ts + chalk.blue("→ CYCLE      "),
            chalk.bold(ev.cycleId ?? ""),
            ev.taskGroup ? chalk.dim("(" + ev.taskGroup + ")") : "",
          );
        } else if (ev.event === "cycle-result") {
          const ok = ev.cycles ?? ev.delivered ?? 0;
          const fail = ev.blocked ?? 0;
          console.log(
            ts + chalk.green("← CYCLE END "),
            chalk.bold(ev.cycleId ?? ""),
            chalk.green(" ✓" + ok),
            fail > 0 ? chalk.red(" ⊘" + fail) : "",
            ev.partial ? chalk.yellow(" ~" + ev.partial) : "",
          );
          if (ev.totalSpentUsd !== undefined) {
            console.log(
              chalk.dim("              spent: $" + ev.totalSpentUsd.toFixed(2)),
            );
          }
        } else if (ev.event === "rate_limit") {
          console.log(
            ts + chalk.yellow("⚠ RATE LIMIT"),
            ev.service ?? "",
            ev.resetsAt ? "resets " + ev.resetsAt.slice(11, 16) : "",
          );
        } else {
          console.log(ts + chalk.dim("harness/" + (ev.event ?? "??")));
        }
      } else if (ev.type === "agent_message" || ev.type === "message") {
        const role = ev.role ?? ev.agent ?? "?";
        const content =
          typeof ev.content === "string"
            ? ev.content
            : JSON.stringify(ev.content ?? "");
        console.log(
          ts + chalk.cyan("◇ " + role.padEnd(10)),
          chalk.dim(content.slice(0, 120)),
        );
      } else if (ev.type === "tool-call" || ev.type === "tool") {
        console.log(
          ts + chalk.magenta("⚙ TOOL CALL "),
          ev.tool ?? ev.function ?? "",
        );
      } else if (ev.type === "tool-result" || ev.type === "tool_result") {
        const ok = ev.success !== false;
        const preview =
          typeof ev.result === "string"
            ? ev.result
            : JSON.stringify(ev.result ?? "");
        console.log(
          ts + (ok ? chalk.green("✓ TOOL OK   ") : chalk.red("✗ TOOL FAIL ")),
          chalk.dim(preview.slice(0, 120)),
        );
      } else if (ev.type === "notification-warning") {
        console.log(ts + chalk.yellow("⚠ NOTIFY WARN"), ev.warning ?? "");
      } else if (ev.type === "error") {
        console.log(
          ts + chalk.red("✗ ERROR      "),
          ev.message ?? JSON.stringify(ev),
        );
      } else if (ev.raw) {
        // parse raw Claude SDK stream events for useful info
        try {
          const raw = typeof ev.raw === "string" ? JSON.parse(ev.raw) : ev.raw;
          const rawType = raw.type ?? raw.subtype ?? "raw";
          if (raw.type === "assistant" && raw.message) {
            const msg = raw.message;
            const firstText =
              msg.content?.find((b) => b.type === "text")?.text ?? "";
            const firstTool =
              msg.content?.find((b) => b.type === "tool_use")?.name ?? "";
            const preview = firstText || (firstTool ? "tool:" + firstTool : "");
            console.log(
              ts + chalk.dim("◇ assistant "),
              chalk.dim(preview.slice(0, 120)),
            );
          } else if (raw.type === "user" && raw.message) {
            const content = raw.message.content;
            const toolResult = Array.isArray(content)
              ? content.find((b) => b.type === "tool_result")
              : null;
            const preview = toolResult
              ? (typeof toolResult.content === "string"
                  ? toolResult.content
                  : JSON.stringify(toolResult.content)
                ).slice(0, 120)
              : JSON.stringify(content ?? "").slice(0, 120);
            console.log(ts + chalk.dim("◇ user      "), chalk.dim(preview));
          } else if (raw.type === "system") {
            console.log(
              ts + chalk.dim("⚙ system    "),
              chalk.dim(
                (raw.subtype ?? "") +
                  (raw.task_id ? " task:" + raw.task_id : ""),
              ),
            );
          } else if (raw.type === "result") {
            const spent =
              raw.cost_usd !== undefined
                ? " $" + Number(raw.cost_usd).toFixed(3)
                : "";
            console.log(
              ts + chalk.dim("■ result    "),
              chalk.dim((raw.subtype ?? "") + spent),
            );
          } else if (raw.type === "rate_limit_event") {
            console.log(
              ts + chalk.yellow("⚠ rate limit"),
              chalk.dim(raw.rate_limit_info?.status ?? ""),
            );
          } else {
            console.log(
              ts + chalk.dim("○ " + rawType.padEnd(10)),
              chalk.dim(JSON.stringify(raw).slice(0, 120)),
            );
          }
        } catch {
          console.log(
            ts + chalk.dim("○ raw       "),
            chalk.dim(String(ev.raw).slice(0, 120)),
          );
        }
      } else {
        // fallback: show type + key fields
        const summary = Object.entries(ev)
          .filter(([k]) => !["type", "timestamp", "ts"].includes(k))
          .slice(0, 3)
          .map(
            ([k, v]) =>
              k +
              ":" +
              (typeof v === "string" ? v : JSON.stringify(v).slice(0, 60)),
          )
          .join(" | ");
        console.log(
          ts +
            chalk.dim(
              "? " + (ev.type ?? "unknown") + " | " + summary.slice(0, 120),
            ),
        );
      }
      count++;
    } catch {
      // skip malformed lines
    }
  }

  console.log(
    chalk.dim(
      "\n  (" +
        count +
        " events from " +
        targetFile.replace(".jsonl", "") +
        ")",
    ),
  );
});

// ─── notify-setup command ─────────────────────────────────────────────────────

program
  .command("notify-setup")
  .description(
    "Interactive wizard to configure notification channels (Windows toast, Discord webhook)",
  )
  .action(async () => {
    const rl = createInterface({ input, output });

    console.log("\n" + chalk.bold("Notification channel setup"));
    console.log(chalk.dim(`Config file: ${NOTIFICATION_CONFIG_FILE}\n`));

    const state = readNotificationConfig();
    if (!state.valid) {
      console.log(chalk.red(`  Existing config is invalid: ${state.error}`));
      console.log(chalk.yellow("  It will be overwritten if you proceed.\n"));
    }

    const config =
      state.exists && state.valid
        ? state.config
        : createEmptyNotificationConfig();
    let dirty = false;

    // ── Windows ──────────────────────────────────────────────────────────────
    const windowsEnabled = config.channels?.windows?.enabled;
    if (process.platform === "win32") {
      const current = windowsEnabled
        ? chalk.green("currently enabled")
        : chalk.dim("currently disabled");
      const answer = await rl.question(
        `  Set up Windows toast notifications? (${current}) [y/N]: `,
      );
      if (
        answer.trim().toLowerCase() === "y" ||
        answer.trim().toLowerCase() === "yes"
      ) {
        console.log("  Sending test toast...");
        const result = await sendWindowsNotification({
          title: "Claude Harness",
          message: "Notification setup test",
        });
        if (!result.ok) {
          console.log(chalk.red(`  Toast failed: ${result.error}`));
          console.log(
            chalk.yellow("  Windows notifications were NOT enabled.\n"),
          );
        } else {
          config.channels.windows = { enabled: true };
          dirty = true;
          console.log(chalk.green("  ✓ Windows notifications enabled.\n"));
        }
      } else if (windowsEnabled) {
        const disable = await rl.question(
          "  Disable Windows notifications? [y/N]: ",
        );
        if (disable.trim().toLowerCase() === "y") {
          config.channels.windows = { enabled: false };
          dirty = true;
          console.log(chalk.yellow("  Windows notifications disabled.\n"));
        }
      }
    } else {
      console.log(
        chalk.dim("  Windows notifications: not available on this platform.\n"),
      );
    }

    // ── Discord ───────────────────────────────────────────────────────────────
    const existing = getDiscordRegistrations(config);
    if (existing.length) {
      console.log("  Registered Discord channels:");
      existing.forEach((r, i) =>
        console.log(
          `    ${i + 1}. ${r.label ?? r.id} — ${r.enabled ? chalk.green("enabled") : chalk.dim("disabled")} (${redactWebhook(r.webhookUrl)})`,
        ),
      );
      console.log();
    }

    const addDiscord = await rl.question(
      "  Add a Discord webhook channel? [y/N]: ",
    );
    if (
      addDiscord.trim().toLowerCase() === "y" ||
      addDiscord.trim().toLowerCase() === "yes"
    ) {
      const labelInput = await rl.question(
        "  Display name for this channel (e.g. ops, alerts): ",
      );
      const label =
        labelInput.trim() || `discord-${Date.now().toString().slice(-4)}`;
      const webhookInput = await rl.question("  Discord webhook URL: ");
      const validation = validateDiscordWebhookUrl(webhookInput);
      if (!validation.valid) {
        console.log(chalk.red(`  Invalid URL: ${validation.error}`));
        console.log(chalk.yellow("  Discord channel was NOT added.\n"));
      } else {
        console.log(
          `  Sending test message to ${label} (${redactWebhook(validation.webhookUrl)})...`,
        );
        try {
          await sendDiscordNotification({
            webhookUrl: validation.webhookUrl,
            title: "Claude Harness",
            message: "Notification setup test",
            meta: { task: "Notification channel verification" },
          });
          const confirm = await rl.question(
            "  Test message sent. Enable this channel? [y/N]: ",
          );
          if (
            confirm.trim().toLowerCase() === "y" ||
            confirm.trim().toLowerCase() === "yes"
          ) {
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
      console.log(
        chalk.green(`\n  ✓ Config saved to ${NOTIFICATION_CONFIG_FILE}`),
      );
    } else {
      console.log(chalk.dim("\n  No changes made."));
    }

    console.log(
      chalk.dim(
        "\n  Run `cortex-harness notify list` to review registered channels.",
      ),
    );
    console.log(
      chalk.dim(
        "  Run `cortex-harness notify-setup` again to add more channels.\n",
      ),
    );
  });

// ─── notify command ───────────────────────────────────────────────────────────

program
  .command("notify [subcommand] [channel]")
  .description(
    "Manage notification channels: register, test, list, unregister (see `notify help`)",
  )
  .allowUnknownOption()
  .action((subcommand, channel) => {
    const notifyCliPath = path.join(
      pkgRoot,
      "src",
      "notifications",
      "notify-cli.mjs",
    );
    const args = [notifyCliPath];
    if (subcommand) args.push(subcommand);
    if (channel) args.push(channel);

    const proc = spawn("node", args, { stdio: "inherit", cwd: process.cwd() });
    proc.on("exit", (code) => process.exit(code ?? 0));
  });

program.parse();
