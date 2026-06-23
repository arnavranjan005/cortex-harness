/**
 * Tests for src/engine/cli-adapters/{claude,opencode}-adapter.mjs.
 *
 * The opencode-adapter assertions use the exact JSON lines captured from a
 * real `opencode run --format json` invocation (no mocking of OpenCode
 * itself) — see ARCHITECTURE.md / the multi-CLI scoping notes for how these
 * were obtained.
 */
import { claudeAdapter } from '../../src/engine/cli-adapters/claude-adapter.mjs';
import { opencodeAdapter } from '../../src/engine/cli-adapters/opencode-adapter.mjs';

describe('claudeAdapter.extractResult', () => {
  test('extracts model from the system/init event — confirmed live this fires first, before any assistant turn', () => {
    const event = { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', session_id: 'abc' };
    expect(claudeAdapter.extractResult(event)).toEqual({ kind: 'model_info', model: 'claude-sonnet-4-6' });
  });

  test('normalizes an assistant event with text into kind "assistant"', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  doing the thing  ' }] },
    };
    expect(claudeAdapter.extractResult(event)).toEqual({
      kind: 'assistant',
      text: 'doing the thing',
      toolCalls: [],
    });
  });

  test('normalizes an assistant event with tool calls', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'x.ts' } }],
      },
    };
    const result = claudeAdapter.extractResult(event);
    expect(result.kind).toBe('assistant');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'Read', input: { file_path: 'x.ts' } }]);
  });

  test('normalizes a user event with tool_result into kind "tool_result"', () => {
    const event = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: false }] },
    };
    expect(claudeAdapter.extractResult(event)).toEqual({
      kind: 'tool_result',
      results: [{ toolUseId: 'call_1', isError: false }],
    });
  });

  test('normalizes a result event into kind "final" with cost and turn count', () => {
    const event = { type: 'result', result: 'CYCLE_COMPLETE', num_turns: 4, total_cost_usd: 0.42 };
    expect(claudeAdapter.extractResult(event)).toEqual({
      kind: 'final',
      finalMessage: 'CYCLE_COMPLETE',
      numTurns: 4,
      costUsd: 0.42,
    });
  });

  test('returns null for an unrecognized event', () => {
    expect(claudeAdapter.extractResult({ type: 'something_else' })).toBeNull();
  });

  test('capabilities advertise full MCP/cost/stream support', () => {
    expect(claudeAdapter.capabilities).toEqual({
      supportsMcp: true,
      supportsCostTelemetry: true,
      supportsStreamEvents: true,
      mcpScopeMechanism: 'flag',
    });
  });
});

describe('opencodeAdapter.extractResult — against real captured `opencode run --format json` output', () => {
  // Captured verbatim from: opencode run "say hello in exactly 3 words"
  //   --model opencode/deepseek-v4-flash-free --format json
  const textLine =
    '{"type":"text","timestamp":1782060076937,"sessionID":"ses_114f1434effeAMtvfLl6EnS7v8","part":{"id":"prt_eeb0ecf06001j040Nlra0HuTmS","messageID":"msg_eeb0ec33c001HxF2m5o4G5CufH","sessionID":"ses_114f1434effeAMtvfLl6EnS7v8","type":"text","text":"Hello there world.","time":{"start":1782060076806,"end":1782060076867}}}';

  const stepFinishLine =
    '{"type":"step_finish","timestamp":1782060076937,"sessionID":"ses_114f1434effeAMtvfLl6EnS7v8","part":{"id":"prt_eeb0ecf58001j8bTa4FeIa79YF","reason":"stop","messageID":"msg_eeb0ec33c001HxF2m5o4G5CufH","sessionID":"ses_114f1434effeAMtvfLl6EnS7v8","type":"step-finish","tokens":{"total":8024,"input":8006,"output":5,"reasoning":13,"cache":{"write":0,"read":0}},"cost":0}}';

  // Captured verbatim from the tool-use test run (read tool on sample.txt).
  const toolUseLine =
    '{"type":"tool_use","timestamp":1782060100155,"sessionID":"ses_114f0e818ffeW6OF1RTTbjUZbH","part":{"type":"tool","tool":"read","callID":"call_00_JNJMIXberRFlnk21oLLF4648","state":{"status":"completed","input":{"filePath":"sample.txt"},"output":"test content"},"id":"prt_eeb0f28e3001TCjV9KgsfU07YF","sessionID":"ses_114f0e818ffeW6OF1RTTbjUZbH","messageID":"msg_eeb0f1dec001UFVhh89KlNpnqm"}}';

  // Captured verbatim from the write-tool test run (cost still 0 — free model).
  const stepFinishWithCostLine =
    '{"type":"step_finish","timestamp":1782060601539,"sessionID":"ses_114e93fd7ffexvHQ3t1N8LG6B0","part":{"id":"prt_eeb16d098001bWmiSID2iROGYr","reason":"tool-calls","messageID":"msg_eeb16c5c1001IDYZag01jVneBk","sessionID":"ses_114e93fd7ffexvHQ3t1N8LG6B0","type":"step-finish","tokens":{"total":8122,"input":8015,"output":89,"reasoning":18,"cache":{"write":0,"read":0}},"cost":0}}';

  test('parseEventLine parses real captured JSON lines', () => {
    expect(opencodeAdapter.parseEventLine(textLine)).not.toBeNull();
    expect(opencodeAdapter.parseEventLine(stepFinishLine)).not.toBeNull();
    expect(opencodeAdapter.parseEventLine('not json')).toBeNull();
  });

  test('extractResult normalizes a "text" event into kind "assistant"', () => {
    const event = opencodeAdapter.parseEventLine(textLine);
    expect(opencodeAdapter.extractResult(event)).toEqual({
      kind: 'assistant',
      text: 'Hello there world.',
      toolCalls: [],
      sessionID: event.sessionID,
    });
  });

  test('extractResult normalizes a "tool_use" event into kind "assistant" with the tool call', () => {
    const event = opencodeAdapter.parseEventLine(toolUseLine);
    const result = opencodeAdapter.extractResult(event);
    expect(result.kind).toBe('assistant');
    expect(result.toolCalls).toEqual([
      { id: 'call_00_JNJMIXberRFlnk21oLLF4648', name: 'read', input: { filePath: 'sample.txt' }, isError: false },
    ]);
  });

  test('extractResult normalizes a "step_finish" event into kind "turn" with real cost and token telemetry', () => {
    const event = opencodeAdapter.parseEventLine(stepFinishLine);
    expect(opencodeAdapter.extractResult(event)).toEqual({
      kind: 'turn',
      costUsd: 0,
      tokens: { total: 8024, input: 8006, output: 5, reasoning: 13, cache: { write: 0, read: 0 } },
      reason: 'stop',
      sessionID: event.sessionID,
    });
  });

  test('extractResult on a second step_finish (tool-calls reason) still reports cost/tokens', () => {
    const event = opencodeAdapter.parseEventLine(stepFinishWithCostLine);
    const result = opencodeAdapter.extractResult(event);
    expect(result.kind).toBe('turn');
    expect(result.costUsd).toBe(0);
    expect(result.tokens.total).toBe(8122);
    expect(result.reason).toBe('tool-calls');
  });

  test('extractResult returns null for a "step_start" event (no turn/cost info)', () => {
    const event = { type: 'step_start', part: { type: 'step-start' } };
    expect(opencodeAdapter.extractResult(event)).toBeNull();
  });

  test('capabilities reflect config-file-based MCP scoping (no per-invocation override)', () => {
    expect(opencodeAdapter.capabilities).toEqual({
      supportsMcp: false,
      supportsCostTelemetry: true,
      supportsStreamEvents: true,
      mcpScopeMechanism: 'config-file',
    });
  });
});
