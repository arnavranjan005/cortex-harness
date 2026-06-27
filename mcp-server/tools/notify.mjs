import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.mjs');

function driveInteractiveCli(cwd, args, steps, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let stepIdx = 0;
    let settled = false;

    const settle = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    const advance = () => {
      while (stepIdx < steps.length && output.includes(steps[stepIdx].waitFor)) {
        proc.stdin.write(steps[stepIdx].send + '\n');
        stepIdx++;
      }
    };

    proc.stdout.on('data', chunk => { output += chunk.toString(); advance(); });
    proc.stderr.on('data', chunk => { output += chunk.toString(); });
    proc.on('error', err => settle(() => reject(err)));
    proc.on('exit', code => settle(() => {
      if (code !== 0) reject(new Error(`exit ${code}:\n${output.trim()}`));
      else resolve(output.trim());
    }));

    const timer = setTimeout(() => {
      proc.kill();
      settle(() => reject(new Error(`Timed out waiting for prompt.\nOutput so far:\n${output.trim()}`)));
    }, timeoutMs);
  });
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

const EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

export const notifyTools = [
  {
    name: 'cortex_notify_list',
    description: 'List configured notification channels. Discord webhook URLs are redacted — never shown in full.',
    inputSchema: {
      type: 'object',
      properties: { workspaceRoot: { type: 'string' } },
    },
    async handler({ workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      try {
        const result = execFileSync(process.execPath, [CLI, 'notify', 'list'], { ...EXEC_OPTS, cwd });
        return ok(result.trim());
      } catch (err) {
        const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
        return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_notify_discord_add',
    description: 'Add a Discord webhook channel. The URL is stored in .harness/notification-channels.local.json and never echoed back.',
    inputSchema: {
      type: 'object',
      required: ['webhookUrl'],
      properties: {
        webhookUrl: { type: 'string', description: 'Discord webhook URL (https://discord.com/api/webhooks/...)' },
        label: { type: 'string', description: 'Display name for this channel (e.g. "ops", "alerts").' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ webhookUrl, label, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      const channelLabel = (label ?? '').trim() || `discord-${Date.now().toString().slice(-4)}`;
      try {
        const result = await driveInteractiveCli(cwd, ['notify', 'register', 'discord'], [
          { waitFor: 'Display name for this Discord channel:', send: channelLabel },
          { waitFor: 'Discord webhook URL:', send: webhookUrl },
          { waitFor: '(y/n):', send: 'y' },
        ]);
        return ok(result);
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_notify_discord_remove',
    description: 'Remove a Discord channel by label from the notification config.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string', description: 'Channel label to remove.' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ label, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      try {
        const result = await driveInteractiveCli(cwd, ['notify', 'unregister', 'discord'], [
          { waitFor: 'Enter number or exact label/id:', send: label },
        ]);
        return ok(result);
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_notify_windows_toggle',
    description: 'Enable or disable Windows toast notifications.',
    inputSchema: {
      type: 'object',
      required: ['enabled'],
      properties: {
        enabled: { type: 'boolean', description: 'true to enable, false to disable.' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ enabled, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      if (!enabled) {
        try {
          const result = execFileSync(process.execPath, [CLI, 'notify', 'unregister', 'windows'], { ...EXEC_OPTS, cwd });
          return ok(result.trim() || 'Windows toast notifications disabled.');
        } catch (err) {
          const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
          return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
        }
      }
      try {
        const result = await driveInteractiveCli(cwd, ['notify', 'register', 'windows'], [
          { waitFor: '(y/n):', send: 'y' },
        ]);
        return ok(result || 'Windows toast notifications enabled.');
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_notify_test',
    description: 'Send a test notification to verify all enabled channels are working.',
    inputSchema: {
      type: 'object',
      properties: { workspaceRoot: { type: 'string' } },
    },
    async handler({ workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      try {
        const result = execFileSync(process.execPath, [CLI, 'notify', 'test'], { ...EXEC_OPTS, cwd });
        return ok(result.trim() || 'Test notification sent to all enabled channels.');
      } catch (err) {
        const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
        return { content: [{ type: 'text', text: `Test failed:\n${detail}` }], isError: true };
      }
    },
  },
];
