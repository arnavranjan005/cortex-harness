/**
 * Tests for the mergeMcpConfig helper — additive .mcp.json registration during init.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mergeMcpConfig,
  autoScopeMcpServers,
  agentScopeOptions,
  serverScopeOptions,
  scopeListsEqual,
  applyServerScope,
  promptAgentsForServer,
} from '../../../src/cli/helpers/mcp-config.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEMPLATE = {
  mcpServers: {
    playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
};

test('creates .mcp.json when none exists', async () => {
  const templatesDir = makeTmpDir('mcp-templates');
  const targetDir = makeTmpDir('mcp-target');
  try {
    writeFileSync(join(templatesDir, '.mcp.json'), JSON.stringify(TEMPLATE));

    const { status } = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('created');

    const written = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.playwright.command).toBe('npx');
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('merges template server into existing .mcp.json without dropping user entries', async () => {
  const templatesDir = makeTmpDir('mcp-templates');
  const targetDir = makeTmpDir('mcp-target');
  try {
    writeFileSync(join(templatesDir, '.mcp.json'), JSON.stringify(TEMPLATE));
    writeFileSync(
      join(targetDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { shadcn: { type: 'stdio', command: 'npx', args: ['shadcn@latest', 'mcp'] } } }),
    );

    const { status } = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('merged');

    const written = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.shadcn).toBeDefined();
    expect(written.mcpServers.playwright).toBeDefined();
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('does not overwrite a server the user already registered under the same name', async () => {
  const templatesDir = makeTmpDir('mcp-templates');
  const targetDir = makeTmpDir('mcp-target');
  try {
    writeFileSync(join(templatesDir, '.mcp.json'), JSON.stringify(TEMPLATE));
    const userOverride = { type: 'stdio', command: 'custom-playwright-runner', args: [] };
    writeFileSync(
      join(targetDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { playwright: userOverride } }),
    );

    const { status } = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('present');

    const written = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.playwright.command).toBe('custom-playwright-runner');
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('returns "absent" when no template .mcp.json exists', async () => {
  const templatesDir = makeTmpDir('mcp-templates-empty');
  const targetDir = makeTmpDir('mcp-target');
  try {
    const { status } = await mergeMcpConfig(templatesDir, targetDir);
    expect(status).toBe('absent');
    expect(existsSync(join(targetDir, '.mcp.json'))).toBe(false);
  } finally {
    rmSync(templatesDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

// ── pure helpers — no fs, no prompts, no TTY needed ─────────────────────────

describe('agentScopeOptions', () => {
  test('puts "*" first, then one option per agent', () => {
    expect(agentScopeOptions(['backend-subagent', 'frontend-subagent'])).toEqual([
      { value: '*', label: '* (all agents)' },
      { value: 'backend-subagent', label: 'backend-subagent' },
      { value: 'frontend-subagent', label: 'frontend-subagent' },
    ]);
  });

  test('returns just the wildcard when there are no agents', () => {
    expect(agentScopeOptions([])).toEqual([{ value: '*', label: '* (all agents)' }]);
  });
});

describe('serverScopeOptions', () => {
  test('maps server names 1:1 to value/label options', () => {
    expect(serverScopeOptions(['playwright', 'shadcn'])).toEqual([
      { value: 'playwright', label: 'playwright' },
      { value: 'shadcn', label: 'shadcn' },
    ]);
  });

  test('returns [] for no servers', () => {
    expect(serverScopeOptions([])).toEqual([]);
  });
});

describe('scopeListsEqual', () => {
  test('true for same entries in different order', () => {
    expect(scopeListsEqual(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  test('false when lengths differ', () => {
    expect(scopeListsEqual(['a'], ['a', 'b'])).toBe(false);
  });

  test('false when entries differ', () => {
    expect(scopeListsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  test('treats missing/undefined lists as empty', () => {
    expect(scopeListsEqual(undefined, [])).toBe(true);
  });
});

describe('applyServerScope', () => {
  const configuredAgents = ['backend-subagent', 'frontend-subagent'];

  test('adds the server to each targeted agent', () => {
    const { mcpScope, scopedTo } = applyServerScope({}, 'my-server', ['backend-subagent'], configuredAgents);
    expect(mcpScope).toEqual({ 'backend-subagent': ['my-server'] });
    expect(scopedTo).toEqual(['backend-subagent']);
  });

  test('is additive — keeps servers already scoped to an agent', () => {
    const existing = { 'backend-subagent': ['existing-server'] };
    const { mcpScope } = applyServerScope(existing, 'my-server', ['backend-subagent'], configuredAgents);
    expect(mcpScope['backend-subagent']).toEqual(['existing-server', 'my-server']);
  });

  test('is idempotent — scopedTo is empty when the agent already has the server', () => {
    const existing = { 'backend-subagent': ['my-server'] };
    const { mcpScope, scopedTo } = applyServerScope(existing, 'my-server', ['backend-subagent'], configuredAgents);
    expect(mcpScope['backend-subagent']).toEqual(['my-server']);
    expect(scopedTo).toEqual([]);
  });

  test('never mutates the input mcpScope object', () => {
    const existing = { 'backend-subagent': ['existing-server'] };
    applyServerScope(existing, 'my-server', ['backend-subagent'], configuredAgents);
    expect(existing).toEqual({ 'backend-subagent': ['existing-server'] });
  });

  test('drops agents not in configuredAgents', () => {
    const { mcpScope, scopedTo } = applyServerScope({}, 'my-server', ['unknown-agent'], configuredAgents);
    expect(mcpScope).toEqual({});
    expect(scopedTo).toEqual([]);
  });

  test('"*" is always accepted even though it is not a configured agent', () => {
    const { mcpScope, scopedTo } = applyServerScope({}, 'my-server', ['*'], configuredAgents);
    expect(mcpScope).toEqual({ '*': ['my-server'] });
    expect(scopedTo).toEqual(['*']);
  });
});

describe('promptAgentsForServer (non-interactive)', () => {
  test('returns [] when stdin is not a TTY, without ever prompting', async () => {
    // Jest's spawned worker has no TTY stdin, so isInteractive() is false here —
    // this exercises the real guard rather than a mock.
    const result = await promptAgentsForServer('any-server', ['backend-subagent']);
    expect(result).toEqual([]);
  });
});

describe('autoScopeMcpServers — known vs unknown servers', () => {
  function makeConfig(dir, agents) {
    const configPath = join(dir, 'harness.config.json');
    writeFileSync(configPath, JSON.stringify({ agents, mcpScope: {} }));
    return configPath;
  }

  test('known servers (KNOWN_SERVER_SCOPES) are scoped with no prompt', async () => {
    const dir = makeTmpDir('mcp-autoscope');
    try {
      const configPath = makeConfig(dir, {
        'frontend-subagent': {},
        'tester-subagent': {},
      });

      const { scoped, skipped } = await autoScopeMcpServers(configPath, ['playwright']);

      expect(skipped).toEqual([]);
      expect(scoped).toEqual([{ server: 'playwright', agents: ['frontend-subagent', 'tester-subagent'] }]);

      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(written.mcpScope['frontend-subagent']).toContain('playwright');
      expect(written.mcpScope['tester-subagent']).toContain('playwright');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unknown servers are skipped (not scoped to anyone) in a non-interactive run', async () => {
    const dir = makeTmpDir('mcp-autoscope');
    try {
      const configPath = makeConfig(dir, { 'backend-subagent': {} });

      const { scoped, skipped } = await autoScopeMcpServers(configPath, ['totally-custom-server']);

      expect(scoped).toEqual([]);
      expect(skipped).toEqual(['totally-custom-server']);

      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(written.mcpScope['totally-custom-server']).toBeUndefined();
      expect(Object.values(written.mcpScope).flat()).not.toContain('totally-custom-server');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a mix of known and unknown servers is handled independently', async () => {
    const dir = makeTmpDir('mcp-autoscope');
    try {
      const configPath = makeConfig(dir, { 'frontend-subagent': {}, 'tester-subagent': {} });

      const { scoped, skipped } = await autoScopeMcpServers(configPath, ['playwright', 'mystery-server']);

      expect(scoped).toEqual([{ server: 'playwright', agents: ['frontend-subagent', 'tester-subagent'] }]);
      expect(skipped).toEqual(['mystery-server']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
