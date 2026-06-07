/**
 * Integration tests for `cortex-harness run` command.
 * Does not actually spawn claude — tests CLI surface only (arg parsing, exit codes).
 */
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-run-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('run --help exits 0 and describes run command', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'run', '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run');
    expect(result.stdout).toContain('task');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run with no task and no stdin exits non-zero with helpful message', () => {
  const dir = makeTmpDir();
  try {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });

    const result = spawnSync('node', [CLI, 'run'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No task provided');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run --task-file exits non-zero when file does not exist', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'run', '--task-file', 'nonexistent-task.txt'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Task file not found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run --task-file reads task from file and passes to engine', () => {
  const dir = makeTmpDir();
  try {
    const taskFile = join(dir, 'task.txt');
    writeFileSync(taskFile, 'Fix the authentication bug');

    // Engine path won't exist in isolated tmp — just verify exit behavior (non-zero is fine,
    // what matters is it does NOT exit with "Task file not found" or "No task provided")
    const result = spawnSync('node', [CLI, 'run', '--task-file', taskFile], { cwd: dir, encoding: 'utf8', timeout: 5_000 });
    expect(result.stderr).not.toContain('Task file not found');
    expect(result.stderr).not.toContain('No task provided');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
