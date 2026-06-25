/**
 * Tests for src/engine/cli-adapters/output-normalize.mjs
 */
import { normalizeAdapterOutput } from '../../src/engine/cli-adapters/output-normalize.mjs';
import { claudeAdapter } from '../../src/engine/cli-adapters/claude-adapter.mjs';
import { opencodeAdapter } from '../../src/engine/cli-adapters/opencode-adapter.mjs';

describe('normalizeAdapterOutput', () => {
  test('passes plain text through unchanged for "text" outputFormat', () => {
    const result = normalizeAdapterOutput(claudeAdapter, 'CYCLE_COMPLETE', 'text');
    expect(result).toBe('CYCLE_COMPLETE');
  });

  test('accumulates assistant text events for "json-stream" outputFormat', () => {
    const rawOutput = [
      JSON.stringify({ type: 'step_start', part: {} }),
      JSON.stringify({ type: 'text', part: { text: 'hello' } }),
      JSON.stringify({ type: 'text', part: { text: 'world' } }),
      JSON.stringify({ type: 'step_finish', part: { cost: 0, reason: 'stop' } }),
    ].join('\n');

    const result = normalizeAdapterOutput(opencodeAdapter, rawOutput, 'json-stream');
    expect(result).toBe('hello\nworld');
  });

  test('falls back to rawOutput when json-stream parsing yields no assistant text', () => {
    const result = normalizeAdapterOutput(opencodeAdapter, 'not actually json', 'json-stream');
    expect(result).toBe('not actually json');
  });

  test('returns rawOutput unchanged when adapter has no parseEventLine', () => {
    const fakeAdapter = {};
    const result = normalizeAdapterOutput(fakeAdapter, 'some output', 'json-stream');
    expect(result).toBe('some output');
  });
});
