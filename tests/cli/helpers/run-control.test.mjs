/**
 * Unit tests for run-control helpers: clearHarnessState, readRunEndSpend,
 * resumeBlockedCycles (non-interactive paths only — needsInput prompting requires a TTY
 * and is covered indirectly by the existing CLI smoke tests).
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearHarnessState,
  readRunEndSpend,
  resumeBlockedCycles,
} from '../../../src/cli/helpers/run-control.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('clearHarnessState', () => {
  test('removes queue, session, and cycle-state contents but leaves .harness itself', async () => {
    const dir = makeTmpDir('runcontrol-clear');
    try {
      const harnessDir = join(dir, '.harness');
      const cycleDir = join(harnessDir, 'cycle-state');
      mkdirSync(cycleDir, { recursive: true });
      writeFileSync(join(harnessDir, 'task-queue.json'), '{}');
      writeFileSync(join(harnessDir, 'session.json'), '{}');
      writeFileSync(join(cycleDir, 'implement-foo.json'), '{}');

      await clearHarnessState(dir);

      expect(existsSync(join(harnessDir, 'task-queue.json'))).toBe(false);
      expect(existsSync(join(harnessDir, 'session.json'))).toBe(false);
      expect(existsSync(cycleDir)).toBe(true);
      expect(readdirSync(cycleDir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is a no-op when .harness does not exist', async () => {
    const dir = makeTmpDir('runcontrol-clear-missing');
    try {
      await expect(clearHarnessState(dir)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readRunEndSpend', () => {
  test('returns 0 when the runs directory does not exist', async () => {
    const dir = makeTmpDir('runcontrol-spend-missing');
    try {
      expect(await readRunEndSpend(join(dir, 'runs'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns 0 when no .jsonl files are present', async () => {
    const dir = makeTmpDir('runcontrol-spend-empty');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'notes.txt'), 'irrelevant');
      expect(await readRunEndSpend(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads totalSpentUsd from the run-end event in the latest run log', async () => {
    const dir = makeTmpDir('runcontrol-spend-found');
    try {
      const lines = [
        JSON.stringify({ type: 'harness', event: 'run-start' }),
        JSON.stringify({ type: 'harness', event: 'run-end', totalSpentUsd: 1.23 }),
      ];
      writeFileSync(join(dir, 'run-2026-01-01.jsonl'), lines.join('\n'));
      writeFileSync(join(dir, 'run-2026-06-01.jsonl'), lines.map((l) => l.replace('1.23', '4.56')).join('\n'));

      expect(await readRunEndSpend(dir)).toBe(4.56);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips malformed lines and returns 0 when no run-end event is found', async () => {
    const dir = makeTmpDir('runcontrol-spend-malformed');
    try {
      writeFileSync(join(dir, 'run-2026-01-01.jsonl'), 'not-json\n{"type":"harness","event":"run-start"}');
      expect(await readRunEndSpend(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resumeBlockedCycles', () => {
  test('returns "nothing-blocked" when there is no task-queue.json', async () => {
    const dir = makeTmpDir('runcontrol-resume-noqueue');
    try {
      expect(await resumeBlockedCycles(dir)).toBe('nothing-blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns "nothing-blocked" when no cycles are blocked', async () => {
    const dir = makeTmpDir('runcontrol-resume-noneblocked');
    try {
      const harnessDir = join(dir, '.harness');
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, 'task-queue.json'),
        JSON.stringify({ cycles: [{ id: 'c1', status: 'pending' }] }),
      );

      expect(await resumeBlockedCycles(dir)).toBe('nothing-blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks session-limit-only blocked cycles pending without prompting', async () => {
    const dir = makeTmpDir('runcontrol-resume-sessionlimit');
    try {
      const harnessDir = join(dir, '.harness');
      mkdirSync(harnessDir, { recursive: true });
      const queueFile = join(harnessDir, 'task-queue.json');
      writeFileSync(
        queueFile,
        JSON.stringify({
          cycles: [
            { id: 'c1', status: 'blocked', blockedType: 'session-limit', blockedReason: 'limit hit' },
          ],
        }),
      );

      const result = await resumeBlockedCycles(dir);
      expect(result).toBe('session-limit-only');

      const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
      expect(queue.cycles[0].status).toBe('pending');
      expect(queue.cycles[0].blockedType).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
