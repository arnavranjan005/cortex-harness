/**
 * Unit tests for src/cli/commands/mcp.mjs's attributeTools/extractToolCalls/
 * getRunCliProvider — the adapter-aware MCP usage attribution fix.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { attributeTools, extractToolCalls, getRunCliProvider } from '../../../src/cli/commands/mcp.mjs';
import { claudeAdapter } from '../../../src/engine/cli-adapters/claude-adapter.mjs';
import { opencodeAdapter } from '../../../src/engine/cli-adapters/opencode-adapter.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('attributeTools', () => {
  test('Claude: attributes mcp__<server>__<tool> calls to the right server', () => {
    // Claude's mcp__ prefix is unambiguous on its own — attribution doesn't
    // need to check registeredServerNames the way OpenCode's does, so even
    // an unregistered server name still attributes by the extracted name
    // (matches the pre-existing comment: "known or not"). Only a name with
    // no mcp__ shape at all falls into unknownMcp.
    const calls = new Map([
      ['mcp__playwright__browser_navigate', 3],
      ['Read', 5],
      ['totally_unrelated_tool', 1],
    ]);
    const { attribution, builtins, unknownMcp } = attributeTools(calls, {
      adapter: claudeAdapter,
      registeredServerNames: ['playwright'],
    });
    expect(attribution.get('playwright').get('mcp__playwright__browser_navigate')).toBe(3);
    expect(builtins.get('Read')).toBe(5);
    expect(unknownMcp.get('totally_unrelated_tool')).toBe(1);
  });

  test('OpenCode: attributes <server>_<tool> calls by matching registered server names', () => {
    const calls = new Map([
      ['playwright_browser_navigate', 4],
      ['read', 2],
      ['totally_unregistered_tool', 1],
    ]);
    const { attribution, builtins, unknownMcp } = attributeTools(calls, {
      adapter: opencodeAdapter,
      registeredServerNames: ['playwright'],
    });
    expect(attribution.get('playwright').get('playwright_browser_navigate')).toBe(4);
    expect(builtins.get('read')).toBe(2);
    expect(unknownMcp.get('totally_unregistered_tool')).toBe(1);
  });

  test('OpenCode: hyphenated server names (auth profiles) are matched correctly', () => {
    const calls = new Map([['playwright-work_browser_navigate', 1]]);
    const { attribution } = attributeTools(calls, {
      adapter: opencodeAdapter,
      registeredServerNames: ['playwright', 'playwright-work'],
    });
    expect(attribution.get('playwright-work').get('playwright-work_browser_navigate')).toBe(1);
  });

  test('defaults to Claude-style attribution when no adapter is given', () => {
    const calls = new Map([['mcp__playwright__browser_navigate', 1]]);
    const { attribution } = attributeTools(calls, { registeredServerNames: ['playwright'] });
    expect(attribution.get('playwright').get('mcp__playwright__browser_navigate')).toBe(1);
  });
});

describe('extractToolCalls + getRunCliProvider', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('extracts tool calls from a real Claude-shaped run log', () => {
    dir = makeTmpDir('mcp-attr-claude');
    const runPath = join(dir, 'run.jsonl');
    const claudeAssistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__playwright__browser_navigate', input: {} }] },
    });
    writeFileSync(runPath, [
      JSON.stringify({ type: 'harness', event: 'run-start', cliProvider: 'claude' }),
      JSON.stringify({ cycleId: 'c1', raw: claudeAssistantEvent }),
    ].join('\n'));

    expect(getRunCliProvider(runPath)).toBe('claude');
    const calls = extractToolCalls(runPath, claudeAdapter);
    expect(calls.get('mcp__playwright__browser_navigate')).toBe(1);
  });

  test('extracts tool calls from a real OpenCode-shaped run log', () => {
    dir = makeTmpDir('mcp-attr-opencode');
    const runPath = join(dir, 'run.jsonl');
    const opencodeToolUseEvent = JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'playwright_browser_navigate', callID: 'call_1', state: { status: 'completed', input: {} } },
    });
    writeFileSync(runPath, [
      JSON.stringify({ type: 'harness', event: 'run-start', cliProvider: 'opencode' }),
      JSON.stringify({ cycleId: 'c1', raw: opencodeToolUseEvent }),
    ].join('\n'));

    expect(getRunCliProvider(runPath)).toBe('opencode');
    const calls = extractToolCalls(runPath, opencodeAdapter);
    expect(calls.get('playwright_browser_navigate')).toBe(1);
  });

  test('getRunCliProvider falls back to the default for logs predating the field', () => {
    dir = makeTmpDir('mcp-attr-legacy');
    const runPath = join(dir, 'run.jsonl');
    writeFileSync(runPath, JSON.stringify({ type: 'harness', event: 'run-start', task: 'legacy run' }) + '\n');
    expect(getRunCliProvider(runPath)).toBe('claude');
  });
});
