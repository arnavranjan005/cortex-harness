import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const ROOT = process.cwd();
const HARNESS_DIR = join(ROOT, ".harness");
export const NOTIFICATION_CONFIG_FILE = join(HARNESS_DIR, "notification-channels.local.json");

export function createEmptyNotificationConfig() {
  return { version: 1, channels: {} };
}

export function readNotificationConfig() {
  if (!existsSync(NOTIFICATION_CONFIG_FILE)) {
    return { exists: false, valid: true, config: createEmptyNotificationConfig() };
  }
  try {
    const raw = JSON.parse(readFileSync(NOTIFICATION_CONFIG_FILE, "utf8"));
    return { exists: true, valid: true, config: raw };
  } catch (error) {
    return { exists: true, valid: false, config: createEmptyNotificationConfig(), error: error.message };
  }
}

export function writeNotificationConfig(config) {
  mkdirSync(dirname(NOTIFICATION_CONFIG_FILE), { recursive: true });
  writeFileSync(NOTIFICATION_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function getDiscordRegistrations(config) {
  const discord = config?.channels?.discord;
  if (!discord) return [];
  return Array.isArray(discord) ? discord : [discord];
}

export function validateDiscordWebhookUrl(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return { valid: false, error: "Webhook URL is required." };
  if (
    !trimmed.startsWith("https://discord.com/api/webhooks/") &&
    !trimmed.startsWith("https://discordapp.com/api/webhooks/")
  ) {
    return { valid: false, error: "URL must start with https://discord.com/api/webhooks/..." };
  }
  return { valid: true, webhookUrl: trimmed };
}

export function redactWebhook(url) {
  if (!url) return "(none)";
  const parts = url.split("/");
  if (parts.length < 2) return url.slice(0, 20) + "...";
  return parts.slice(0, -1).join("/") + "/***";
}

