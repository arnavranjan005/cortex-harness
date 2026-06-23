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

  test('returns null when .mcp.json does not exist', () => {
    dir = makeTmpDir('oc-mcp-nomcp');
    const result = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['playwright'], cycleId: 'c1', tmpDir: dir });
    expect(result).toBeNull();
  });

  test('writes a disposable temp file containing only mcp + tools, never touching opencode.json', () => {
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
    expect(written.tools['playwright*']).toBe(true);
    expect(written.tools['slack*']).toBe(false);
    expect(written.mcp.playwright.type).toBe('local');
    expect(written.mcp.slack.type).toBe('local');
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

  test('denies every server not in allowedServerNames', () => {
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
    expect(written.tools).toEqual({
      'playwright*': false,
      'slack*': false,
      'github*': true,
    });
  });

  test('uses a cycle-unique filename so parallel cycles never collide', () => {
    dir = makeTmpDir('oc-mcp-parallel');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['playwright'] } },
    }));

    const pathA = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: ['playwright'], cycleId: 'implement-backend', tmpDir: dir });
    const pathB = buildScopedOpenCodeConfigFile({ ROOT: dir, allowedServerNames: [], cycleId: 'implement-frontend', tmpDir: dir });

    expect(pathA).not.toEqual(pathB);
    expect(JSON.parse(readFileSync(pathA, 'utf8')).tools['playwright*']).toBe(true);
    expect(JSON.parse(readFileSync(pathB, 'utf8')).tools['playwright*']).toBe(false);
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
    expect(written.tools['playwright-work*']).toBe(true);
    // The disk-registered server is still present and correctly denied (not in allowedServerNames).
    expect(written.mcp.playwright).toBeDefined();
    expect(written.tools['playwright*']).toBe(false);
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
    expect(written.tools['playwright-work*']).toBe(true);
  });
});
