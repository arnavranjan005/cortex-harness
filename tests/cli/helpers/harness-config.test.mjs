/**
 * Unit tests for harness-config helpers: loadHarnessConfig, saveHarnessConfig,
 * surfacesFromConfig, repatchFromConfig, printScopeTable.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { jest } from '@jest/globals';
import {
  loadHarnessConfig,
  saveHarnessConfig,
  surfacesFromConfig,
  repatchFromConfig,
  printScopeTable,
} from '../../../src/cli/helpers/harness-config.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_CONFIG = {
  harnessDir: '.harness',
  agents: {
    'backend-subagent': { scope: ['apps/api/', 'libs/schema/', 'libs/types/'] },
    'frontend-subagent': { scope: ['apps/web/', 'libs/ui/'] },
    'distributed-subagent': { scope: ['apps/worker/'] },
  },
};

describe('loadHarnessConfig / saveHarnessConfig', () => {
  test('loadHarnessConfig reads an existing harness.config.json', async () => {
    const dir = makeTmpDir('hconfig-load');
    try {
      writeFileSync(join(dir, 'harness.config.json'), JSON.stringify(SAMPLE_CONFIG));

      const { config, configPath } = await loadHarnessConfig(dir);
      expect(config.agents['backend-subagent'].scope).toContain('apps/api/');
      expect(configPath).toBe(join(dir, 'harness.config.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadHarnessConfig exits the process when the config file is missing', async () => {
    const dir = makeTmpDir('hconfig-missing');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadHarnessConfig(dir)).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('saveHarnessConfig writes formatted JSON back to disk', async () => {
    const dir = makeTmpDir('hconfig-save');
    try {
      const configPath = join(dir, 'harness.config.json');
      await saveHarnessConfig(configPath, SAMPLE_CONFIG);

      expect(existsSync(configPath)).toBe(true);
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(written.agents['frontend-subagent'].scope).toContain('apps/web/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('surfacesFromConfig', () => {
  test('splits agent scopes back into surface buckets, separating shared libs', () => {
    const surfaces = surfacesFromConfig(SAMPLE_CONFIG);

    expect(surfaces.backend).toEqual(['apps/api/']);
    expect(surfaces.frontend).toEqual(['apps/web/']);
    expect(surfaces.distributed).toEqual(['apps/worker/']);
    expect(surfaces.sharedSchema).toContain('libs/schema/');
    expect(surfaces.sharedTypes).toContain('libs/types/');
    expect(surfaces.sharedUi).toContain('libs/ui/');
  });

  test('handles a config with no agents gracefully', () => {
    const surfaces = surfacesFromConfig({});
    expect(surfaces.backend).toEqual([]);
    expect(surfaces.sharedSchema).toEqual([]);
  });
});

describe('repatchFromConfig', () => {
  test('patches agent markdown files derived from the live config', async () => {
    const dir = makeTmpDir('hconfig-repatch');
    try {
      const agentsDir = join(dir, '.harness', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'backend-subagent.agent.md'),
        '<!-- cortex:backend -->\n- *(none)*\n<!-- /cortex:backend -->',
      );

      await repatchFromConfig(dir, SAMPLE_CONFIG);

      const content = readFileSync(join(agentsDir, 'backend-subagent.agent.md'), 'utf8');
      expect(content).toContain('`apps/api/`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does nothing when the agents directory does not exist', async () => {
    const dir = makeTmpDir('hconfig-repatch-missing');
    try {
      await expect(repatchFromConfig(dir, SAMPLE_CONFIG)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('printScopeTable', () => {
  test('prints agent names and their scopes without throwing', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printScopeTable(SAMPLE_CONFIG);
      const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toContain('backend-subagent');
      expect(out).toContain('apps/api/');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('renders "(none)" for agents with an empty scope', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printScopeTable({ agents: { 'backend-subagent': { scope: [] } } });
      const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toContain('(none)');
    } finally {
      logSpy.mockRestore();
    }
  });
});
