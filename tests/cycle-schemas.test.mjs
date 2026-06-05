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
  expect(result.valid).toBe(true);
});

test('rejects test.json missing required passed field', () => {
  const result = validateCycleOutput('test.json', {
    targetsRun: [],
  });
  expect(result.valid).toBe(false);
  expect(result.errors.some(e => e.includes('passed'))).toBe(true);
});

test('validates a valid implement report', () => {
  const result = validateCycleOutput('implement-backend.json', {
    filesChanged: [{ path: 'api/src/foo.ts', summary: 'added route' }],
    outOfScopeGaps: [],
    notes: 'done',
  });
  expect(result.valid).toBe(true);
});

test('accepts mixed string/object filesChanged', () => {
  const result = validateCycleOutput('implement-frontend.json', {
    filesChanged: ['web/src/page.tsx', { path: 'web/src/comp.tsx' }],
    outOfScopeGaps: [],
  });
  expect(result.valid).toBe(true);
});

test('skips unknown output files', () => {
  const result = validateCycleOutput('unknown-file.json', { anything: true });
  expect(result.valid).toBe(true);
  expect(result.skipped).toBe(true);
});

test('validates explore.json loosely (passthrough)', () => {
  const result = validateCycleOutput('explore.json', {
    task: 'map surfaces',
    findings: ['api/', 'web/'],
    summary: 'two surfaces found',
  });
  expect(result.valid).toBe(true);
});

test('validates reconcile.json', () => {
  const result = validateCycleOutput('reconcile.json', {
    contractsAligned: true,
    redelegationLog: [{ gap: 'missing type', agent: 'backend-subagent', spawned: true, result: 'pass' }],
    consistencyPassed: true,
    residualRisks: [],
  });
  expect(result.valid).toBe(true);
});

test('accepts object residualRisks entries in reconcile.json', () => {
  const result = validateCycleOutput('reconcile.json', {
    contractsAligned: false,
    redelegationLog: [],
    consistencyPassed: false,
    residualRisks: [{ id: 'R-1', description: 'prisma change needed' }],
  });
  expect(result.valid).toBe(true);
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
  expect(result.valid).toBe(true);
});

test('rejects task queue with unknown promptType', () => {
  const result = validateTaskQueue({
    task: 'add thing',
    promptType: 'unknown-type',
    cycles: [],
  });
  expect(result.valid).toBe(false);
});

test('rejects task queue missing task field', () => {
  const result = validateTaskQueue({
    promptType: 'fix-bug',
    cycles: [],
  });
  expect(result.valid).toBe(false);
});

// ── Constants ─────────────────────────────────────────────────────────────────

test('test.json is in CRITICAL_OUTPUT_FILES', () => {
  expect(CRITICAL_OUTPUT_FILES.has('test.json')).toBe(true);
});

test('CONSERVATIVE_DEFAULTS for test.json sets passed: false', () => {
  expect(CONSERVATIVE_DEFAULTS['test.json'].passed).toBe(false);
  expect(Array.isArray(CONSERVATIVE_DEFAULTS['test.json'].targetsRun)).toBe(true);
});
