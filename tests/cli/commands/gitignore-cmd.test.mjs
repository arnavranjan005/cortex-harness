/**
 * Integration tests for `cortex-harness gitignore` command.
 * Complements tests/cli/helpers/gitignore.test.mjs (which tests the helper directly).
 * These verify the CLI surface behaves correctly end-to-end.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-gitignore-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('gitignore creates .gitignore when absent', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    expect(result.stdout).toContain('Created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore appends entries to existing .gitignore', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    const result = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.harness/runs/');
    expect(result.stdout).toContain('Appended');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore is idempotent when entries already present', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    const contentAfterFirst = readFileSync(join(dir, '.gitignore'), 'utf8');

    const result = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already contains');
    const contentAfterSecond = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(contentAfterSecond).toBe(contentAfterFirst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore --help exits 0', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'gitignore', '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gitignore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
