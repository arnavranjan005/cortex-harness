import path from "path";
import { spawn } from "child_process";
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
import {
  intro,
  outro,
  note,
  log,
  spinner,
  confirm,
  text,
} from "../helpers/ui.mjs";

// ctx: { pkgRoot }
export function registerNotifySetupCommand(program) {
  program
    .command("notify-setup")
    .description(
      "Interactive wizard to configure notification channels (Windows toast, Discord webhook)",
    )
    .action(async () => {
      intro(chalk.bold.cyan("Notification channel setup"));
      log.message(chalk.dim(`Config file: ${NOTIFICATION_CONFIG_FILE}`));

      const state = readNotificationConfig();
      if (!state.valid) {
        log.warn(
          `Existing config is invalid: ${state.error}\nIt will be overwritten if you proceed.`,
        );
      }

      const config =
        state.exists && state.valid
          ? state.config
          : createEmptyNotificationConfig();
      let dirty = false;

      // ── Windows ──────────────────────────────────────────────────────────────
      const windowsEnabled = config.channels?.windows?.enabled;
      if (process.platform === "win32") {
        const setup = await confirm({
          message: `Set up Windows toast notifications? (currently ${windowsEnabled ? "enabled" : "disabled"})`,
          initialValue: false,
        });
        if (setup) {
          const s = spinner();
          s.start("Sending test toast");
          const result = await sendWindowsNotification({
            title: "Claude Harness",
            message: "Notification setup test",
          });
          if (!result.ok) {
            s.stop("Toast failed", 1);
            log.error(result.error);
            log.warn("Windows notifications were NOT enabled.");
          } else {
            s.stop("Test toast sent");
            config.channels.windows = { enabled: true };
            dirty = true;
            log.success("Windows notifications enabled.");
          }
        } else if (windowsEnabled) {
          const disable = await confirm({
            message: "Disable Windows notifications?",
            initialValue: false,
          });
          if (disable) {
            config.channels.windows = { enabled: false };
            dirty = true;
            log.warn("Windows notifications disabled.");
          }
        }
      } else {
        log.message(
          chalk.dim("Windows notifications: not available on this platform."),
        );
      }

      // ── Discord ───────────────────────────────────────────────────────────────
      const existing = getDiscordRegistrations(config);
      if (existing.length) {
        note(
          existing
            .map(
              (r, i) =>
                `${i + 1}. ${r.label ?? r.id} — ${r.enabled ? chalk.green("enabled") : chalk.dim("disabled")} (${redactWebhook(r.webhookUrl)})`,
            )
            .join("\n"),
          "Registered Discord channels",
        );
      }

      const addDiscord = await confirm({
        message: "Add a Discord webhook channel?",
        initialValue: false,
      });
      if (addDiscord) {
        const labelInput = await text({
          message: "Display name for this channel",
          placeholder: "e.g. ops, alerts",
        });
        const label =
          (labelInput ?? "").trim() ||
          `discord-${Date.now().toString().slice(-4)}`;
        const webhookInput = await text({
          message: "Discord webhook URL",
          validate: (v) => {
            const res = validateDiscordWebhookUrl(v);
            return res.valid ? undefined : res.error;
          },
        });
        const validation = validateDiscordWebhookUrl(webhookInput);
        if (!validation.valid) {
          log.error(`Invalid URL: ${validation.error}`);
          log.warn("Discord channel was NOT added.");
        } else {
          const s = spinner();
          s.start(`Sending test message to ${label}`);
          try {
            await sendDiscordNotification({
              webhookUrl: validation.webhookUrl,
              title: "Claude Harness",
              message: "Notification setup test",
              meta: { task: "Notification channel verification" },
            });
            s.stop(`Test message sent (${redactWebhook(validation.webhookUrl)})`);
            const enable = await confirm({
              message: "Enable this channel?",
              initialValue: false,
            });
            if (enable) {
              const registrations = getDiscordRegistrations(config);
              registrations.push({
                id: `${label}-${registrations.length + 1}`,
                label,
                enabled: true,
                webhookUrl: validation.webhookUrl,
              });
              config.channels.discord = registrations;
              dirty = true;
              log.success(`Discord channel "${label}" added.`);
            } else {
              log.message(chalk.dim("Discord channel not saved."));
            }
          } catch (err) {
            s.stop("Discord test failed", 1);
            log.error(err.message);
            log.warn("Channel was NOT added.");
          }
        }
      }

      if (dirty) {
        writeNotificationConfig(config);
        log.success(`Config saved to ${NOTIFICATION_CONFIG_FILE}`);
      } else {
        log.message(chalk.dim("No changes made."));
      }

      outro(
        chalk.dim(
          "`cortex-harness notify list` to review channels · `notify-setup` to add more",
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
