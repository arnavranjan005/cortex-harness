/**
 * Integration tests for `cortex-harness config` subcommands.
 * Requires a pre-initialized project (harness.config.json present).
 */
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initDir(dir) {
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }
  spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
}

test('config list prints scope table for initialized project', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'list'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('backend-subagent');
    expect(result.stdout).toContain('frontend-subagent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config list exits non-zero when no harness.config.json', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'config', 'list'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-scope appends a path to an agent scope', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Added');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.agents['backend-subagent'].scope).toContain('api/src/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-scope normalizes path without trailing slash', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src'], { cwd: dir, encoding: 'utf8' });

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.agents['backend-subagent'].scope).toContain('api/src/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-scope is idempotent when path already present', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });
    const result = spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already in');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    const count = config.agents['backend-subagent'].scope.filter(s => s === 'api/src/').length;
    expect(count).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-scope exits non-zero for unknown agent', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'add-scope', 'nonexistent-agent', 'src/'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown agent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-scope removes a path from agent scope', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });

    const result = spawnSync('node', [CLI, 'config', 'remove-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.agents['backend-subagent'].scope).not.toContain('api/src/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-scope handles path without trailing slash', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });

    const result = spawnSync('node', [CLI, 'config', 'remove-scope', 'backend-subagent', 'api/src'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.agents['backend-subagent'].scope).not.toContain('api/src/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-scope is no-op when path not in scope', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'remove-scope', 'backend-subagent', 'nonexistent/'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-scope exits non-zero for unknown agent', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'remove-scope', 'ghost-agent', 'src/'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-scope + remove-scope round-trip leaves scope unchanged', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const before = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    const scopeBefore = [...(before.agents['frontend-subagent'].scope || [])];

    spawnSync('node', [CLI, 'config', 'add-scope', 'frontend-subagent', 'web/src/'], { cwd: dir, encoding: 'utf8' });
    spawnSync('node', [CLI, 'config', 'remove-scope', 'frontend-subagent', 'web/src/'], { cwd: dir, encoding: 'utf8' });

    const after = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(after.agents['frontend-subagent'].scope).toEqual(scopeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── MCP scope subcommands ──────────────────────────────────────────────────────

test('config mcp-scope prints MCP scope table', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'mcp-scope'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('MCP scope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-mcp-scope adds a server to an agent', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'add-mcp-scope', 'backend-subagent', 'my-server'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Added');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.mcpScope['backend-subagent']).toContain('my-server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-mcp-scope supports * wildcard for all agents', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'add-mcp-scope', '*', 'global-server'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.mcpScope['*']).toContain('global-server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-mcp-scope is idempotent', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'add-mcp-scope', 'frontend-subagent', 'playwright'], { cwd: dir, encoding: 'utf8' });
    const result = spawnSync('node', [CLI, 'config', 'add-mcp-scope', 'frontend-subagent', 'playwright'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already in');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    const count = config.mcpScope['frontend-subagent'].filter(s => s === 'playwright').length;
    expect(count).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-mcp-scope exits non-zero for unknown agent key', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'add-mcp-scope', 'nonexistent-agent', 'server'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-mcp-scope removes a server from an agent', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'add-mcp-scope', 'tester-subagent', 'playwright'], { cwd: dir, encoding: 'utf8' });

    const result = spawnSync('node', [CLI, 'config', 'remove-mcp-scope', 'tester-subagent', 'playwright'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.mcpScope['tester-subagent'] ?? []).not.toContain('playwright');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-mcp-scope is no-op when server not present', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'remove-mcp-scope', 'backend-subagent', 'nonexistent-server'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config add-mcp-scope + remove-mcp-scope round-trip leaves mcpScope unchanged', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const before = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    const scopeBefore = [...(before.mcpScope?.['frontend-subagent'] ?? [])];

    spawnSync('node', [CLI, 'config', 'add-mcp-scope', 'frontend-subagent', 'test-server'], { cwd: dir, encoding: 'utf8' });
    spawnSync('node', [CLI, 'config', 'remove-mcp-scope', 'frontend-subagent', 'test-server'], { cwd: dir, encoding: 'utf8' });

    const after = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(after.mcpScope?.['frontend-subagent'] ?? []).toEqual(scopeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Dynamic route params subcommands ────────────────────────────────────────

test('config route-params prints table when nothing configured', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'route-params'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No routeParams configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config set-route-param writes a flat default', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'set-route-param', 'id', '1'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Set flat default');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.routeParams.id).toBe('1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config set-route-override writes a per-route override without clobbering existing keys', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'set-route-override', '/clients/[id]', 'id', 'demo-client-1'], { cwd: dir, encoding: 'utf8' });
    const result = spawnSync('node', [CLI, 'config', 'set-route-override', '/clients/[id]', 'tab', 'invoices'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.routeParams['/clients/[id]']).toEqual({ id: 'demo-client-1', tab: 'invoices' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config set-route-override rejects a route pattern without a leading slash', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'set-route-override', 'clients/[id]', 'id', '1'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must start with');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-route-param removes a flat default', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'set-route-param', 'id', '1'], { cwd: dir, encoding: 'utf8' });

    const result = spawnSync('node', [CLI, 'config', 'remove-route-param', 'id'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed');

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.routeParams.id).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-route-param removes an entire route override entry', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    spawnSync('node', [CLI, 'config', 'set-route-override', '/clients/[id]', 'id', 'demo-client-1'], { cwd: dir, encoding: 'utf8' });

    const result = spawnSync('node', [CLI, 'config', 'remove-route-param', '/clients/[id]'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);

    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.routeParams['/clients/[id]']).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config remove-route-param is no-op when key not present', () => {
  const dir = makeTmpDir();
  try {
    initDir(dir);
    const result = spawnSync('node', [CLI, 'config', 'remove-route-param', 'nonexistent'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
