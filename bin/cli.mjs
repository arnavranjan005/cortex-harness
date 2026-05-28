#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

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

    rl.close();

    console.log("\nHarness initialized successfully.");
    console.log("\nNext steps:");
    console.log("  1. Edit harness.config.json to match your project's agent scopes");
    console.log("  2. Customize .harness/agents/*.agent.md for your stack");
    console.log("  3. Run: cortex-harness run \"your task description\"");
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
