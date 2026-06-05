/**
 * Smoke tests for the CLI — verifies init scaffolds expected files
 * and run/resume commands spawn without crashing.
 */
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
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('init');
  expect(result.stdout).toContain('run');
  expect(result.stdout).toContain('resume');
  expect(result.stdout).toContain('notify-setup');
  expect(result.stdout).toContain('notify');
});

test('init scaffolds .harness/ directory with prompts and agents', () => {
  const dir = makeTmpDir();
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }

  try {
    const result = spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);

    expect(existsSync(join(dir, '.harness'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'prompts'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'agents'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'prompts', 'orchestrate.md'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'prompts', 'implement.md'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'prompts', 'test.md'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'agents', 'backend-subagent.agent.md'))).toBe(true);
    expect(existsSync(join(dir, '.harness', 'agents', 'tester-subagent.agent.md'))).toBe(true);
    expect(existsSync(join(dir, 'harness.config.json'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
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
    expect(after).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run with no task and no queue exits non-zero', () => {
  const dir = makeTmpDir();
  try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }
  spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });

  try {
    const result = spawnSync('node', [CLI, 'run'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs shows run name without .jsonl extension in error path', () => {
  const dir = makeTmpDir();
  try {
    const runsDir = join(dir, '.harness', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, '20260101-120000.jsonl'), JSON.stringify({ type: 'harness', event: 'run-start', task: 'test' }) + '\n');

    const result = spawnSync('node', [CLI, 'logs', '--run', 'nonexistent'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('20260101-120000');
    expect(result.stdout).not.toContain('.jsonl');
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
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RUN START');
    expect(result.stdout).toContain('test task');
    expect(result.stdout).not.toContain('.jsonl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
