import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCycleOutput,
  validateTaskQueue,
  CRITICAL_OUTPUT_FILES,
  CONSERVATIVE_DEFAULTS,
} from '../src/cycle-schemas.mjs';

// ── validateCycleOutput ───────────────────────────────────────────────────────

test('validates a valid test.json', () => {
  const result = validateCycleOutput('test.json', {
    passed: true,
    targetsRun: ['build', 'test'],
    failures: [],
    failedSurfaces: [],
  });
  assert.equal(result.valid, true);
});

test('rejects test.json missing required passed field', () => {
  const result = validateCycleOutput('test.json', {
    targetsRun: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('passed')));
});

test('validates a valid implement report', () => {
  const result = validateCycleOutput('implement-backend.json', {
    filesChanged: [{ path: 'api/src/foo.ts', summary: 'added route' }],
    outOfScopeGaps: [],
    notes: 'done',
  });
  assert.equal(result.valid, true);
});

test('accepts mixed string/object filesChanged', () => {
  const result = validateCycleOutput('implement-frontend.json', {
    filesChanged: ['web/src/page.tsx', { path: 'web/src/comp.tsx' }],
    outOfScopeGaps: [],
  });
  assert.equal(result.valid, true);
});

test('skips unknown output files', () => {
  const result = validateCycleOutput('unknown-file.json', { anything: true });
  assert.equal(result.valid, true);
  assert.equal(result.skipped, true);
});

test('validates explore.json loosely (passthrough)', () => {
  const result = validateCycleOutput('explore.json', {
    task: 'map surfaces',
    findings: ['api/', 'web/'],
    summary: 'two surfaces found',
  });
  assert.equal(result.valid, true);
});

test('validates reconcile.json', () => {
  const result = validateCycleOutput('reconcile.json', {
    contractsAligned: true,
    redelegationLog: [{ gap: 'missing type', agent: 'backend-subagent', spawned: true, result: 'pass' }],
    consistencyPassed: true,
    residualRisks: [],
  });
  assert.equal(result.valid, true);
});

test('accepts object residualRisks entries in reconcile.json', () => {
  const result = validateCycleOutput('reconcile.json', {
    contractsAligned: false,
    redelegationLog: [],
    consistencyPassed: false,
    residualRisks: [{ id: 'R-1', description: 'prisma change needed' }],
  });
  assert.equal(result.valid, true);
});

// ── validateTaskQueue ─────────────────────────────────────────────────────────

test('validates a minimal valid task queue', () => {
  const result = validateTaskQueue({
    task: 'add payments page',
    promptType: 'implement-feature',
    cycles: [
      { id: 'explore', type: 'explore', status: 'pending', outputFile: 'explore.json' },
      { id: 'deliver', type: 'deliver', status: 'pending' },
    ],
  });
  assert.equal(result.valid, true);
});

test('rejects task queue with unknown promptType', () => {
  const result = validateTaskQueue({
    task: 'add thing',
    promptType: 'unknown-type',
    cycles: [],
  });
  assert.equal(result.valid, false);
});

test('rejects task queue missing task field', () => {
  const result = validateTaskQueue({
    promptType: 'fix-bug',
    cycles: [],
  });
  assert.equal(result.valid, false);
});

// ── Constants ─────────────────────────────────────────────────────────────────

test('test.json is in CRITICAL_OUTPUT_FILES', () => {
  assert.ok(CRITICAL_OUTPUT_FILES.has('test.json'));
});

test('CONSERVATIVE_DEFAULTS for test.json sets passed: false', () => {
  assert.equal(CONSERVATIVE_DEFAULTS['test.json'].passed, false);
  assert.ok(Array.isArray(CONSERVATIVE_DEFAULTS['test.json'].targetsRun));
});
