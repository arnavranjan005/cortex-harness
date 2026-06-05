/**
 * Tests for the `cortex-harness gitignore` command and patchGitignore helper.
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'cli.mjs');

const EXPECTED_ENTRIES = [
  '.harness/runs/',
  '.harness/cycle-state/',
  '.harness/output/',
  '.harness/session.json',
  '.harness/task-queue.json',
  '.harness/sessions/',
  '.harness/pre-run-snapshot/',
  '.harness/notification-channels.local.json',
];

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-gitignore-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('gitignore creates .gitignore when none exists', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);

    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('# cortex-harness');
    expect(content).toContain('# /cortex-harness');
    for (const entry of EXPECTED_ENTRIES) {
      expect(content).toContain(entry);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore appends to existing .gitignore without clobbering it', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, '.gitignore'), '# my project\ndist/\nnode_modules/\n');

    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });

    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('# my project');
    expect(content).toContain('node_modules/');
    for (const entry of EXPECTED_ENTRIES) {
      expect(content).toContain(entry);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore is idempotent — running twice does not duplicate entries', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });

    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    const startCount = (content.match(/# cortex-harness\n/g) ?? []).length;
    expect(startCount).toBe(1);

    for (const entry of EXPECTED_ENTRIES) {
      const count = content.split('\n').filter(l => l.trim() === entry).length;
      expect(count).toBe(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore includes task-queue.json', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('.harness/task-queue.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore includes sessions/', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('.harness/sessions/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore includes pre-run-snapshot/', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('.harness/pre-run-snapshot/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitignore reports created on first run and already-present on second', () => {
  const dir = makeTmpDir();
  try {
    const r1 = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(r1.stdout.toLowerCase()).toMatch(/creat|appended|✓/);

    const r2 = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(r2.stdout.toLowerCase()).toContain('already');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
