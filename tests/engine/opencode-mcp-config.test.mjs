/**
 * Tests for src/engine/cli-adapters/opencode-mcp-config.mjs
 */
import { jest } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { translateMcpServers, buildScopedOpenCodeConfigFile } from '../../src/engine/cli-adapters/opencode-mcp-config.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('translateMcpServers', () => {
  test('converts a local Claude-style server into OpenCode shape', () => {
    const result = translateMcpServers({
      playwright: { command: 'npx', args: ['-y', 'playwright-mcp'], env: { FOO: 'bar' } },
    });
    expect(result).toEqual({
      playwright: { type: 'local', command: ['npx', '-y', 'playwright-mcp'], environment: { FOO: 'bar' }, enabled: true },
    });
  });

  test('defaults environment to {} when env is absent', () => {
    const result = translateMcpServers({ slack: { command: 'npx', args: ['slack-mcp'] } });
    expect(result.slack.environment).toEqual({});
  });

  test('skips servers with no local "command" field (remote, unsupported)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = translateMcpServers({ remote: { url: 'https://example.com/mcp' } });
    expect(result).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('returns {} for empty/undefined input', () => {
    expect(translateMcpServers(undefined)).toEqual({});
    expect(translateMcpServers({})).toEqual({});
  });
});

describe('buildScopedOpenCodeConfigFile', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('still writes a file (with empty mcp) when .mcp.json does not exist', () => {
    dir = makeTmpDir('oc-mcp-nomcp');
    const result = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['playwright'], cycleId: 'c1', tmpDir: dir });
    expect(result).not.toBeNull();
    expect(JSON.parse(readFileSync(result, 'utf8'))).toEqual({ mcp: {} });
  });

  test('writes a disposable temp file containing only allowed servers under mcp, never touching opencode.json', () => {
    dir = makeTmpDir('oc-mcp-create');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['playwright'] },
        slack: { command: 'npx', args: ['slack-mcp'] },
      },
    }));

    const tmpPath = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['playwright'], cycleId: 'c1', tmpDir: dir });

    expect(tmpPath).not.toBeNull();
    expect(existsSync(join(dir, 'opencode.json'))).toBe(false);

    const written = JSON.parse(readFileSync(tmpPath, 'utf8'));
    expect(written.tools).toBeUndefined();
    expect(written.mcp.playwright.type).toBe('local');
    // Denied server is omitted entirely — not registered at all, not just
    // denied via a tools flag (OpenCode ignores top-level tools denies —
    // see anomalyco/opencode#3612 — so omission is the only enforcement that works).
    expect(written.mcp.slack).toBeUndefined();
  });

  test('never reads or modifies an existing opencode.json', () => {
    dir = makeTmpDir('oc-mcp-untouched');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['playwright'] } },
    }));
    const priorConfig = { someUnrelatedSetting: true, plugin: ['claude-hooks-bridge'] };
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify(priorConfig));

    buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: [], cycleId: 'c1', tmpDir: dir });

    const stillThere = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
    expect(stillThere).toEqual(priorConfig);
  });

  test('omits every server not in allowedServerNames from the mcp block entirely', () => {
    dir = makeTmpDir('oc-mcp-deny');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['playwright'] },
        slack: { command: 'npx', args: ['slack-mcp'] },
        github: { command: 'npx', args: ['github-mcp'] },
      },
    }));

    const tmpPath = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['github'], cycleId: 'c1', tmpDir: dir });
    const written = JSON.parse(readFileSync(tmpPath, 'utf8'));
    expect(Object.keys(written.mcp)).toEqual(['github']);
    expect(written.mcp.playwright).toBeUndefined();
    expect(written.mcp.slack).toBeUndefined();
  });

  test('writes an empty mcp:{} file (not null) when allowedServerNames is empty — debuggable, but still effectively no MCP access', () => {
    dir = makeTmpDir('oc-mcp-zero-allowed');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['playwright'] },
        shadcn: { command: 'npx', args: ['shadcn-mcp'] },
      },
    }));

    const tmpPath = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: [], cycleId: 'explore', tmpDir: dir });
    expect(tmpPath).not.toBeNull();
    expect(JSON.parse(readFileSync(tmpPath, 'utf8'))).toEqual({ mcp: {} });
  });

  test('uses a cycle-unique filename so parallel cycles never collide', () => {
    dir = makeTmpDir('oc-mcp-parallel');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['playwright'] },
        slack: { command: 'npx', args: ['slack-mcp'] },
      },
    }));

    const pathA = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['playwright'], cycleId: 'implement-backend', tmpDir: dir });
    const pathB = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['slack'], cycleId: 'implement-frontend', tmpDir: dir });

    expect(pathA).not.toEqual(pathB);
    expect(JSON.parse(readFileSync(pathA, 'utf8')).mcp.playwright).toBeDefined();
    expect(JSON.parse(readFileSync(pathA, 'utf8')).mcp.slack).toBeUndefined();
    expect(JSON.parse(readFileSync(pathB, 'utf8')).mcp.slack).toBeDefined();
    expect(JSON.parse(readFileSync(pathB, 'utf8')).mcp.playwright).toBeUndefined();
  });

  test('merges additionalServers with .mcp.json servers (e.g. in-memory auth-profile servers)', () => {
    dir = makeTmpDir('oc-mcp-additional');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
    }));

    const tmpPath = buildScopedOpenCodeConfigFile({
      ROOT: dir,
      allowedServerNames: ['playwright-work'],
      cycleId: 'c1',
      tmpDir: dir,
      additionalServers: {
        'playwright-work': { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--storage-state=/tmp/work.json'] },
      },
    });

    const written = JSON.parse(readFileSync(tmpPath, 'utf8'));
    expect(written.mcp['playwright-work'].command).toEqual(['npx', '-y', '@playwright/mcp@latest', '--storage-state=/tmp/work.json']);
    // The disk-registered server is not in allowedServerNames, so it's omitted entirely.
    expect(written.mcp.playwright).toBeUndefined();
  });

  test('works with only additionalServers, no .mcp.json on disk at all', () => {
    dir = makeTmpDir('oc-mcp-additional-only');
    const tmpPath = buildScopedOpenCodeConfigFile({
      ROOT: dir,
      allowedServerNames: ['playwright-work'],
      cycleId: 'c1',
      tmpDir: dir,
      additionalServers: {
        'playwright-work': { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--storage-state=/tmp/work.json'] },
      },
    });

    expect(tmpPath).not.toBeNull();
    const written = JSON.parse(readFileSync(tmpPath, 'utf8'));
    expect(written.mcp['playwright-work']).toBeDefined();
  });
});
