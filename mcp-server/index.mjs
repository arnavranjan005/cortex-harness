#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { initTools } from './tools/init.mjs';
import { configTools } from './tools/config.mjs';
import { notifyTools } from './tools/notify.mjs';
import { mcpScopeTools } from './tools/mcp-scope.mjs';
import { authTools } from './tools/auth.mjs';

const ALL_TOOLS = [
  ...initTools,
  ...configTools,
  ...notifyTools,
  ...mcpScopeTools,
  ...authTools,
];

const server = new Server(
  { name: 'cortex-harness', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = ALL_TOOLS.find(t => t.name === request.params.name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  try {
    return await tool.handler(request.params.arguments ?? {});
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
