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
