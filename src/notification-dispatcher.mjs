import { logger } from "./logger.mjs";
﻿import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  getDiscordRegistrations,
  readNotificationConfig,
} from "./notification-config.mjs";
import { sendWindowsNotification } from "./notifications/notification-windows.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NOTIFY_DISCORD_SCRIPT = join(__dirname, "notifications", "notify-discord.mjs");
let hasWarnedAboutConfig = false;

function warn(message, onWarning) {
  if (typeof onWarning === "function") {
    onWarning(message);
    return;
  }
  logger.warn(message);
}

export function dispatchNotification({ title, message, meta = {}, onWarning }) {
  const { exists, valid, config, error } = readNotificationConfig();

  if (exists && !valid && !hasWarnedAboutConfig) {
    warn(`Notification config is invalid: ${error}`, onWarning);
    hasWarnedAboutConfig = true;
  }

  const channels = config?.channels ?? {};

  // 1. Windows Notifications
  if (channels.windows?.enabled) {
    sendWindowsNotification({ title, message, meta }).then((result) => {
      if (result && !result.ok) warn(`Windows notification failed: ${result.error}`, onWarning);
    }).catch((err) => {
      warn(`Windows notification failed: ${err.message}`, onWarning);
    });
  }

  // 2. Discord Notifications
  const discordRegistrations = getDiscordRegistrations(config);
  for (const reg of discordRegistrations) {
    if (!reg.enabled || !reg.webhookUrl) continue;

    const metaJson = JSON.stringify(meta);
    const args = [
      NOTIFY_DISCORD_SCRIPT,
      "--webhook", reg.webhookUrl,
      "--title", title,
      "--message", message,
      "--meta-json", metaJson,
    ];

    const proc = spawn("node", args, { stdio: "ignore", detached: true });
    proc.unref();
  }
}

