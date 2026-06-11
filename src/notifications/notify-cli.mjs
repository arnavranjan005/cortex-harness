import {
  createEmptyNotificationConfig,
  NOTIFICATION_CONFIG_FILE,
  readNotificationConfig,
  redactWebhook,
  validateDiscordWebhookUrl,
  writeNotificationConfig,
} from '../notification-config.mjs';
import { sendDiscordNotification } from './notify-discord.mjs';
import { sendWindowsNotification } from './notification-windows.mjs';
import { confirm as uiConfirm, text as uiText } from '../cli/helpers/ui.mjs';

function printHelp() {
  console.log('Harness notification channels');
  console.log('');
  console.log('Commands:');
  console.log('  npm run harness:notify -- help');
  console.log('  npm run harness:notify -- register windows');
  console.log('  npm run harness:notify -- register discord');
  console.log('  npm run harness:notify -- list');
  console.log('  npm run harness:notify -- test windows');
  console.log('  npm run harness:notify -- test discord');
  console.log('  npm run harness:notify -- unregister windows');
  console.log('  npm run harness:notify -- unregister discord');
  console.log('');
  console.log('Windows setup:');
  console.log('  1. Run `npm run harness:notify -- register windows`.');
  console.log('  2. A test toast will be sent before the channel is enabled.');
  console.log('');
  console.log('Discord setup:');
  console.log('  1. Open your Discord server and choose the text channel for harness alerts.');
  console.log('  2. Open Channel Settings or Server Settings, then go to Integrations -> Webhooks.');
  console.log('  3. Click Create Webhook / New Webhook and confirm the channel is the one you want.');
  console.log('  4. Copy the generated webhook URL.');
  console.log('  5. Run `npm run harness:notify -- register discord` and paste the full URL when prompted.');
  console.log('  6. Enter a short display name for the channel (example: ops, alerts, team-a).');
  console.log('  7. The CLI sends a test message first, then saves the webhook only if you confirm.');
  console.log('  8. Run register discord again to add more Discord channels.');
  console.log('  9. Run `npm run harness:notify -- unregister discord` and choose the channel to remove.');
  console.log('  10. `npm run harness:notify -- test discord` sends a test message to every enabled Discord channel.');
  console.log('');
  console.log('Fallback behavior:');
  console.log(
    `  If ${NOTIFICATION_CONFIG_FILE.split(/[/\\]/).slice(-2).join('/')} does not exist yet, the harness keeps the current Windows-only fallback notifications.`,
  );
}

function getConfig() {
  const state = readNotificationConfig();
  if (!state.valid) {
    throw new Error(
      `Notification config is invalid: ${state.error}. Remove or fix ${NOTIFICATION_CONFIG_FILE}.`,
    );
  }

  return state.exists ? state.config : createEmptyNotificationConfig();
}

function saveConfig(config) {
  writeNotificationConfig(config);
}

function getDiscordRegistrations(config) {
  const value = config.channels.discord;
  return Array.isArray(value) ? value : [];
}

function setDiscordRegistrations(config, registrations) {
  config.channels.discord = registrations;
}

async function confirm(question) {
  return uiConfirm({ message: question, initialValue: false });
}

async function prompt(question) {
  const answer = await uiText({ message: question.replace(/:\s*$/, "") });
  return (answer ?? "").trim();
}

async function registerWindows() {
  console.log('Registering Windows notifications for the harness.');
  console.log('A test toast will be sent now.');

  const result = await sendWindowsNotification({
    title: 'Claude Harness',
    message: 'Windows notification channel test',
  });

  if (!result.ok) {
    throw new Error(`Windows test notification failed: ${result.error}.`);
  }

  if (!(await confirm('Enable Windows notifications for future harness runs?'))) {
    console.log('Windows registration cancelled.');
    return;
  }

  const config = getConfig();
  config.channels.windows = { enabled: true };
  saveConfig(config);
  console.log(
    `Windows notifications enabled. Config saved to ${NOTIFICATION_CONFIG_FILE}.`,
  );
}

async function testDiscordWithWebhook(webhookUrl) {
  await sendDiscordNotification({
    webhookUrl,
    title: 'Claude Harness',
    message: 'Discord notification channel test',
    meta: {
      task: 'Notification channel verification',
    },
  });
}

async function registerDiscord() {
  console.log('Registering Discord notifications for the harness.');
  console.log(
    'Discord webhooks are tied to one text channel. Create one in your server, then paste the generated URL here.',
  );
  console.log(
    'Recommended path: Server Settings -> Integrations -> Webhooks -> Create Webhook -> choose the channel -> copy URL.',
  );

  const labelInput = await prompt('Display name for this Discord channel: ');
  const label = labelInput.trim() || `discord-${Date.now().toString().slice(-4)}`;
  const webhookInput = await prompt('Discord webhook URL: ');
  const validation = validateDiscordWebhookUrl(webhookInput);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  console.log(
    `Sending a test Discord message to ${label} (${redactWebhook(validation.webhookUrl)})...`,
  );
  await testDiscordWithWebhook(validation.webhookUrl);

  if (!(await confirm('Enable Discord notifications for future harness runs?'))) {
    console.log('Discord registration cancelled.');
    return;
  }

  const config = getConfig();
  const registrations = getDiscordRegistrations(config);
  registrations.push({
    id: `${label}-${registrations.length + 1}`,
    label,
    enabled: true,
    webhookUrl: validation.webhookUrl,
  });
  setDiscordRegistrations(config, registrations);
  saveConfig(config);
  console.log(
    `Discord notifications enabled for ${label} (${redactWebhook(validation.webhookUrl)}). Config saved to ${NOTIFICATION_CONFIG_FILE}.`,
  );
}

function listChannels() {
  const state = readNotificationConfig();

  if (!state.exists) {
    console.log('No notification registry found.');
    console.log(
      'Fallback: the harness will keep using the current Windows-only notifications until you register channels.',
    );
    return;
  }

  if (!state.valid) {
    console.log(`Notification config is invalid: ${state.error}`);
    console.log(`File: ${NOTIFICATION_CONFIG_FILE}`);
    return;
  }

  const windows = state.config.channels.windows;
  const discord = getDiscordRegistrations(state.config);

  console.log(`Config: ${NOTIFICATION_CONFIG_FILE}`);
  console.log(`Windows: ${windows?.enabled ? 'enabled' : 'disabled'}`);
  if (!discord.length) {
    console.log('Discord: none registered');
  } else {
    console.log('Discord:');
    discord.forEach((entry, index) => {
      console.log(
        `  ${index + 1}. ${entry.label ?? entry.id} — ${entry.enabled ? 'enabled' : 'disabled'} (${redactWebhook(entry.webhookUrl)})`,
      );
    });
  }
}

async function testWindows() {
  const result = await sendWindowsNotification({
    title: 'Claude Harness',
    message: 'Windows notification test',
  });

  if (!result.ok) {
    throw new Error(`Windows notification test failed: ${result.error}`);
  }

  console.log('Windows notification test sent.');
}

async function testDiscord() {
  const state = readNotificationConfig();
  const registrations = state.exists && state.valid ? getDiscordRegistrations(state.config) : [];

  if (!registrations.length) {
    console.log(
      'No registered Discord webhook found. This is a one-off test and nothing will be saved unless you register first.',
    );
    const webhookInput = await prompt('Discord webhook URL: ');
    const validation = validateDiscordWebhookUrl(webhookInput);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    await testDiscordWithWebhook(validation.webhookUrl);
    console.log('Discord notification test sent.');
    return;
  }

  const enabledRegistrations = registrations.filter((entry) => entry.enabled && entry.webhookUrl);
  if (!enabledRegistrations.length) {
    console.log('No enabled Discord registrations found to test.');
    return;
  }
  console.log(`Testing ${enabledRegistrations.length} enabled Discord registration(s)...`);
  const settled = await Promise.allSettled(
    enabledRegistrations
      .map((entry) =>
        testDiscordWithWebhook(entry.webhookUrl).then(() => ({
          label: entry.label ?? entry.id,
          webhook: redactWebhook(entry.webhookUrl),
        })),
      ),
  );

  settled.forEach((result, index) => {
    const entry = enabledRegistrations[index];
    const label = entry?.label ?? entry?.id ?? `discord-${index + 1}`;
    if (result.status === 'fulfilled') {
      console.log(`  OK: ${label} (${redactWebhook(entry.webhookUrl)})`);
    } else {
      console.log(`  FAIL: ${label} (${redactWebhook(entry.webhookUrl)}) - ${result.reason?.message ?? String(result.reason)}`);
    }
  });

  console.log('Discord notification test complete.');
}

async function unregisterChannel(channel) {
  const config = getConfig();

  if (channel !== 'discord') {
    if (!config.channels[channel]) {
      console.log(`${channel} is not registered.`);
      return;
    }

    delete config.channels[channel];
    saveConfig(config);
    console.log(`${channel} notifications unregistered.`);
    return;
  }

  const registrations = getDiscordRegistrations(config);
  if (!registrations.length) {
    console.log(`${channel} is not registered.`);
    return;
  }

  registrations.forEach((entry, index) => {
    console.log(`  ${index + 1}. ${entry.label ?? entry.id} (${redactWebhook(entry.webhookUrl)})`);
  });

  const selection = await prompt('Remove which Discord channel? Enter number or exact label/id: ');
  const trimmed = selection.trim();
  const selectedIndex = Number.parseInt(trimmed, 10);
  const target =
    Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= registrations.length
      ? registrations[selectedIndex - 1]
      : registrations.find(
          (entry) => entry.id === trimmed || entry.label === trimmed,
        );

  if (!target) {
    console.log('No matching Discord registration found. Nothing changed.');
    return;
  }

  const remaining = registrations.filter((entry) => entry.id !== target.id);
  setDiscordRegistrations(config, remaining);
  saveConfig(config);
  console.log(`Discord registration removed: ${target.label ?? target.id}.`);
}

async function main() {
  const [command = 'help', channel] = process.argv.slice(2);

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'list') {
    listChannels();
    return;
  }

  if (command === 'register' && channel === 'windows') {
    await registerWindows();
    return;
  }

  if (command === 'register' && channel === 'discord') {
    await registerDiscord();
    return;
  }

  if (command === 'test' && channel === 'windows') {
    await testWindows();
    return;
  }

  if (command === 'test' && channel === 'discord') {
    await testDiscord();
    return;
  }

  if (
    command === 'unregister' &&
    (channel === 'windows' || channel === 'discord')
  ) {
    await unregisterChannel(channel);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
