/**
 * Tests for src/engine/process-utils.mjs
 * Covers buildFilteredMcpServers (killProc requires a live process so is not tested here).
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildFilteredMcpServers } from '../../src/engine/process-utils.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ALL_SERVERS = {
  playwright: { type: 'stdio', command: 'npx', args: ['playwright'] },
  slack: { type: 'stdio', command: 'npx', args: ['slack-mcp'] },
  github: { type: 'stdio', command: 'npx', args: ['github-mcp'] },
};

describe('buildFilteredMcpServers', () => {
  test('returns null when config has no mcpScope', () => {
    const result = buildFilteredMcpServers('backend-subagent', {
      config: { agents: {} },
      ROOT: tmpdir(),
    });
    expect(result).toBeNull();
  });

  test('returns null when mcpScope is not an object', () => {
    const result = buildFilteredMcpServers('backend-subagent', {
      config: { mcpScope: 'invalid' },
      ROOT: tmpdir(),
    });
    expect(result).toBeNull();
  });

  test('returns null when .mcp.json does not exist', () => {
    const dir = makeTmpDir('procutils-nomcp');
    try {
      const result = buildFilteredMcpServers('backend-subagent', {
        config: { mcpScope: { '*': ['playwright'] } },
        ROOT: dir,
      });
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns only globally allowed servers when agent has no specific scope', () => {
    const dir = makeTmpDir('procutils-global');
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: ALL_SERVERS }));
      const result = buildFilteredMcpServers('backend-subagent', {
        config: { mcpScope: { '*': ['playwright'] } },
        ROOT: dir,
      });
      expect(result).toEqual({ playwright: ALL_SERVERS.playwright });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('merges global and agent-specific allowed servers', () => {
    const dir = makeTmpDir('procutils-merge');
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: ALL_SERVERS }));
      const result = buildFilteredMcpServers('backend-subagent', {
        config: {
          mcpScope: {
            '*': ['playwright'],
            'backend-subagent': ['github'],
          },
        },
        ROOT: dir,
      });
      expect(result).toEqual({
        playwright: ALL_SERVERS.playwright,
        github: ALL_SERVERS.github,
      });
      expect(result).not.toHaveProperty('slack');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores server names in scope that are not in .mcp.json', () => {
    const dir = makeTmpDir('procutils-unknown');
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: ALL_SERVERS.playwright } }));
      const result = buildFilteredMcpServers('backend-subagent', {
        config: { mcpScope: { '*': ['playwright', 'nonexistent'] } },
        ROOT: dir,
      });
      expect(result).toEqual({ playwright: ALL_SERVERS.playwright });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns an empty object when no allowed servers exist in .mcp.json', () => {
    const dir = makeTmpDir('procutils-empty');
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: ALL_SERVERS }));
      const result = buildFilteredMcpServers('backend-subagent', {
        config: { mcpScope: { '*': [] } },
        ROOT: dir,
      });
      expect(result).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
