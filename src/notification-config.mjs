import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// In a real npx tool, we would want these to be configurable.
// For now, we assume standard locations relative to CWD.
const ROOT = process.cwd();
const HARNESS_DIR = join(ROOT, ".harness");
const NOTIFICATION_CONFIG_FILE = join(HARNESS_DIR, "notification-channels.local.json");

const ALLOWED_CHANNELS = new Set(["windows", "discord"]);

export function createEmptyNotificationConfig() {
  return { version: 1, channels: {} };
}

export function readNotificationConfig() {
  if (!existsSync(NOTIFICATION_CONFIG_FILE)) {
    return { exists: false, valid: true, config: createEmptyNotificationConfig() };
  }
  try {
    const raw = JSON.parse(readFileSync(NOTIFICATION_CONFIG_FILE, "utf8"));
    return { exists: true, valid: true, config: raw }; // Simplification for now
  } catch (error) {
    return { exists: true, valid: false, config: createEmptyNotificationConfig(), error: error.message };
  }
}

export function getDiscordRegistrations(config) {
  const discord = config?.channels?.discord;
  if (!discord) return [];
  return Array.isArray(discord) ? discord : [discord];
}

