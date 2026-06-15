import fs from "fs-extra";
import path from "path";
import { spawnSync } from "child_process";
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
import { intro, outro, log, note, confirm, text } from "../helpers/ui.mjs";

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

      // Copy helpers prompt through clack now — no readline interface needed.
      const rl = null;
      const copyOpts = { yes: !!opts.yes };

      intro(
        chalk.bold.cyan("cortex-harness") +
          chalk.dim(` v${ctx.pkgVersion} · init`),
      );

      // 1. Prompts
      log.step("Scaffolding prompts");
      await copyDir(
        path.join(templatesDir, "prompts"),
        path.join(targetHarnessDir, "prompts"),
        rl,
        ".harness/prompts",
        copyOpts,
      );

      // 2. Agents
      log.step("Scaffolding agents");
      await copyDir(
        path.join(templatesDir, "agents"),
        path.join(targetHarnessDir, "agents"),
        rl,
        ".harness/agents",
        copyOpts,
      );

      // 3. Memory
      if (await fs.pathExists(path.join(templatesDir, "memory"))) {
        log.step("Scaffolding memory");
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
        log.step("Scaffolding scripts");
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
      log.step("Wiring Claude hooks");
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
          log.message(
            `${chalk.yellow("↑")} ${chalk.dim(".claude/settings.json")}  ${chalk.dim("(merged harness hooks)")}`,
          );
        } else {
          await fs.writeJson(settingsPath, templateSettings, { spaces: 2 });
          log.message(`${chalk.green("+")} ${chalk.dim(".claude/settings.json")}`);
        }
      }

      // 6. harness.config.json + CLAUDE.md — root config files
      log.step("Writing root config files");
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
        log.message(`${fileIcon(status)} ${chalk.dim("harness.config.json")}`);
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
        log.message(`${fileIcon(status)} ${chalk.dim("CLAUDE.md")}`);
      }

      // 7. .gitignore
      {
        const result = await patchGitignore(process.cwd());
        const note_ = result === "present" ? chalk.dim("  (already present)") : "";
        log.message(
          `${fileIcon(result === "present" ? "kept" : result === "appended" ? "updated" : "created")} ${chalk.dim(".gitignore")}${note_}`,
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
          log.message(`${fileIcon(label.icon)} ${chalk.dim(".mcp.json")}${label.note}`);
        }

        // Auto-scope known servers into matching agents' mcpScope
        const configPath = path.join(process.cwd(), "harness.config.json");
        if (added.length && (await fs.pathExists(configPath))) {
          const autoScoped = await autoScopeMcpServers(configPath, added);
          for (const { server, agents } of autoScoped) {
            log.message(
              `${chalk.green("↑")} ${chalk.dim(`mcpScope: ${server} → ${agents.join(", ")}`)}`,
            );
          }
        }
      }

      // 9. Surface configuration
      log.step("Surface configuration");
      const detected = await detectSurfaces(process.cwd());
      const surfaces = await confirmSurfaces(detected, rl, copyOpts);

      if (await fs.pathExists(configPath)) {
        await applySurfaces(
          configPath,
          surfaces,
          path.join(targetHarnessDir, "agents"),
        );
        log.success("harness.config.json updated");
        log.success(".harness/agents/*.agent.md scope sections patched");
      }

      const allEmpty = Object.values(surfaces).every((v) => v.length === 0);
      if (allEmpty) {
        log.warn("No surfaces configured — edit harness.config.json before running");
      } else {
        const missing = Object.entries(surfaces)
          .flatMap(([, paths]) => paths)
          .filter((p) => !fs.pathExistsSync(path.join(process.cwd(), p)));
        if (missing.length) {
          log.warn(
            "These paths don't exist yet:\n" +
              missing.map((p) => `  ${chalk.yellow(p)}`).join("\n"),
          );
        }
      }

      // 10. Dev server auto-detection
      log.step("Dev server configuration");
      const detectedDs = detectDevServerConfig(process.cwd());
      let devServerConfigured = false;

      if (detectedDs) {
        const lines = detectedDs.services.map((svc, i) => {
          const parts = [`${chalk.cyan(`[${i + 1}]`)} ${svc.command}`];
          parts.push(`    ${chalk.dim("ready:")} ${svc.readinessUrl}`);
          if (svc.cwd) parts.push(`    ${chalk.dim("cwd:")}   ${svc.cwd}`);
          return parts.join("\n");
        });
        lines.push(chalk.dim(`browser: ${detectedDs.browserUrl}`));
        note(lines.join("\n"), "Auto-detected services");

        let accept = true;
        if (!opts.yes) {
          accept = await confirm({
            message: "Write devServer to harness.config.json?",
            initialValue: true,
          });
        }

        if (accept && (await fs.pathExists(configPath))) {
          const cfg = await fs.readJson(configPath);
          cfg.devServer = {
            browserUrl: detectedDs.browserUrl,
            startupTimeoutMs: detectedDs.startupTimeoutMs,
            services: detectedDs.services,
          };
          await fs.writeJson(configPath, cfg, { spaces: 2 });
          log.success("devServer written to harness.config.json");
          devServerConfigured = true;
        } else if (!accept) {
          log.message(
            chalk.dim("Skipped — configure devServer manually in harness.config.json if needed"),
          );
        }
      } else {
        log.message(
          chalk.dim("No framework detected — configure devServer manually in harness.config.json if needed"),
        );
      }

      // 11. Auth state for smoke tests
      // Only relevant when the app already exists (dev server detected).
      // On a fresh/empty project there is nothing to authenticate against yet.
      let authAlreadyRun = false;
      if (!opts.yes && devServerConfigured) {
        log.step("Smoke test authentication");
        note(
          [
            "After each run, the harness navigates your app's pages with Playwright",
            "to confirm nothing is broken (no 404/500 errors).",
            "",
            "If your app redirects unauthenticated users to a login page,",
            "smoke checks will always see the login redirect — never the real page.",
            "They'll report no errors even when a page is actually broken.",
            "",
            `${chalk.cyan("cortex-harness auth")} saves your browser session once so that`,
            "every smoke cycle starts already logged in.",
          ].join("\n"),
          "Why this matters",
        );

        const needsAuth = await confirm({
          message: "Does your app require login to access pages?",
          initialValue: false,
        });

        if (needsAuth) {
          const cliPath = path.join(ctx.pkgRoot, "bin", "cli.mjs");
          spawnSync(process.execPath, [cliPath, "auth"], {
            stdio: "inherit",
            cwd: process.cwd(),
          });
          authAlreadyRun = true;
        } else {
          log.message(
            chalk.dim("Skipped — run `cortex-harness auth` any time you add authentication"),
          );
        }

        // Ask about additional roles/profiles
        if (needsAuth && authAlreadyRun) {
          const multiRole = await confirm({
            message: "Does your app have multiple roles or tenants that need separate sessions?",
            initialValue: false,
          });

          if (multiRole) {
            log.message(chalk.dim("Enter each role/tenant name. Leave blank when done."));
            let addingProfiles = true;
            while (addingProfiles) {
              const profileName = await text({
                message: "Role/tenant name (e.g. admin, user, tenant-a)",
                placeholder: "Leave blank to finish",
              });
              const name = (profileName ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
              if (!name) { addingProfiles = false; break; }

              log.step(`Saving auth state for profile: ${name}`);
              const cliPath = path.join(ctx.pkgRoot, "bin", "cli.mjs");
              spawnSync(process.execPath, [cliPath, "auth", "--profile", name], {
                stdio: "inherit",
                cwd: process.cwd(),
              });

              // Add to harness.config.json authProfiles
              if (await fs.pathExists(configPath)) {
                const cfg = await fs.readJson(configPath);
                if (!Array.isArray(cfg.authProfiles)) cfg.authProfiles = [];
                if (!cfg.authProfiles.find(p => p.name === name)) {
                  cfg.authProfiles.push({
                    name,
                    storageFile: `.harness/smoke-auth-${name}.json`,
                    pages: [],
                  });
                  await fs.writeJson(configPath, cfg, { spaces: 2 });
                  log.message(chalk.dim(`Added profile "${name}" to harness.config.json — set pages[] to restrict which URLs use this session.`));
                }
              }
            }
          }
        }
      }

      // Next steps — adapt based on what was actually detected
      const isFreshProject = allEmpty && !devServerConfigured;
      const nextSteps = [
        `${chalk.dim("1.")} Review ${chalk.cyan("harness.config.json")} — scope paths are set to your surfaces`,
        `${chalk.dim("2.")} Review ${chalk.cyan(".harness/agents/*.agent.md")} — Scope sections have been auto-patched`,
      ];

      if (isFreshProject) {
        nextSteps.push(
          `${chalk.dim("3.")} Build your app, then re-run ${chalk.cyan("cortex-harness init")} to configure`,
          `     surfaces, dev server, and smoke auth once your stack is in place.`,
        );
        nextSteps.push(
          `${chalk.dim("4.")} Run: ${chalk.cyan('cortex-harness run "your task description"')}`,
        );
      } else {
        let n = 3;
        if (!authAlreadyRun && devServerConfigured) {
          nextSteps.push(
            `${chalk.dim(`${n++}.`)} ${chalk.dim("(Optional)")} If your app requires login, save auth state for smoke tests:`,
            `     ${chalk.cyan("cortex-harness auth")}`,
          );
        }
        nextSteps.push(
          `${chalk.dim(`${n}.`)} Run: ${chalk.cyan('cortex-harness run "your task description"')}`,
        );
      }

      note(nextSteps.join("\n"), "Next steps");

      outro(chalk.green.bold("✓ Harness initialized successfully"));
    });
}
