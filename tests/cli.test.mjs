/**
 * Smoke tests for the CLI — verifies init scaffolds expected files
 * and run/resume commands spawn without crashing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-cli-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('--help exits 0 and shows commands', () => {
  const result = spawnSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.ok(result.stdout.includes('init'), 'should list init command');
  assert.ok(result.stdout.includes('run'), 'should list run command');
  assert.ok(result.stdout.includes('resume'), 'should list resume command');
  assert.ok(result.stdout.includes('notify-setup'), 'should list notify-setup command');
  assert.ok(result.stdout.includes('notify'), 'should list notify command');
});

test('init scaffolds .harness/ directory with prompts and agents', () => {
  const dir = makeTmpDir();
  // Init needs a git repo for sync-memory (ignore errors from git)
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }

  try {
    const result = spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `init failed:\n${result.stderr}`);

    assert.ok(existsSync(join(dir, '.harness')), '.harness/ should exist');
    assert.ok(existsSync(join(dir, '.harness', 'prompts')), '.harness/prompts/ should exist');
    assert.ok(existsSync(join(dir, '.harness', 'agents')), '.harness/agents/ should exist');
    assert.ok(existsSync(join(dir, '.harness', 'prompts', 'orchestrate.md')), 'orchestrate.md should exist');
    assert.ok(existsSync(join(dir, '.harness', 'prompts', 'implement.md')), 'implement.md should exist');
    assert.ok(existsSync(join(dir, '.harness', 'prompts', 'test.md')), 'test.md should exist');
    assert.ok(existsSync(join(dir, '.harness', 'agents', 'backend-subagent.agent.md')), 'backend agent should exist');
    assert.ok(existsSync(join(dir, '.harness', 'agents', 'tester-subagent.agent.md')), 'tester agent should exist');
    assert.ok(existsSync(join(dir, 'harness.config.json')), 'harness.config.json should be created');
    assert.ok(existsSync(join(dir, 'CLAUDE.md')), 'CLAUDE.md should be created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init skips harness.config.json if it already exists', () => {
  const dir = makeTmpDir();
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }

  const configPath = join(dir, 'harness.config.json');
  const original = JSON.stringify({ harnessDir: '.harness', agents: { 'my-agent': { scope: ['src/'] } } });
  writeFileSync(configPath, original);

  try {
    spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    const after = readFileSync(configPath, 'utf8');
    assert.equal(after, original, 'existing harness.config.json should not be overwritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run with no task and no queue exits non-zero', () => {
  const dir = makeTmpDir();
  // Init so config exists
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }
  spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });

  try {
    const result = spawnSync('node', [CLI, 'run'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0, 'run with no task should fail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs shows run name without .jsonl extension in error path', () => {
  const dir = makeTmpDir();
  try {
    // Create .harness/runs/ with a sample jsonl file
    const runsDir = join(dir, '.harness', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, '20260101-120000.jsonl'), JSON.stringify({ type: 'harness', event: 'run-start', task: 'test' }) + '\n');

    const result = spawnSync('node', [CLI, 'logs', '--run', 'nonexistent'], { cwd: dir, encoding: 'utf8' });
    // Should exit non-zero (run not found)
    assert.notEqual(result.status, 0, 'should exit non-zero for nonexistent run');
    // Should list available runs without .jsonl extension
    assert.ok(result.stdout.includes('20260101-120000'), 'should show run name without .jsonl extension');
    assert.ok(!result.stdout.includes('.jsonl'), 'should not leak .jsonl extension in available runs list');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs prints events from a run log', () => {
  const dir = makeTmpDir();
  try {
    const runsDir = join(dir, '.harness', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, '20260101-120000.jsonl'), JSON.stringify({ type: 'harness', event: 'run-start', task: 'test task', timestamp: '2026-01-01T12:00:00.000Z' }) + '\n');

    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-120000'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `logs should succeed: ${result.stderr}`);
    assert.ok(result.stdout.includes('RUN START'), 'should show run-start event');
    assert.ok(result.stdout.includes('test task'), 'should show task name');
    assert.ok(!result.stdout.includes('.jsonl'), 'should not show .jsonl in output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
