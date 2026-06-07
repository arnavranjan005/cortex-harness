/**
 * Integration tests for `cortex-harness notify` and `notify-setup` commands.
 * Tests CLI surface (registration, help, subcommand routing) only.
 * Does not attempt to send real notifications.
 */
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-notify-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('--help lists notify-setup and notify commands', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('notify-setup');
    expect(result.stdout).toContain('notify');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notify-setup --help exits 0', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'notify-setup', '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('notify-setup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notify --help exits 0', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'notify', '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
