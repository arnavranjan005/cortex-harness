/**
 * Tests for src/cli/commands/chain/blocked-state.mjs
 * Covers all branches of readBlockedTypes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readBlockedTypes } from '../../../../src/cli/commands/chain/blocked-state.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeQueue(dir, data) {
  writeFileSync(join(dir, 'task-queue.json'), JSON.stringify(data, null, 2));
  return join(dir, 'task-queue.json');
}

describe('readBlockedTypes', () => {
  test('returns all-false when file does not exist', () => {
    const dir = makeTmpDir('blocked-nofile');
    try {
      const result = readBlockedTypes(join(dir, 'task-queue.json'));
      expect(result).toEqual({ hasAny: false, hasHumanInput: false, hasSessionLimit: false, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns all-false when file contains malformed JSON', () => {
    const dir = makeTmpDir('blocked-malformed');
    try {
      const queueFile = join(dir, 'task-queue.json');
      writeFileSync(queueFile, 'not-json');
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: false, hasHumanInput: false, hasSessionLimit: false, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns all-false when no cycles are blocked', () => {
    const dir = makeTmpDir('blocked-none');
    try {
      const queueFile = writeQueue(dir, {
        cycles: [
          { id: 'c1', type: 'orchestrate', status: 'done' },
          { id: 'c2', type: 'implement-backend', status: 'pending' },
        ],
      });
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: false, hasHumanInput: false, hasSessionLimit: false, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns hasAny=true, hasHumanInput=true when needs-human-input block present', () => {
    const dir = makeTmpDir('blocked-human');
    try {
      const queueFile = writeQueue(dir, {
        cycles: [
          { id: 'c1', type: 'orchestrate', status: 'done' },
          { id: 'c2', type: 'implement-backend', status: 'blocked', blockedType: 'needs-human-input' },
        ],
      });
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: true, hasHumanInput: true, hasSessionLimit: false, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns hasAny=true, hasSessionLimit=true when session-limit block present', () => {
    const dir = makeTmpDir('blocked-session');
    try {
      const queueFile = writeQueue(dir, {
        cycles: [
          { id: 'c1', type: 'orchestrate', status: 'done' },
          { id: 'c2', type: 'implement-backend', status: 'blocked', blockedType: 'session-limit' },
        ],
      });
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: true, hasHumanInput: false, hasSessionLimit: true, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns sessionLimitReason from blockedReason when present', () => {
    const dir = makeTmpDir('blocked-session-reason');
    try {
      const queueFile = writeQueue(dir, {
        cycles: [
          { id: 'c1', type: 'implement-backend', status: 'blocked', blockedType: 'session-limit', blockedReason: 'session/weekly limit hit — resets 6/10/2026, 9:50:00 PM' },
        ],
      });
      expect(readBlockedTypes(queueFile)).toEqual({
        hasAny: true,
        hasHumanInput: false,
        hasSessionLimit: true,
        sessionLimitReason: 'session/weekly limit hit — resets 6/10/2026, 9:50:00 PM',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns both flags true when both block types present', () => {
    const dir = makeTmpDir('blocked-mixed');
    try {
      const queueFile = writeQueue(dir, {
        cycles: [
          { id: 'c1', type: 'implement-backend', status: 'blocked', blockedType: 'needs-human-input' },
          { id: 'c2', type: 'implement-frontend', status: 'blocked', blockedType: 'session-limit' },
        ],
      });
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: true, hasHumanInput: true, hasSessionLimit: true, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores non-blocked cycles with blockedType set', () => {
    const dir = makeTmpDir('blocked-ignore-done');
    try {
      const queueFile = writeQueue(dir, {
        cycles: [
          // status=done, but blockedType present — should NOT count as blocked
          { id: 'c1', type: 'implement-backend', status: 'done', blockedType: 'needs-human-input' },
        ],
      });
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: false, hasHumanInput: false, hasSessionLimit: false, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handles queue with no cycles key gracefully', () => {
    const dir = makeTmpDir('blocked-nocycles');
    try {
      const queueFile = writeQueue(dir, { task: 'hello' });
      expect(readBlockedTypes(queueFile)).toEqual({ hasAny: false, hasHumanInput: false, hasSessionLimit: false, sessionLimitReason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
