#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.join(__dirname, "..");

const program = new Command();

program
  .name("cortex-harness")
  .description("CLI to scaffold and run an autonomous agent harness")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize the harness and lifecycle hooks in the current project")
  .action(async () => {
    const targetHarnessDir = path.join(process.cwd(), ".harness");
    const targetClaudeDir = path.join(process.cwd(), ".claude");
    const templatesDir = path.join(pkgRoot, "templates");

    console.log(`Initializing harness in ${targetHarnessDir}...`);

    // 1. Scaffold .harness/ directory
    await fs.ensureDir(targetHarnessDir);
    await fs.copy(path.join(templatesDir, "prompts"), path.join(targetHarnessDir, "prompts"));
    await fs.copy(path.join(templatesDir, "agents"), path.join(targetHarnessDir, "agents"));

    // 2. Scaffold memory directory into .harness/memory/
    const memoryTemplateSrc = path.join(templatesDir, "memory");
    if (await fs.pathExists(memoryTemplateSrc)) {
      await fs.copy(memoryTemplateSrc, path.join(targetHarnessDir, "memory"));
    }

    // 3. Scaffold sync-memory script
    const scriptsSrc = path.join(templatesDir, "scripts");
    if (await fs.pathExists(scriptsSrc)) {
      await fs.ensureDir(path.join(targetHarnessDir, "scripts"));
      await fs.copy(scriptsSrc, path.join(targetHarnessDir, "scripts"));
    }

    // 4. Scaffold .claude/settings.json hooks
    await fs.ensureDir(targetClaudeDir);
    const settingsPath = path.join(targetClaudeDir, "settings.json");
    const settingsTemplatePath = path.join(templatesDir, ".claude", "settings.json");

    if (await fs.pathExists(settingsTemplatePath)) {
      const templateSettings = await fs.readJson(settingsTemplatePath);
      if (await fs.pathExists(settingsPath)) {
        const existingSettings = await fs.readJson(settingsPath);
        existingSettings.hooks = { ...existingSettings.hooks, ...templateSettings.hooks };
        await fs.writeJson(settingsPath, existingSettings, { spaces: 2 });
        console.log("Updated existing .claude/settings.json with harness hooks.");
      } else {
        await fs.writeJson(settingsPath, templateSettings, { spaces: 2 });
        console.log("Created .claude/settings.json with harness hooks.");
      }
    } else {
      console.log("  (No .claude/settings.json template found — skipping hooks setup)");
    }

    // 5. Create default harness.config.json if absent
    const configPath = path.join(process.cwd(), "harness.config.json");
    if (!(await fs.pathExists(configPath))) {
      const defaultConfigPath = path.join(templatesDir, "harness.config.json");
      if (await fs.pathExists(defaultConfigPath)) {
        await fs.copy(defaultConfigPath, configPath);
      } else {
        // Fallback: write minimal config inline
        await fs.writeJson(configPath, {
          harnessDir: ".harness",
          promptsDir: ".harness/prompts",
          agentsDir: ".harness/agents",
          agents: {
            "backend-subagent": { scope: ["api/", "libs/shared/schema", "libs/shared/types"] },
            "frontend-subagent": { scope: ["web/", "libs/shared/ui"] },
            "distributed-subagent": { scope: ["worker/"] },
            "infra-subagent": { scope: [".github/", "nx.json", "package.json"] },
            "tester-subagent": { scope: null },
            "explorer-subagent": { scope: [] },
            "planner-subagent": { scope: [] }
          }
        }, { spaces: 2 });
      }
      console.log("Created harness.config.json");
    } else {
      console.log("harness.config.json already exists — skipping.");
    }

    // 6. Create CLAUDE.md if absent
    const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
    const claudeMdTemplatePath = path.join(templatesDir, "CLAUDE.md");
    if (!(await fs.pathExists(claudeMdPath)) && await fs.pathExists(claudeMdTemplatePath)) {
      await fs.copy(claudeMdTemplatePath, claudeMdPath);
      console.log("Created CLAUDE.md");
    }

    console.log("\nHarness initialized successfully.");
    console.log("Next steps:");
    console.log("  1. Edit harness.config.json to match your project's agent scopes");
    console.log("  2. Customize .harness/agents/*.agent.md for your stack");
    console.log("  3. Run: cortex-harness run \"your task description\"");
  });

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
