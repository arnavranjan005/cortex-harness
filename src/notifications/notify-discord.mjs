import { logger } from "../logger.mjs";
function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    parsed[key.slice(2)] = argv[i + 1] ?? '';
    i++;
  }

  return parsed;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function cleanLine(text) {
  return String(text ?? '')
    .replace(/\r/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDiscordContent(title, message, meta = {}) {
  const lines = [`**${cleanLine(title)}**`, cleanLine(message)];

  if (meta.task) {
    lines.push(`Task: ${truncate(cleanLine(meta.task), 160)}`);
  }

  if (meta.cycleId) {
    const cycleLabel = meta.cycleType
      ? `${meta.cycleId} (${meta.cycleType})`
      : meta.cycleId;
    lines.push(`Cycle: \`${cycleLabel}\``);
  }

  if (Array.isArray(meta.batchIds) && meta.batchIds.length) {
    lines.push(`Batch: ${meta.batchIds.map((id) => `\`${id}\``).join(', ')}`);
  }

  if (typeof meta.attempt === 'number') {
    lines.push(`Attempt: ${meta.attempt}`);
  }

  if (typeof meta.nextAttempt === 'number') {
    lines.push(`Next attempt: ${meta.nextAttempt}`);
  }

  if (typeof meta.turnCount === 'number') {
    lines.push(`Turns: ${meta.turnCount}`);
  }

  if (typeof meta.totalSpentUsd === 'number') {
    lines.push(`Spent: $${meta.totalSpentUsd.toFixed(2)}`);
  }

  if (typeof meta.done === 'number') {
    lines.push(
      `Queue: done ${meta.done}, partial ${meta.partial ?? 0}, blocked ${meta.blocked ?? 0}, pending ${meta.pending ?? 0}`,
    );
  }

  return truncate(lines.filter(Boolean).join('\n'), 1800);
}

export async function sendDiscordNotification({
  webhookUrl,
  title,
  message,
  meta = {},
}) {
  const url = webhookUrl || process.env.HARNESS_DISCORD_WEBHOOK_URL;
  if (!url) {
    throw new Error('Discord webhook URL is required.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: buildDiscordContent(title, message, meta),
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Discord webhook responded ${response.status}: ${truncate(body, 200)}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const meta = args['meta-json'] ? JSON.parse(args['meta-json']) : {};

  await sendDiscordNotification({
    webhookUrl: args.webhook,
    title: args.title ?? 'Claude Harness',
    message: args.message ?? 'Notification',
    meta,
  });
}

// Cross-platform main-module check. The URL-comparison approach breaks on
// Windows because process.argv[1] uses backslashes while import.meta.url uses
// forward slashes and percent-encodes spaces, so the strings never match.
import { fileURLToPath } from 'url';
import { resolve } from 'path';
const _isMain =
  process.argv[1] != null &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (_isMain) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
