/**
 * Integration tests for `cortex-harness mcp` command.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-mcp-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMcp(dir, servers) {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

function writeRunLog(dir, filename, rawEvents) {
  const runsDir = join(dir, '.harness', 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, filename), rawEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function makeAssistantEvent(toolNames) {
  return {
    cycleId: 'implement-1',
    raw: JSON.stringify({
      type: 'assistant',
      message: {
        content: toolNames.map(name => ({ type: 'tool_use', id: `toolu_${name}`, name, input: {} })),
      },
    }),
  };
}

// ── mcp (default) ─────────────────────────────────────────────────────────────

test('mcp shows "no .mcp.json found" when absent', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'mcp'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No .mcp.json found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp lists registered servers from .mcp.json', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    const result = spawnSync('node', [CLI, 'mcp'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('playwright');
    expect(result.stdout).toContain('npx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp shows multiple registered servers', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      shadcn: { type: 'stdio', command: 'npx', args: ['shadcn@latest', 'mcp'] },
    });
    const result = spawnSync('node', [CLI, 'mcp'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('playwright');
    expect(result.stdout).toContain('shadcn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── mcp list ──────────────────────────────────────────────────────────────────

test('mcp list shows servers without needing a run log', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    const result = spawnSync('node', [CLI, 'mcp', 'list'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('playwright');
    expect(result.stdout).toContain('@playwright/mcp@latest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp list shows "no .mcp.json" when absent', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'mcp', 'list'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No .mcp.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── mcp usage ─────────────────────────────────────────────────────────────────

test('mcp usage shows "no run logs" when runs dir is absent', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'mcp', 'usage'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No run logs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage attributes browser_ tools to playwright server', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    writeRunLog(dir, '20260101-120000.jsonl', [
      makeAssistantEvent(['browser_navigate', 'browser_screenshot', 'browser_navigate']),
    ]);

    const result = spawnSync('node', [CLI, 'mcp', 'usage'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('playwright');
    expect(result.stdout).toContain('browser_navigate');
    expect(result.stdout).toContain('browser_screenshot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage splits built-in tools from MCP tools', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    writeRunLog(dir, '20260101-120000.jsonl', [
      makeAssistantEvent(['Read', 'Edit', 'Bash', 'browser_navigate']),
    ]);

    const result = spawnSync('node', [CLI, 'mcp', 'usage'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('built-in');
    expect(result.stdout).toContain('Read');
    expect(result.stdout).toContain('browser_navigate');
    expect(result.stdout).toContain('playwright');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage shows unknown MCP bucket for unrecognized non-builtin tools', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    writeRunLog(dir, '20260101-120000.jsonl', [
      makeAssistantEvent(['some_custom_mcp_tool', 'another_mcp_tool', 'Read']),
    ]);

    const result = spawnSync('node', [CLI, 'mcp', 'usage'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('unregistered server');
    expect(result.stdout).toContain('some_custom_mcp_tool');
    expect(result.stdout).toContain('built-in');
    expect(result.stdout).toContain('Read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage shows registered-but-unused servers', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    writeRunLog(dir, '20260101-120000.jsonl', [
      makeAssistantEvent(['Read', 'Edit']),  // no playwright tools used
    ]);

    const result = spawnSync('node', [CLI, 'mcp', 'usage'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No calls recorded for');
    expect(result.stdout).toContain('playwright');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage --run inspects a specific run file', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    writeRunLog(dir, '20260101-110000.jsonl', [makeAssistantEvent(['Read'])]);
    writeRunLog(dir, '20260101-120000.jsonl', [makeAssistantEvent(['browser_navigate'])]);

    const result = spawnSync('node', [CLI, 'mcp', 'usage', '--run', '20260101-110000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('20260101-110000');
    expect(result.stdout).not.toContain('browser_navigate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage --run exits non-zero for nonexistent run', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-120000.jsonl', [makeAssistantEvent(['Read'])]);
    const result = spawnSync('node', [CLI, 'mcp', 'usage', '--run', 'nonexistent'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('not found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp usage shows "no tool calls" for a run with no assistant events', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-120000.jsonl', [
      { type: 'harness', event: 'run-start', task: 'test', timestamp: '2026-01-01T12:00:00.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'mcp', 'usage'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No tool calls recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp --help lists list, usage and check subcommands', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'mcp', '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('list');
    expect(result.stdout).toContain('usage');
    expect(result.stdout).toContain('check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── mcp check ────────────────────────────────────────────────────────────────

test('mcp check shows "nothing to check" when .mcp.json absent', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'mcp', 'check'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp check reports failure for a server with a bad command', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      'bad-server': { type: 'stdio', command: 'this-command-does-not-exist-xyz', args: [] },
    });
    const result = spawnSync('node', [CLI, 'mcp', 'check'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✗');
    expect(result.stdout).toContain('bad-server');
    expect(result.stdout).toContain('Some servers failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp check marks non-stdio server as unsupported', () => {
  const dir = makeTmpDir();
  try {
    writeMcp(dir, {
      'remote-server': { type: 'http', url: 'http://localhost:9999' },
    });
    const result = spawnSync('node', [CLI, 'mcp', 'check'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✗');
    expect(result.stdout).toContain('not supported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp check passes for a server that responds with valid MCP initialize', () => {
  const dir = makeTmpDir();
  // Write a tiny fake MCP server script that responds to initialize
  const fakeServer = join(dir, 'fake-mcp.mjs');
  writeFileSync(fakeServer, `
import readline from 'readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'fake-mcp', version: '0.0.1' },
        },
      }) + '\\n');
    }
  } catch {}
});
`);

  try {
    writeMcp(dir, {
      'fake-server': { type: 'stdio', command: 'node', args: [fakeServer] },
    });
    const result = spawnSync('node', [CLI, 'mcp', 'check'], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✓');
    expect(result.stdout).toContain('fake-server');
    expect(result.stdout).toContain('All servers healthy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
