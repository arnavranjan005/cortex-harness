/**
 * Integration tests for `cortex-harness status`.
 * Creates various task-queue.json states and verifies output.
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
  const dir = join(tmpdir(), `oah-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeQueue(dir, queue) {
  const harnessDir = join(dir, '.harness');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, 'task-queue.json'), JSON.stringify(queue, null, 2));
}

test('status shows "no active run" when task-queue.json is missing', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No active run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status shows task and queue counts for a pending run', () => {
  const dir = makeTmpDir();
  try {
    writeQueue(dir, {
      task: 'Fix the login bug',
      promptType: 'fix-bug',
      cycles: [
        { id: 'cycle-1', type: 'orchestrate', status: 'done' },
        { id: 'cycle-2', type: 'implement', status: 'pending' },
        { id: 'cycle-3', type: 'test', status: 'pending' },
      ],
    });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Fix the login bug');
    expect(result.stdout).toContain('fix-bug');
    expect(result.stdout).toContain('1 done');
    expect(result.stdout).toContain('2 pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status shows blocked cycle with question text', () => {
  const dir = makeTmpDir();
  try {
    writeQueue(dir, {
      task: 'Add OAuth support',
      promptType: 'implement-feature',
      cycles: [
        {
          id: 'cycle-1',
          type: 'implement',
          status: 'blocked',
          blockedType: 'needs-human-input',
          blockedReason: 'Should we use Auth0 or Cognito for the OAuth provider?',
        },
      ],
    });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Waiting for your input');
    expect(result.stdout).toContain('Auth0 or Cognito');
    expect(result.stdout).toContain('cortex-harness resume');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status shows session-limit blocked cycle', () => {
  const dir = makeTmpDir();
  try {
    writeQueue(dir, {
      task: 'Refactor auth middleware',
      promptType: 'edit-feature',
      cycles: [
        {
          id: 'cycle-1',
          type: 'implement',
          status: 'blocked',
          blockedType: 'session-limit',
          blockedReason: 'Weekly usage limit reached',
        },
      ],
    });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage limit hit');
    expect(result.stdout).toContain('Weekly usage limit reached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status shows "all cycles complete" when everything is done', () => {
  const dir = makeTmpDir();
  try {
    writeQueue(dir, {
      task: 'Update README',
      promptType: 'edit-feature',
      cycles: [
        { id: 'cycle-1', type: 'orchestrate', status: 'done' },
        { id: 'cycle-2', type: 'implement', status: 'done' },
        { id: 'cycle-3', type: 'test', status: 'done' },
      ],
    });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All cycles complete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status shows partial cycles', () => {
  const dir = makeTmpDir();
  try {
    writeQueue(dir, {
      task: 'Migrate database schema',
      promptType: 'implement-feature',
      cycles: [
        { id: 'cycle-1', type: 'implement', status: 'partial', partialReason: 'Stopped after 3 files' },
      ],
    });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Partial cycles');
    expect(result.stdout).toContain('Stopped after 3 files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status handles malformed task-queue.json gracefully', () => {
  const dir = makeTmpDir();
  try {
    const harnessDir = join(dir, '.harness');
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, 'task-queue.json'), 'not valid json {{');

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('could not be parsed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status truncates task display at 100 chars', () => {
  const dir = makeTmpDir();
  try {
    const longTask = 'A'.repeat(120);
    writeQueue(dir, { task: longTask, promptType: 'implement', cycles: [] });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('…');
    expect(result.stdout).not.toContain(longTask);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status extracts NEEDS_HUMAN_INPUT text from run log finalMessage', () => {
  const dir = makeTmpDir();
  try {
    const harnessDir = join(dir, '.harness');
    const runsDir = join(harnessDir, 'runs');
    mkdirSync(runsDir, { recursive: true });

    const cycleId = 'implement-1';
    const fullQuestion = 'Should we use Redis or Postgres for the queue?';
    writeFileSync(
      join(runsDir, '20260101-120000.jsonl'),
      JSON.stringify({
        type: 'cycle-result',
        cycleId,
        finalMessage: `NEEDS_HUMAN_INPUT: ${fullQuestion}`,
        timestamp: '2026-01-01T12:00:00.000Z',
      }) + '\n',
    );

    writeQueue(dir, {
      task: 'Add job queue',
      promptType: 'implement-feature',
      cycles: [{
        id: cycleId,
        type: 'implement',
        status: 'blocked',
        blockedType: 'needs-human-input',
        blockedReason: 'Should we use Redis or',  // truncated legacy format
      }],
    });

    const result = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(fullQuestion);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
