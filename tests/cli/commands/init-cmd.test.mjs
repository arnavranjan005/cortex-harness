/**
 * Integration tests for `cortex-harness init`.
 * Focused on features not covered by tests/cli.test.mjs:
 *   - .mcp.json Playwright server registration
 *   - .claude/settings.json hooks wiring
 *   - re-init merges without clobbering existing files
 */
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-init-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initDir(dir) {
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }
  return spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
}

test('init creates .mcp.json with playwright server', () => {
  const dir = makeTmpDir();
  try {
    const result = initDir(dir);
    expect(result.status).toBe(0);
    const mcpPath = join(dir, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(mcp.mcpServers).toBeDefined();
    expect(mcp.mcpServers.playwright).toBeDefined();
    expect(mcp.mcpServers.playwright.command).toBe('npx');
    expect(mcp.mcpServers.playwright.args).toContain('@playwright/mcp@latest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init wires .claude/settings.json hooks', () => {
  const dir = makeTmpDir();
  try {
    const result = initDir(dir);
    expect(result.status).toBe(0);
    const settingsPath = join(dir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init merges hooks into existing .claude/settings.json without clobbering', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } }, null, 2),
    );

    const result = initDir(dir);
    expect(result.status).toBe(0);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.hooks).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init does not overwrite existing .mcp.json user-registered server', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { playwright: { type: 'stdio', command: 'custom-runner', args: [] } } }, null, 2),
    );

    initDir(dir);

    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.playwright.command).toBe('custom-runner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init merges playwright into .mcp.json that has other servers', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { shadcn: { type: 'stdio', command: 'npx', args: ['shadcn@latest', 'mcp'] } } }, null, 2),
    );

    initDir(dir);

    const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.shadcn).toBeDefined();
    expect(mcp.mcpServers.playwright).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init output mentions .mcp.json', () => {
  const dir = makeTmpDir();
  try {
    const result = initDir(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.mcp.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init creates harness.config.json with default agents', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.agents).toBeDefined();
    expect(config.agents['backend-subagent']).toBeDefined();
    expect(config.agents['frontend-subagent']).toBeDefined();
    expect(config.agents['tester-subagent']).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init skips harness.config.json when it already exists', () => {
  const dir = makeTmpDir();
  try {
    const customConfig = JSON.stringify({ harnessDir: '.harness', agents: { 'my-custom-agent': { scope: ['custom/'] } } }, null, 2);
    writeFileSync(join(dir, 'harness.config.json'), customConfig);

    initDir(dir);

    const after = readFileSync(join(dir, 'harness.config.json'), 'utf8');
    expect(JSON.parse(after).agents['my-custom-agent']).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init --help exits 0', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'init', '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('init');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
