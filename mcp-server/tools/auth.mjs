import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs-extra';
import path from 'path';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.mjs');

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

// Module-level state — persists across tool calls because the MCP server
// process stays alive for the entire Claude session.
const activeSessions = new Map(); // profileName → ChildProcess

export const authTools = [
  {
    name: 'cortex_auth_list',
    description: 'List auth profiles from harness.config.json. Returns name and storageFile — no credentials are stored.',
    inputSchema: {
      type: 'object',
      properties: { workspaceRoot: { type: 'string' } },
    },
    async handler({ workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      const configPath = path.join(cwd, 'harness.config.json');
      if (!await fs.pathExists(configPath)) {
        return { content: [{ type: 'text', text: 'harness.config.json not found.' }], isError: true };
      }
      const cfg = await fs.readJson(configPath);
      const profiles = cfg.authProfiles ?? [];
      if (!profiles.length) return ok('No auth profiles configured.');
      const lines = await Promise.all(profiles.map(async p => {
        const exists = await fs.pathExists(path.join(cwd, p.storageFile));
        return `  - ${p.name}  →  ${p.storageFile}  ${exists ? '✔ session file exists' : '✘ session file missing'}`;
      }));
      return ok(`Auth profiles (${profiles.length}):\n${lines.join('\n')}`);
    },
  },

  {
    name: 'cortex_auth_start',
    description: 'Open a browser to the app login page to capture an auth session. Returns once the browser is open and waiting. Call cortex_auth_finish after the user has logged in.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Profile name (e.g. "default", "admin"). Defaults to "default".' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ name = 'default', workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();

      if (activeSessions.has(name)) {
        return ok(`Auth session for "${name}" already in progress. Call cortex_auth_finish to complete it.`);
      }

      // Sync timeout with devServer.startupTimeoutMs from harness.config.json,
      // plus 30s buffer for browser launch after servers are ready.
      let startupTimeoutMs = 120_000;
      try {
        const cfg = await fs.readJson(path.join(cwd, 'harness.config.json'));
        startupTimeoutMs = cfg.devServer?.startupTimeoutMs ?? 120_000;
      } catch { /* no config — use default */ }
      const browserTimeoutMs = startupTimeoutMs + 30_000;

      const proc = spawn(process.execPath, [CLI, 'auth', '--profile', name], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
      });

      let startupError = null;
      proc.on('error', err => { startupError = err; });

      // Wait for the readline "press Enter" prompt — signals browser is open and ready
      await new Promise((resolve, reject) => {
        let output = '';
        const onData = (chunk) => {
          output += chunk.toString();
          if (
            output.includes('press Enter') ||
            output.includes('Logged in?') ||
            output.includes('Log in')
          ) {
            proc.stdout.off('data', onData);
            resolve();
          }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', chunk => { output += chunk.toString(); });
        proc.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Auth process exited early (code ${code}).\n${output}`));
          else resolve();
        });
        setTimeout(() => reject(new Error(`Timed out waiting for browser to open (${browserTimeoutMs / 1000}s). Is cortex-harness installed and @playwright/mcp configured in .mcp.json?`)), browserTimeoutMs);
      });

      if (startupError) {
        return { content: [{ type: 'text', text: `Failed to start auth: ${startupError.message}` }], isError: true };
      }

      // Auto-clean the Map if the process dies unexpectedly (crash, user closes browser, etc.)
      proc.on('exit', () => {
        if (activeSessions.get(name) === proc) activeSessions.delete(name);
      });

      activeSessions.set(name, proc);

      return ok(`Browser is open and waiting for login.\n\nLog in completely (including any SSO, OAuth redirects, or MFA), then call cortex_auth_finish to save the session.`);
    },
  },

  {
    name: 'cortex_auth_finish',
    description: 'Complete or cancel the auth session started by cortex_auth_start. Pass cancel: true to abort without saving.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Profile name passed to cortex_auth_start. Defaults to "default".' },
        cancel: { type: 'boolean', description: 'If true, kill the browser process without saving the session.' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ name = 'default', cancel = false } = {}) {
      const proc = activeSessions.get(name);
      if (!proc) {
        return { content: [{ type: 'text', text: `No active auth session for "${name}". Call cortex_auth_start first.` }], isError: true };
      }

      // Guard: process may have already exited (crash, user closed browser)
      if (proc.exitCode !== null) {
        activeSessions.delete(name);
        return { content: [{ type: 'text', text: `Auth process for "${name}" already exited (code ${proc.exitCode}). Call cortex_auth_start to try again.` }], isError: true };
      }

      if (cancel) {
        proc.kill('SIGTERM');
        activeSessions.delete(name);
        return ok(`Auth session for "${name}" cancelled — browser closed, nothing saved.`);
      }

      // Send Enter — tells cortex-harness auth to save the session and close the browser
      const enter = process.platform === 'win32' ? '\r\n' : '\n';
      proc.stdin.write(enter);

      const code = await new Promise((resolve) => {
        proc.on('exit', (c) => resolve(c ?? 0));
        setTimeout(() => resolve(-1), 30_000);
      });

      activeSessions.delete(name);

      if (code !== 0 && code !== null) {
        return { content: [{ type: 'text', text: `Session save failed (exit ${code}). Check that @playwright/mcp is configured in .mcp.json with --caps=storage.` }], isError: true };
      }

      return ok(`Session saved to .harness/smoke-auth-${name}.json and registered in harness.config.json.\n\nThis profile will be used automatically in smoke cycles.`);
    },
  },

  {
    name: 'cortex_auth_remove',
    description: 'Remove an auth profile entry from harness.config.json by name.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ name, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      const configPath = path.join(cwd, 'harness.config.json');
      if (!await fs.pathExists(configPath)) {
        return { content: [{ type: 'text', text: 'harness.config.json not found.' }], isError: true };
      }
      const cfg = await fs.readJson(configPath);
      const before = (cfg.authProfiles ?? []).length;
      cfg.authProfiles = (cfg.authProfiles ?? []).filter(p => p.name !== name);
      if (cfg.authProfiles.length === before) return ok(`No profile named "${name}" found.`);
      await fs.writeJson(configPath, cfg, { spaces: 2 });
      return ok(`Profile "${name}" removed.\nNote: .harness/smoke-auth-${name}.json was not deleted — remove it manually if no longer needed.`);
    },
  },
];
