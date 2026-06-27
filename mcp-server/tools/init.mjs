import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs-extra';
import path from 'path';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.mjs');

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

export const initTools = [
  {
    name: 'cortex_init_run',
    description: 'Scaffold .harness/ templates, agent files, and harness.config.json. Runs "cortex-harness init --yes" which auto-detects surface paths. Call this first, then cortex_init_set_scope to customize paths.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: {
          type: 'string',
          description: 'Absolute path to workspace root. Defaults to process.cwd().',
        },
      },
    },
    async handler({ workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      const configPath = path.join(cwd, 'harness.config.json');
      const alreadyInit = await fs.pathExists(configPath);

      try {
        const result = execFileSync(process.execPath, [CLI, 'init', '--yes'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const prefix = alreadyInit
          ? 'Re-initialised (config already existed — files updated where needed).'
          : 'Scaffold complete.';
        return ok(`${prefix}\n\n${result.trim()}`);
      } catch (err) {
        const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
        return { content: [{ type: 'text', text: `Init failed:\n${detail}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_init_set_scope',
    description: 'Set agent scope paths in harness.config.json. Pass a map of agent names to path arrays. Run after cortex_init_run to customise auto-detected surfaces.',
    inputSchema: {
      type: 'object',
      required: ['scopes'],
      properties: {
        scopes: {
          type: 'object',
          description: 'Map of agent name → array of scope paths. E.g. {"backend-subagent": ["api/", "libs/shared/schema"], "frontend-subagent": ["apps/web/"]}',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ scopes, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      const configPath = path.join(cwd, 'harness.config.json');

      if (!await fs.pathExists(configPath)) {
        return { content: [{ type: 'text', text: 'harness.config.json not found. Run cortex_init_run first.' }], isError: true };
      }

      const cfg = await fs.readJson(configPath);
      if (!cfg.agents) cfg.agents = {};

      for (const [agent, paths] of Object.entries(scopes)) {
        if (!cfg.agents[agent]) cfg.agents[agent] = {};
        cfg.agents[agent].scope = paths;
      }

      await fs.writeJson(configPath, cfg, { spaces: 2 });

      const summary = Object.entries(scopes)
        .map(([a, p]) => `  ${a}: [${p.join(', ')}]`)
        .join('\n');
      return ok(`Scope paths updated in harness.config.json:\n${summary}`);
    },
  },
];
