import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs-extra';
import path from 'path';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.mjs');

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

export const configTools = [
  {
    name: 'cortex_config_get',
    description: 'Read harness.config.json. Returns the full config or a single top-level field.',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Optional top-level field to read (e.g. "cliProvider", "agents"). Omit for full config.' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ field, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      const configPath = path.join(cwd, 'harness.config.json');
      if (!await fs.pathExists(configPath)) {
        return { content: [{ type: 'text', text: 'harness.config.json not found.' }], isError: true };
      }
      const cfg = await fs.readJson(configPath);
      const value = field !== undefined ? cfg[field] : cfg;
      return ok(JSON.stringify(value, null, 2));
    },
  },

  {
    name: 'cortex_config_set',
    description: 'Set a top-level field in harness.config.json.',
    inputSchema: {
      type: 'object',
      required: ['field', 'value'],
      properties: {
        field: { type: 'string', description: 'Top-level field name (e.g. "cliProvider").' },
        value: { description: 'Value to write — string, number, boolean, array, or object.' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ field, value, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      // cliProvider has a dedicated non-interactive CLI subcommand
      if (field === 'cliProvider') {
        try {
          const result = execFileSync(process.execPath, [CLI, 'config', 'set-cli-provider', String(value)], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return ok(result.trim());
        } catch (err) {
          const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
          return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
        }
      }
      // Other fields (smokeUrls, smokeCheckBudgetPerUrl, etc.) have no non-interactive
      // CLI subcommand — the config wizard uses clack prompts that skip in non-TTY mode
      const configPath = path.join(cwd, 'harness.config.json');
      if (!await fs.pathExists(configPath)) {
        return { content: [{ type: 'text', text: 'harness.config.json not found.' }], isError: true };
      }
      const cfg = await fs.readJson(configPath);
      cfg[field] = value;
      await fs.writeJson(configPath, cfg, { spaces: 2 });
      return ok(`Set harness.config.json["${field}"] = ${JSON.stringify(value)}`);
    },
  },
];
