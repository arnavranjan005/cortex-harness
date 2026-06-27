import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs-extra';
import pathModule from 'path';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/cli.mjs');

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

const EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

export const mcpScopeTools = [
  {
    name: 'cortex_mcp_scope_list',
    description: 'List all mcpScope entries from harness.config.json — which MCP servers each agent can use.',
    inputSchema: {
      type: 'object',
      properties: { workspaceRoot: { type: 'string' } },
    },
    async handler({ workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      try {
        const result = execFileSync(process.execPath, [CLI, 'config', 'mcp-scope'], { ...EXEC_OPTS, cwd });
        return ok(result.trim());
      } catch (err) {
        const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
        return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_mcp_scope_set',
    description: 'Grant an MCP server to an agent in harness.config.json. Use "*" to grant to all agents.',
    inputSchema: {
      type: 'object',
      required: ['agent', 'mcpServer'],
      properties: {
        agent: { type: 'string', description: 'Agent name (e.g. "frontend-subagent", "tester-subagent", "*").' },
        mcpServer: { type: 'string', description: 'MCP server name as it appears in .mcp.json (e.g. "playwright", "shadcn").' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ agent, mcpServer, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      try {
        const result = execFileSync(process.execPath, [CLI, 'config', 'add-mcp-scope', agent, mcpServer], { ...EXEC_OPTS, cwd });
        return ok(result.trim());
      } catch (err) {
        const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
        return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
      }
    },
  },

  {
    name: 'cortex_mcp_scope_remove',
    description: 'Remove an MCP server from an agent\'s scope in harness.config.json.',
    inputSchema: {
      type: 'object',
      required: ['agent', 'mcpServer'],
      properties: {
        agent: { type: 'string', description: 'Agent name.' },
        mcpServer: { type: 'string', description: 'MCP server name to remove.' },
        workspaceRoot: { type: 'string' },
      },
    },
    async handler({ agent, mcpServer, workspaceRoot } = {}) {
      const cwd = workspaceRoot ?? process.cwd();
      try {
        const result = execFileSync(process.execPath, [CLI, 'config', 'remove-mcp-scope', agent, mcpServer], { ...EXEC_OPTS, cwd });
        return ok(result.trim());
      } catch (err) {
        const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
        return { content: [{ type: 'text', text: `Failed: ${detail}` }], isError: true };
      }
    },
  },
];
