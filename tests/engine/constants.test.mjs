/**
 * Tests for src/engine/constants.mjs
 * Verifies exported values and the getTurnCap helper.
 */
import {
  SAFETY_TURN_CAP,
  MAX_BUDGET_USD,
  DEAD_MAN_MS,
  MAX_RETRIES,
  RESULT_GRACE_MS,
  TURN_CAP,
  TEST_MAX_RETRIES_CLEAN,
  SMOKE_MAX_RETRIES_CLEAN,
  isWindows,
  SEQUENTIAL_TYPES,
  getTurnCap,
} from '../../src/engine/constants.mjs';

describe('constant values', () => {
  test('SAFETY_TURN_CAP is a positive integer', () => {
    expect(Number.isInteger(SAFETY_TURN_CAP) && SAFETY_TURN_CAP > 0).toBe(true);
  });

  test('MAX_BUDGET_USD is a positive number', () => {
    expect(MAX_BUDGET_USD).toBeGreaterThan(0);
  });

  test('DEAD_MAN_MS is 20 minutes in milliseconds', () => {
    expect(DEAD_MAN_MS).toBe(20 * 60 * 1000);
  });

  test('RESULT_GRACE_MS is 15 seconds in milliseconds', () => {
    expect(RESULT_GRACE_MS).toBe(15_000);
  });

  test('MAX_RETRIES is 2', () => {
    expect(MAX_RETRIES).toBe(2);
  });

  test('TEST_MAX_RETRIES_CLEAN is greater than MAX_RETRIES', () => {
    expect(TEST_MAX_RETRIES_CLEAN).toBeGreaterThan(MAX_RETRIES);
  });

  test('isWindows reflects process.platform', () => {
    expect(isWindows).toBe(process.platform === 'win32');
  });
});

describe('SEQUENTIAL_TYPES', () => {
  const expected = ['test', 'reconcile', 'deliver', 'recover', 'recovery', 'orchestrate'];

  test.each(expected)('contains "%s"', (type) => {
    expect(SEQUENTIAL_TYPES.has(type)).toBe(true);
  });

  test('does not contain implement types (they are parallel-eligible)', () => {
    expect(SEQUENTIAL_TYPES.has('implement-backend')).toBe(false);
    expect(SEQUENTIAL_TYPES.has('implement-frontend')).toBe(false);
  });
});

describe('getTurnCap', () => {
  test('returns TURN_CAP value for "test" cycle type', () => {
    expect(getTurnCap({ type: 'test' })).toBe(TURN_CAP.test);
    expect(TURN_CAP.test).toBeGreaterThan(0);
  });

  test('returns TURN_CAP value for "smoke" cycle type', () => {
    expect(getTurnCap({ type: 'smoke' })).toBe(TURN_CAP.smoke);
    expect(TURN_CAP.smoke).toBe(20);
  });

  test('smoke turn cap is less than test turn cap', () => {
    expect(TURN_CAP.smoke).toBeLessThan(TURN_CAP.test);
  });

  test('returns Infinity for cycle types with no explicit cap', () => {
    expect(getTurnCap({ type: 'implement-backend' })).toBe(Infinity);
    expect(getTurnCap({ type: 'reconcile' })).toBe(Infinity);
    expect(getTurnCap({ type: 'deliver' })).toBe(Infinity);
    expect(getTurnCap({ type: 'orchestrate' })).toBe(Infinity);
  });
});

describe('SMOKE_MAX_RETRIES_CLEAN', () => {
  test('equals 10', () => {
    expect(SMOKE_MAX_RETRIES_CLEAN).toBe(10);
  });

  test('is greater than MAX_RETRIES', () => {
    expect(SMOKE_MAX_RETRIES_CLEAN).toBeGreaterThan(MAX_RETRIES);
  });

  test('matches TEST_MAX_RETRIES_CLEAN', () => {
    expect(SMOKE_MAX_RETRIES_CLEAN).toBe(TEST_MAX_RETRIES_CLEAN);
  });
});

describe('SEQUENTIAL_TYPES smoke membership', () => {
  test('smoke is in SEQUENTIAL_TYPES', () => {
    expect(SEQUENTIAL_TYPES.has('smoke')).toBe(true);
  });
});
