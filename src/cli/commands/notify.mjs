import path from "path";
import { spawn } from "child_process";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";
import {
  createEmptyNotificationConfig,
  getDiscordRegistrations,
  NOTIFICATION_CONFIG_FILE,
  readNotificationConfig,
  redactWebhook,
  validateDiscordWebhookUrl,
  writeNotificationConfig,
} from "../../notification-config.mjs";
import { sendWindowsNotification } from "../../notifications/notification-windows.mjs";
import { sendDiscordNotification } from "../../notifications/notify-discord.mjs";

// ctx: { pkgRoot }
export function registerNotifySetupCommand(program) {
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
}

// ctx: { pkgRoot }
export function registerNotifyCommand(program, ctx) {
  program
    .command("notify [subcommand] [channel]")
    .description(
      "Manage notification channels: register, test, list, unregister (see `notify help`)",
    )
    .allowUnknownOption()
    .action((subcommand, channel) => {
      const notifyCliPath = path.join(
        ctx.pkgRoot,
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
}
