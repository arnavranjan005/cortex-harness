/**
 * Integration tests for `cortex-harness logs`.
 * Extends tests/cli.test.mjs with additional event type coverage.
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
  const dir = join(tmpdir(), `oah-logs-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRunLog(dir, filename, events) {
  const runsDir = join(dir, '.harness', 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, filename), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('logs shows "no runs directory" when .harness/runs is absent', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'logs'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No runs directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs shows "no run logs found" when runs dir is empty', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, '.harness', 'runs'), { recursive: true });
    const result = spawnSync('node', [CLI, 'logs'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No run logs found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs renders run-start and run-end events', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-120000.jsonl', [
      { type: 'harness', event: 'run-start', task: 'Fix the bug', timestamp: '2026-01-01T12:00:00.000Z' },
      { type: 'harness', event: 'run-end', done: 3, blocked: 0, pending: 0, totalSpentUsd: 1.23, timestamp: '2026-01-01T12:05:00.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-120000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RUN START');
    expect(result.stdout).toContain('Fix the bug');
    expect(result.stdout).toContain('RUN END');
    expect(result.stdout).toContain('1.23');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs renders cycle-start and cycle-result events', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-130000.jsonl', [
      { type: 'harness', event: 'cycle-start', cycleId: 'implement-1', taskGroup: 'backend', timestamp: '2026-01-01T13:00:00.000Z' },
      { type: 'harness', event: 'cycle-result', cycleId: 'implement-1', cycles: 2, blocked: 0, timestamp: '2026-01-01T13:02:00.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-130000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CYCLE');
    expect(result.stdout).toContain('implement-1');
    expect(result.stdout).toContain('backend');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs renders tool-call and tool-result events', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-140000.jsonl', [
      { type: 'tool-call', tool: 'Read', timestamp: '2026-01-01T14:00:00.000Z' },
      { type: 'tool-result', success: true, result: 'file contents here', timestamp: '2026-01-01T14:00:01.000Z' },
      { type: 'tool-call', tool: 'Edit', timestamp: '2026-01-01T14:00:02.000Z' },
      { type: 'tool-result', success: false, result: 'file not found', timestamp: '2026-01-01T14:00:03.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-140000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TOOL CALL');
    expect(result.stdout).toContain('Read');
    expect(result.stdout).toContain('TOOL OK');
    expect(result.stdout).toContain('TOOL FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs renders error and fatal events', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-150000.jsonl', [
      { type: 'harness', event: 'fatal', error: 'Unhandled rejection in cycle runner', timestamp: '2026-01-01T15:00:00.000Z' },
      { type: 'error', message: 'ENOENT: no such file', timestamp: '2026-01-01T15:00:01.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-150000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FATAL');
    expect(result.stdout).toContain('Unhandled rejection');
    expect(result.stdout).toContain('ERROR');
    expect(result.stdout).toContain('ENOENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs renders rate_limit event', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-160000.jsonl', [
      { type: 'harness', event: 'rate_limit', service: 'anthropic', resetsAt: '2026-01-01T16:30:00.000Z', timestamp: '2026-01-01T16:00:00.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-160000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RATE LIMIT');
    expect(result.stdout).toContain('anthropic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs renders agent_message events', () => {
  const dir = makeTmpDir();
  try {
    writeRunLog(dir, '20260101-170000.jsonl', [
      { type: 'agent_message', role: 'assistant', content: 'I will fix the bug now.', timestamp: '2026-01-01T17:00:00.000Z' },
    ]);
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-170000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('assistant');
    expect(result.stdout).toContain('I will fix the bug now');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs skips malformed JSON lines without crashing', () => {
  const dir = makeTmpDir();
  try {
    const runsDir = join(dir, '.harness', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, '20260101-180000.jsonl'),
      JSON.stringify({ type: 'harness', event: 'run-start', task: 'test', timestamp: '2026-01-01T18:00:00.000Z' }) + '\n' +
      'not valid json {{{\n' +
      JSON.stringify({ type: 'error', message: 'oops', timestamp: '2026-01-01T18:00:01.000Z' }) + '\n'
    );
    const result = spawnSync('node', [CLI, 'logs', '--run', '20260101-180000'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RUN START');
    expect(result.stdout).toContain('oops');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logs defaults to latest run file when --run not specified', () => {
  const dir = makeTmpDir();
  try {
    const runsDir = join(dir, '.harness', 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, '20260101-110000.jsonl'),
      JSON.stringify({ type: 'harness', event: 'run-start', task: 'older run', timestamp: '2026-01-01T11:00:00.000Z' }) + '\n'
    );
    writeFileSync(join(runsDir, '20260101-120000.jsonl'),
      JSON.stringify({ type: 'harness', event: 'run-start', task: 'latest run', timestamp: '2026-01-01T12:00:00.000Z' }) + '\n'
    );
    const result = spawnSync('node', [CLI, 'logs'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('latest run');
    expect(result.stdout).not.toContain('older run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
