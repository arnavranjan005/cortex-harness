import fs from "fs-extra";
import path from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";
import { mergeMcpConfig, autoScopeMcpServers } from "../helpers/mcp-config.mjs";
import { patchGitignore } from "../helpers/gitignore.mjs";
import { fileIcon, copyFile, copyDir } from "../helpers/fs-utils.mjs";
import {
  detectSurfaces,
  confirmSurfaces,
  applySurfaces,
} from "../helpers/surfaces.mjs";
import { detectDevServerConfig } from "../../engine/process-utils.mjs";

// ctx: { pkgRoot, pkgVersion }
export function registerInitCommand(program, ctx) {
  program
    .command("init")
    .description(
      "Initialize the harness and lifecycle hooks in the current project",
    )
    .option("-y, --yes", "accept all defaults, skip interactive prompts")
    .action(async (opts) => {
      const targetHarnessDir = path.join(process.cwd(), ".harness");
      const targetClaudeDir = path.join(process.cwd(), ".claude");
      const templatesDir = path.join(ctx.pkgRoot, "templates");

      const rl = createInterface({ input, output });

      const W = Math.min(process.stdout.columns || 72, 72);
      const line = chalk.dim("─".repeat(W));

      console.log();
      console.log(
        chalk.bold.cyan("  cortex-harness") +
          chalk.dim(` v${ctx.pkgVersion}  —  init`),
      );
      console.log(line);

      function section(label) {
        console.log("\n" + chalk.bold(`  ${label}`));
      }

      const copyOpts = { yes: !!opts.yes };

      // 1. Prompts
      section("Scaffolding prompts");
      await copyDir(
        path.join(templatesDir, "prompts"),
        path.join(targetHarnessDir, "prompts"),
        rl,
        ".harness/prompts",
        copyOpts,
      );

      // 2. Agents
      section("Scaffolding agents");
      await copyDir(
        path.join(templatesDir, "agents"),
        path.join(targetHarnessDir, "agents"),
        rl,
        ".harness/agents",
        copyOpts,
      );

      // 3. Memory
      if (await fs.pathExists(path.join(templatesDir, "memory"))) {
        section("Scaffolding memory");
        await copyDir(
          path.join(templatesDir, "memory"),
          path.join(targetHarnessDir, "memory"),
          rl,
          ".harness/memory",
          copyOpts,
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
          copyOpts,
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
          copyOpts,
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
          copyOpts,
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

      // 8. MCP registration — additive-only, never overwrites user entries
      {
        const { status: mcpStatus, added } = await mergeMcpConfig(templatesDir, process.cwd());
        const mcpLabels = {
          created: { icon: "created", note: "" },
          merged: { icon: "updated", note: chalk.dim(`  (added: ${added.join(", ")})`) },
          present: { icon: "kept", note: chalk.dim("  (already registered)") },
          absent: null,
        };
        const label = mcpLabels[mcpStatus];
        if (label) {
          console.log(`  ${fileIcon(label.icon)} ${chalk.dim(".mcp.json")}${label.note}`);
        }

        // Auto-scope known servers into matching agents' mcpScope
        const configPath = path.join(process.cwd(), "harness.config.json");
        if (added.length && (await fs.pathExists(configPath))) {
          const autoScoped = await autoScopeMcpServers(configPath, added);
          for (const { server, agents } of autoScoped) {
            console.log(
              `  ${chalk.green("↑")} ${chalk.dim(`mcpScope: ${server} → ${agents.join(", ")}`)}`,
            );
          }
        }
      }

      // 9. Surface configuration
      console.log("\n" + line);
      console.log(chalk.bold("  Surface configuration"));
      console.log(line);
      const detected = await detectSurfaces(process.cwd());
      const surfaces = await confirmSurfaces(detected, rl, copyOpts);

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

      // 10. Dev server auto-detection
      console.log("\n" + line);
      console.log(chalk.bold("  Dev server configuration"));
      console.log(line);
      const detectedDs = detectDevServerConfig(process.cwd());

      if (detectedDs) {
        console.log(`  ${chalk.dim("Auto-detected services:")}`);
        detectedDs.services.forEach((svc, i) => {
          console.log(`    ${chalk.cyan(`[${i + 1}]`)} ${svc.command}`);
          console.log(`         ${chalk.dim("ready:")} ${svc.readinessUrl}`);
          if (svc.cwd) console.log(`         ${chalk.dim("cwd:")}   ${svc.cwd}`);
        });
        console.log(`    ${chalk.dim(`browser: ${detectedDs.browserUrl}`)}`);

        let accept = true;
        if (!opts.yes) {
          const ans = await rl.question(`\n  Write devServer to harness.config.json? ${chalk.dim("[Y/n]")} `);
          accept = !ans.trim() || ans.trim().toLowerCase() === "y";
        }

        if (accept && await fs.pathExists(configPath)) {
          const cfg = await fs.readJson(configPath);
          cfg.devServer = {
            browserUrl: detectedDs.browserUrl,
            startupTimeoutMs: detectedDs.startupTimeoutMs,
            services: detectedDs.services,
          };
          await fs.writeJson(configPath, cfg, { spaces: 2 });
          console.log(`\n  ${chalk.green("✓")} devServer written to harness.config.json`);
        } else if (!accept) {
          console.log(`  ${chalk.dim("Skipped — configure devServer manually in harness.config.json if needed")}`);
        }
      } else {
        console.log(
          `  ${chalk.dim("No framework detected — configure devServer manually in harness.config.json if needed")}`,
        );
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
}
