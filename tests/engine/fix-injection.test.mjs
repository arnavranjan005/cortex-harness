/**
 * Tests for the surface-name normalization logic used in fix injection.
 * The same regex is applied in run-autonomous.mjs when converting
 * failedSurfaces[] from the tester agent into valid cycle ID segments.
 */

// Matches the normalization applied in run-autonomous.mjs:
//   .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown')
const normalizeSurface = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';

describe('surface name normalization', () => {
  test('lowercase alphanumeric passthrough', () => {
    expect(normalizeSurface('backend')).toBe('backend');
    expect(normalizeSurface('frontend')).toBe('frontend');
  });

  test('uppercased surface is lowercased', () => {
    expect(normalizeSurface('Backend')).toBe('backend');
    expect(normalizeSurface('FRONTEND')).toBe('frontend');
  });

  test('spaces become hyphens', () => {
    expect(normalizeSurface('back end')).toBe('back-end');
    expect(normalizeSurface('my surface name')).toBe('my-surface-name');
  });

  test('leading/trailing non-alphanumeric chars stripped', () => {
    expect(normalizeSurface('/backend/')).toBe('backend');
    expect(normalizeSurface('---backend---')).toBe('backend');
  });

  test('URL-like strings collapse to valid slug', () => {
    expect(normalizeSurface('http://localhost:3000')).toBe('http-localhost-3000');
    expect(normalizeSurface('/api/v1/users')).toBe('api-v1-users');
  });

  test('empty string falls back to "unknown"', () => {
    expect(normalizeSurface('')).toBe('unknown');
  });

  test('string of only special chars falls back to "unknown"', () => {
    expect(normalizeSurface('---')).toBe('unknown');
    expect(normalizeSurface('///')).toBe('unknown');
  });

  test('already valid kebab-case is unchanged', () => {
    expect(normalizeSurface('my-surface')).toBe('my-surface');
    expect(normalizeSurface('implement-backend')).toBe('implement-backend');
  });

  test('consecutive special chars collapse to single hyphen', () => {
    expect(normalizeSurface('my  surface')).toBe('my-surface');
    expect(normalizeSurface('my__surface')).toBe('my-surface');
  });
});

/**
 * Tests for totalAttempts counter logic used to prevent infinite fix-injection loops.
 * This logic lives inline in run-autonomous.mjs; we verify the pure array-filter
 * equivalent here to guard against regressions.
 */
describe('totalAttempts counter logic', () => {
  function countDoneCycles(cycles, type, taskGroup) {
    return cycles.filter(
      (c) =>
        c.type === type &&
        (taskGroup ? c.taskGroup === taskGroup : !c.taskGroup) &&
        c.status === 'done',
    ).length;
  }

  test('counts only done cycles of the given type', () => {
    const cycles = [
      { type: 'test', taskGroup: null, status: 'done' },
      { type: 'test', taskGroup: null, status: 'pending' },
      { type: 'test', taskGroup: null, status: 'done' },
    ];
    expect(countDoneCycles(cycles, 'test', null)).toBe(2);
  });

  test('does not count other types', () => {
    const cycles = [
      { type: 'test', taskGroup: null, status: 'done' },
      { type: 'smoke', taskGroup: null, status: 'done' },
    ];
    expect(countDoneCycles(cycles, 'test', null)).toBe(1);
    expect(countDoneCycles(cycles, 'smoke', null)).toBe(1);
  });

  test('respects taskGroup boundary — does not mix groups', () => {
    const cycles = [
      { type: 'test', taskGroup: 'g1', status: 'done' },
      { type: 'test', taskGroup: 'g2', status: 'done' },
      { type: 'test', taskGroup: 'g1', status: 'done' },
    ];
    expect(countDoneCycles(cycles, 'test', 'g1')).toBe(2);
    expect(countDoneCycles(cycles, 'test', 'g2')).toBe(1);
  });

  test('null taskGroup only matches cycles with no taskGroup', () => {
    const cycles = [
      { type: 'test', taskGroup: null, status: 'done' },
      { type: 'test', taskGroup: 'g1', status: 'done' },
    ];
    expect(countDoneCycles(cycles, 'test', null)).toBe(1);
  });

  test('returns 0 when no done cycles exist', () => {
    const cycles = [
      { type: 'test', taskGroup: null, status: 'pending' },
    ];
    expect(countDoneCycles(cycles, 'test', null)).toBe(0);
  });

  test('exceeds MAX_RETRIES gate after 3 done cycles (recovery trigger)', () => {
    const MAX_RETRIES = 2;
    const cycles = [
      { type: 'test', taskGroup: null, status: 'done' },
      { type: 'test', taskGroup: null, status: 'done' },
      { type: 'test', taskGroup: null, status: 'done' },
    ];
    const total = countDoneCycles(cycles, 'test', null);
    // recovery fires when total > MAX_RETRIES (i.e. 3 > 2)
    expect(total).toBeGreaterThan(MAX_RETRIES);
  });
});
