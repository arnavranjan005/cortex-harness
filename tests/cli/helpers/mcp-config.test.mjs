/**
 * Tests for the mergeMcpConfig helper — additive .mcp.json registration during init.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeMcpConfig } from '../../../src/cli/helpers/mcp-config.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEMPLATE = {
  mcpServers: {
    playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
};

test('creates .mcp.json when none exists', async () => {
  const templatesDir = makeTmpDir('mcp-templates');
  const targetDir = makeTmpDir('mcp-target');
  try {
    writeFileSync(join(templatesDir, '.mcp.json'), JSON.stringify(TEMPLATE));

    const status = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('created');

    const written = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.playwright.command).toBe('npx');
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('merges template server into existing .mcp.json without dropping user entries', async () => {
  const templatesDir = makeTmpDir('mcp-templates');
  const targetDir = makeTmpDir('mcp-target');
  try {
    writeFileSync(join(templatesDir, '.mcp.json'), JSON.stringify(TEMPLATE));
    writeFileSync(
      join(targetDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { shadcn: { type: 'stdio', command: 'npx', args: ['shadcn@latest', 'mcp'] } } }),
    );

    const status = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('merged');

    const written = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.shadcn).toBeDefined();
    expect(written.mcpServers.playwright).toBeDefined();
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('does not overwrite a server the user already registered under the same name', async () => {
  const templatesDir = makeTmpDir('mcp-templates');
  const targetDir = makeTmpDir('mcp-target');
  try {
    writeFileSync(join(templatesDir, '.mcp.json'), JSON.stringify(TEMPLATE));
    const userOverride = { type: 'stdio', command: 'custom-playwright-runner', args: [] };
    writeFileSync(
      join(targetDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { playwright: userOverride } }),
    );

    const status = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('present');

    const written = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.playwright.command).toBe('custom-playwright-runner');
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('returns "absent" when no template .mcp.json exists', async () => {
  const templatesDir = makeTmpDir('mcp-templates-empty');
  const targetDir = makeTmpDir('mcp-target');
  try {
    const status = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('absent');
    expect(existsSync(join(targetDir, '.mcp.json'))).toBe(false);
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
