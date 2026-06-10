/**
 * Cross-module integration tests: verifies that the refactored engine modules
 * wire together correctly and that re-export facades still satisfy the same
 * API surface as the original monolithic files.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── facade re-export surface checks ──────────────────────────────────────────

describe('run-control.mjs facade re-exports', () => {
  test('clearHarnessState is exported from run-control.mjs', async () => {
    const { clearHarnessState } = await import('../../src/cli/helpers/run-control.mjs');
    expect(typeof clearHarnessState).toBe('function');
  });

  test('readRunEndSpend is exported from run-control.mjs', async () => {
    const { readRunEndSpend } = await import('../../src/cli/helpers/run-control.mjs');
    expect(typeof readRunEndSpend).toBe('function');
  });

  test('spawnRun is exported from run-control.mjs', async () => {
    const { spawnRun } = await import('../../src/cli/helpers/run-control.mjs');
    expect(typeof spawnRun).toBe('function');
  });

  test('spawnResumedRun is exported from run-control.mjs', async () => {
    const { spawnResumedRun } = await import('../../src/cli/helpers/run-control.mjs');
    expect(typeof spawnResumedRun).toBe('function');
  });

  test('resumeBlockedCycles is exported from run-control.mjs', async () => {
    const { resumeBlockedCycles } = await import('../../src/cli/helpers/run-control.mjs');
    expect(typeof resumeBlockedCycles).toBe('function');
  });
});

describe('surfaces.mjs facade re-exports', () => {
  test('detectSurfaces is exported from surfaces.mjs', async () => {
    const { detectSurfaces } = await import('../../src/cli/helpers/surfaces.mjs');
    expect(typeof detectSurfaces).toBe('function');
  });

  test('confirmSurfaces is exported from surfaces.mjs', async () => {
    const { confirmSurfaces } = await import('../../src/cli/helpers/surfaces.mjs');
    expect(typeof confirmSurfaces).toBe('function');
  });

  test('patchAgentScopes is exported from surfaces.mjs', async () => {
    const { patchAgentScopes } = await import('../../src/cli/helpers/surfaces.mjs');
    expect(typeof patchAgentScopes).toBe('function');
  });

  test('applySurfaces is exported from surfaces.mjs', async () => {
    const { applySurfaces } = await import('../../src/cli/helpers/surfaces.mjs');
    expect(typeof applySurfaces).toBe('function');
  });

  test('PRUNE_DIRS is a Set exported from surfaces.mjs', async () => {
    const { PRUNE_DIRS } = await import('../../src/cli/helpers/surfaces.mjs');
    expect(PRUNE_DIRS instanceof Set).toBe(true);
    expect(PRUNE_DIRS.size).toBeGreaterThan(0);
  });

  test('SURFACE_PATTERNS is an array of objects with key and re properties', async () => {
    const { SURFACE_PATTERNS } = await import('../../src/cli/helpers/surfaces.mjs');
    expect(Array.isArray(SURFACE_PATTERNS)).toBe(true);
    expect(SURFACE_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of SURFACE_PATTERNS) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('re');
      expect(entry.re).toBeInstanceOf(RegExp);
    }
  });
});

// ── engine module factory wiring ──────────────────────────────────────────────

describe('createQueueManager factory returns required methods', () => {
  test('all expected methods are functions', async () => {
    const dir = makeTmpDir('integration-qm');
    try {
      const { createQueueManager } = await import('../../src/engine/queue-manager.mjs');
      const mgr = createQueueManager({
        QUEUE_FILE: join(dir, 'q.json'),
        CONFIGURED_AGENTS: {},
        appendLog: () => {},
      });
      expect(typeof mgr.readQueue).toBe('function');
      expect(typeof mgr.writeQueue).toBe('function');
      expect(typeof mgr.printPendingQueue).toBe('function');
      expect(typeof mgr.nextPendingCycle).toBe('function');
      expect(typeof mgr.nextCycleBatch).toBe('function');
      expect(typeof mgr.injectAdditionalGroups).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createScopeManager factory returns required methods', () => {
  test('all expected methods are functions', async () => {
    const { createScopeManager } = await import('../../src/engine/scope-manager.mjs');
    const mgr = createScopeManager({
      CONFIGURED_AGENTS: {},
      ROOT: tmpdir(),
      CYCLE_DIR: tmpdir(),
      readCycleState: () => null,
      restoreFromSnapshot: () => false,
      appendLog: () => {},
    });
    expect(typeof mgr.checkAndRevertScopeViolations).toBe('function');
    expect(typeof mgr.autoUpdateScope).toBe('function');
    expect(typeof mgr.buildScopeCleanupCycle).toBe('function');
  });
});

describe('createPromptBuilder factory returns required methods', () => {
  test('buildCyclePrompt is a function', async () => {
    const dir = makeTmpDir('integration-pb');
    try {
      mkdirSync(join(dir, 'prompts'), { recursive: true });
      mkdirSync(join(dir, 'agents'), { recursive: true });
      mkdirSync(join(dir, 'cycle-state'), { recursive: true });
      const { createPromptBuilder } = await import('../../src/engine/prompt-builder.mjs');
      const pb = createPromptBuilder({
        PROMPTS_DIR: join(dir, 'prompts'),
        AGENTS_DIR: join(dir, 'agents'),
        CYCLE_DIR: join(dir, 'cycle-state'),
        CYCLE_STATE_RELDIR: '.harness/cycle-state',
        CONFIGURED_AGENTS: {},
        userTask: 'test task',
        readCycleState: () => null,
        readQueue: () => null,
      });
      expect(typeof pb.buildCyclePrompt).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── queue + scope manager cross-module interaction ────────────────────────────

describe('queue-manager + scope-manager integration', () => {
  test('scope-manager.checkAndRevertScopeViolations returns undefined for non-implement cycle', async () => {
    const { createScopeManager } = await import('../../src/engine/scope-manager.mjs');
    const { checkAndRevertScopeViolations } = createScopeManager({
      CONFIGURED_AGENTS: { 'backend-subagent': { scope: ['apps/api/'] } },
      ROOT: tmpdir(),
      CYCLE_DIR: tmpdir(),
      readCycleState: () => null,
      restoreFromSnapshot: () => false,
      appendLog: () => {},
    });
    // reconcile and deliver cycles should be a no-op
    expect(checkAndRevertScopeViolations({ type: 'reconcile', agent: 'backend-subagent' })).toBeUndefined();
    expect(checkAndRevertScopeViolations({ type: 'deliver' })).toBeUndefined();
  });

  test('scope-manager.buildScopeCleanupCycle produces a valid cycle object', async () => {
    const { createScopeManager } = await import('../../src/engine/scope-manager.mjs');
    const { buildScopeCleanupCycle } = createScopeManager({
      CONFIGURED_AGENTS: {
        'backend-subagent': { scope: ['apps/api/'] },
      },
      ROOT: tmpdir(),
      CYCLE_DIR: tmpdir(),
      readCycleState: () => null,
      restoreFromSnapshot: () => false,
      appendLog: () => {},
    });
    // signature: buildScopeCleanupCycle(cycle, failedFiles)
    const fakeCycle = { id: 'implement-backend-feature', type: 'implement-backend', agent: 'backend-subagent' };
    const failedFiles = ['apps/web/foo.ts'];
    const cycle = buildScopeCleanupCycle(fakeCycle, failedFiles);
    expect(cycle).toHaveProperty('type');
    expect(cycle).toHaveProperty('id');
    expect(typeof cycle.type).toBe('string');
    expect(cycle.id).toMatch(/scope-cleanup/);
  });

  test('queue writeQueue + nextCycleBatch + scope check interaction', async () => {
    const dir = makeTmpDir('integration-qm-scope');
    try {
      const { createQueueManager } = await import('../../src/engine/queue-manager.mjs');
      const { createScopeManager } = await import('../../src/engine/scope-manager.mjs');

      const QUEUE_FILE = join(dir, 'task-queue.json');
      const CYCLE_DIR = join(dir, 'cycle-state');
      mkdirSync(CYCLE_DIR, { recursive: true });

      const agents = {
        'backend-subagent': { scope: ['apps/api/'] },
        'frontend-subagent': { scope: ['apps/web/'] },
      };

      const { writeQueue, nextCycleBatch } = createQueueManager({
        QUEUE_FILE,
        CONFIGURED_AGENTS: agents,
        appendLog: () => {},
      });
      const { checkAndRevertScopeViolations } = createScopeManager({
        CONFIGURED_AGENTS: agents,
        ROOT: dir,
        CYCLE_DIR,
        readCycleState: () => null,
        restoreFromSnapshot: () => false,
        appendLog: () => {},
      });

      const queue = {
        cycles: [
          { id: 'impl-b', type: 'implement-backend', agent: 'backend-subagent', status: 'pending', parallel: true },
          { id: 'impl-f', type: 'implement-frontend', agent: 'frontend-subagent', status: 'pending', parallel: true },
        ],
      };
      writeQueue(queue);

      const batch = nextCycleBatch(queue);
      expect(batch).toHaveLength(2);

      // Scope check on completed implement cycle (no outputFile → no-op, no throw)
      const result = checkAndRevertScopeViolations(batch[0]);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── constants propagate into queue-manager ────────────────────────────────────

describe('constants used inside queue-manager', () => {
  test('SEQUENTIAL_TYPES match actual batch serialisation behaviour', async () => {
    const { SEQUENTIAL_TYPES } = await import('../../src/engine/constants.mjs');
    const { createQueueManager } = await import('../../src/engine/queue-manager.mjs');
    const dir = makeTmpDir('integration-seq');
    try {
      const { nextCycleBatch } = createQueueManager({
        QUEUE_FILE: join(dir, 'q.json'),
        CONFIGURED_AGENTS: {},
        appendLog: () => {},
      });

      for (const seqType of SEQUENTIAL_TYPES) {
        const queue = {
          cycles: [
            { id: `${seqType}-1`, type: seqType, status: 'pending', parallel: true },
            { id: `${seqType}-2`, type: seqType, status: 'pending', parallel: true },
          ],
        };
        const batch = nextCycleBatch(queue);
        expect(batch).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
