/**
 * Tests for src/engine/queue-manager.mjs
 * Covers queue I/O, batch selection, parallel-safety checks, and group injection.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createQueueManager } from '../../src/engine/queue-manager.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeManager(dir, agents = {}) {
  const QUEUE_FILE = join(dir, 'task-queue.json');
  const logs = [];
  const { readQueue, writeQueue, printPendingQueue, nextPendingCycle, nextCycleBatch, injectAdditionalGroups } =
    createQueueManager({
      QUEUE_FILE,
      CONFIGURED_AGENTS: agents,
      appendLog: (obj) => logs.push(obj),
    });
  return { QUEUE_FILE, readQueue, writeQueue, printPendingQueue, nextPendingCycle, nextCycleBatch, injectAdditionalGroups, logs };
}

// ── readQueue / writeQueue ────────────────────────────────────────────────────

describe('readQueue / writeQueue', () => {
  test('readQueue returns null when file does not exist', () => {
    const dir = makeTmpDir('qm-nofile');
    try {
      const { readQueue } = makeManager(dir);
      expect(readQueue()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeQueue then readQueue roundtrips correctly', () => {
    const dir = makeTmpDir('qm-roundtrip');
    try {
      const { readQueue, writeQueue } = makeManager(dir);
      const queue = { task: 'hello', cycles: [{ id: 'c1', type: 'orchestrate', status: 'pending' }] };
      writeQueue(queue);
      expect(readQueue()).toEqual(queue);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readQueue returns null on malformed JSON', () => {
    const dir = makeTmpDir('qm-malformed');
    try {
      const { readQueue, QUEUE_FILE } = makeManager(dir);
      writeFileSync(QUEUE_FILE, 'not-json');
      expect(readQueue()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── nextCycleBatch ────────────────────────────────────────────────────────────

describe('nextCycleBatch', () => {
  test('returns null when queue has no pending cycles', () => {
    const dir = makeTmpDir('qm-batch-done');
    try {
      const { nextCycleBatch } = makeManager(dir);
      const queue = { cycles: [{ id: 'c1', type: 'orchestrate', status: 'done' }] };
      expect(nextCycleBatch(queue)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns single-element batch when cycle is not parallel', () => {
    const dir = makeTmpDir('qm-batch-single');
    try {
      const { nextCycleBatch } = makeManager(dir);
      const queue = { cycles: [{ id: 'c1', type: 'reconcile', status: 'pending', parallel: false }] };
      expect(nextCycleBatch(queue)).toEqual([queue.cycles[0]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns all contiguous parallel cycles with non-overlapping scopes', () => {
    const dir = makeTmpDir('qm-batch-parallel');
    try {
      const agents = {
        'backend-subagent': { scope: ['apps/api/'] },
        'frontend-subagent': { scope: ['apps/web/'] },
      };
      const { nextCycleBatch } = makeManager(dir, agents);
      const queue = {
        cycles: [
          { id: 'impl-b', type: 'implement-backend', agent: 'backend-subagent', status: 'pending', parallel: true },
          { id: 'impl-f', type: 'implement-frontend', agent: 'frontend-subagent', status: 'pending', parallel: true },
          { id: 'reconcile', type: 'reconcile', status: 'pending', parallel: false },
        ],
      };
      const batch = nextCycleBatch(queue);
      expect(batch).toHaveLength(2);
      expect(batch.map((c) => c.id)).toEqual(['impl-b', 'impl-f']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serialises parallel cycles whose scopes overlap', () => {
    const dir = makeTmpDir('qm-batch-overlap');
    try {
      const agents = {
        'backend-subagent': { scope: ['apps/api/'] },
        'frontend-subagent': { scope: ['apps/api/'] }, // same path → conflict
      };
      const { nextCycleBatch } = makeManager(dir, agents);
      const queue = {
        cycles: [
          { id: 'impl-b', type: 'implement-backend', agent: 'backend-subagent', status: 'pending', parallel: true },
          { id: 'impl-f', type: 'implement-frontend', agent: 'frontend-subagent', status: 'pending', parallel: true },
        ],
      };
      const batch = nextCycleBatch(queue);
      expect(batch).toHaveLength(1);
      expect(batch[0].id).toBe('impl-b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('forces a sequential cycle to run alone even if parallel=true', () => {
    const dir = makeTmpDir('qm-batch-seq');
    try {
      const { nextCycleBatch } = makeManager(dir);
      const queue = {
        cycles: [
          { id: 'test-1', type: 'test', status: 'pending', parallel: true },
          { id: 'test-2', type: 'test', status: 'pending', parallel: true },
        ],
      };
      const batch = nextCycleBatch(queue);
      expect(batch).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stops collecting parallel cycles at the first non-parallel cycle', () => {
    const dir = makeTmpDir('qm-batch-stop');
    try {
      const agents = {
        'backend-subagent': { scope: ['apps/api/'] },
        'frontend-subagent': { scope: ['apps/web/'] },
      };
      const { nextCycleBatch } = makeManager(dir, agents);
      const queue = {
        cycles: [
          { id: 'impl-b', type: 'implement-backend', agent: 'backend-subagent', status: 'pending', parallel: true },
          { id: 'reconcile', type: 'reconcile', status: 'pending', parallel: false },
          { id: 'impl-f', type: 'implement-frontend', agent: 'frontend-subagent', status: 'pending', parallel: true },
        ],
      };
      const batch = nextCycleBatch(queue);
      expect(batch).toHaveLength(1);
      expect(batch[0].id).toBe('impl-b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── injectAdditionalGroups ────────────────────────────────────────────────────

describe('injectAdditionalGroups', () => {
  test('returns false and leaves queue unchanged when requiresAdditionalGroups is absent', () => {
    const dir = makeTmpDir('qm-inject-empty');
    try {
      const { injectAdditionalGroups } = makeManager(dir);
      const queue = { cycles: [{ id: 'deliver', type: 'deliver', status: 'pending' }] };
      expect(injectAdditionalGroups({}, queue)).toBe(false);
      expect(queue.cycles).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns false when requiresAdditionalGroups is an empty array', () => {
    const dir = makeTmpDir('qm-inject-emptyarr');
    try {
      const { injectAdditionalGroups } = makeManager(dir);
      const queue = { cycles: [{ id: 'deliver', type: 'deliver', status: 'pending' }] };
      expect(injectAdditionalGroups({ requiresAdditionalGroups: [] }, queue)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injects full cycle sequence before the deliver cycle', () => {
    const dir = makeTmpDir('qm-inject-before-deliver');
    try {
      const { readQueue, injectAdditionalGroups, QUEUE_FILE } = makeManager(dir);
      const queue = {
        cycles: [
          { id: 'reconcile-cross-group', type: 'reconcile', status: 'done' },
          { id: 'deliver', type: 'deliver', status: 'pending' },
        ],
      };
      writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
      Object.assign(queue, JSON.parse(readFileSync(QUEUE_FILE, 'utf8')));

      const report = {
        requiresAdditionalGroups: [
          {
            group: 'payments',
            subTask: 'Add payment processing',
            suggestedPromptType: 'implement-feature',
            suggestedAgents: ['backend-subagent'],
          },
        ],
      };

      const injected = injectAdditionalGroups(report, queue);
      expect(injected).toBe(true);

      // deliver must still be last
      const lastCycle = queue.cycles[queue.cycles.length - 1];
      expect(lastCycle.type).toBe('deliver');

      // injected cycles must appear before deliver
      const deliverIdx = queue.cycles.findIndex((c) => c.type === 'deliver');
      const injectedIds = queue.cycles.slice(0, deliverIdx).map((c) => c.id);
      expect(injectedIds).toContain('explore-payments');
      expect(injectedIds).toContain('implement-backend-payments');
      expect(injectedIds).toContain('reconcile-payments');
      expect(injectedIds).toContain('test-payments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injects fix-bug reproduce cycle when promptType is fix-bug', () => {
    const dir = makeTmpDir('qm-inject-fixbug');
    try {
      const { readQueue, injectAdditionalGroups, QUEUE_FILE } = makeManager(dir);
      const queue = {
        cycles: [{ id: 'deliver', type: 'deliver', status: 'pending' }],
      };
      writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
      Object.assign(queue, JSON.parse(readFileSync(QUEUE_FILE, 'utf8')));

      const report = {
        requiresAdditionalGroups: [
          {
            group: 'bugfix-auth',
            subTask: 'Fix auth redirect',
            suggestedPromptType: 'fix-bug',
            suggestedAgents: ['backend-subagent'],
          },
        ],
      };

      injectAdditionalGroups(report, queue);
      const deliverIdx = queue.cycles.findIndex((c) => c.type === 'deliver');
      const injectedIds = queue.cycles.slice(0, deliverIdx).map((c) => c.id);
      expect(injectedIds).toContain('reproduce-bugfix-auth');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips malformed entries missing group or subTask', () => {
    const dir = makeTmpDir('qm-inject-malformed');
    try {
      const { injectAdditionalGroups, QUEUE_FILE } = makeManager(dir);
      const queue = { cycles: [{ id: 'deliver', type: 'deliver', status: 'pending' }] };
      writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));

      const report = {
        requiresAdditionalGroups: [
          { subTask: 'Missing group field' },
          { group: 'missing-subtask' },
        ],
      };

      const injected = injectAdditionalGroups(report, queue);
      expect(injected).toBe(false);
      expect(queue.cycles).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
