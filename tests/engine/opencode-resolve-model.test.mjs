/**
 * Tests for opencode-adapter.mjs's resolveModelInfo() — the post-hoc model
 * lookup confirmed live to be necessary because no event in `opencode run
 * --format json`'s stream ever carries the model (unlike Claude's
 * system/init event), only `opencode export <sessionID>` exposes it via
 * info.model.{id,providerID}. `opencode export` also prints a leading
 * "Exporting session: <id>" line before the JSON body — confirmed live —
 * which resolveModelInfo must skip past.
 *
 * The module computes OPENCODE_EXE eagerly at import time via execSync, so
 * each scenario mocks child_process and re-imports the module fresh.
 */
import { jest } from '@jest/globals';

async function loadModule({ isWindows = false, execSyncImpl }) {
  jest.resetModules();
  const execSyncMock = jest.fn(execSyncImpl);

  await jest.unstable_mockModule('child_process', () => ({
    execSync: execSyncMock,
  }));
  await jest.unstable_mockModule('../../src/engine/constants.mjs', () => ({
    isWindows,
  }));

  const mod = await import(`../../src/engine/cli-adapters/opencode-adapter.mjs?case=${Date.now()}-${Math.random()}`);
  return { mod, execSyncMock };
}

describe('opencodeAdapter.resolveModelInfo', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('parses model/provider from real `opencode export` output, skipping the leading non-JSON line', async () => {
    const exportOutput =
      'Exporting session: ses_abc123\n' +
      JSON.stringify({ info: { id: 'ses_abc123', model: { id: 'big-pickle', providerID: 'opencode' } } });

    const { mod, execSyncMock } = await loadModule({
      execSyncImpl: (cmd) => {
        if (cmd.includes('export')) return exportOutput;
        return 'opencode\n'; // resolveExecutable's where.exe call at import time
      },
    });

    const result = mod.opencodeAdapter.resolveModelInfo('ses_abc123', { cwd: '/some/project' });
    expect(result).toEqual({ model: 'big-pickle', provider: 'opencode' });
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('export ses_abc123'),
      expect.objectContaining({ cwd: '/some/project' }),
    );
  });

  test('returns null when sessionID is missing', async () => {
    const { mod } = await loadModule({ execSyncImpl: () => 'opencode\n' });
    expect(mod.opencodeAdapter.resolveModelInfo(null, { cwd: '/x' })).toBeNull();
  });

  test('returns null on export failure (session not found, opencode unavailable, etc.) — best-effort, never throws', async () => {
    const { mod } = await loadModule({
      execSyncImpl: (cmd) => {
        if (cmd.includes('export')) throw new Error('session not found');
        return 'opencode\n';
      },
    });
    expect(mod.opencodeAdapter.resolveModelInfo('ses_missing', { cwd: '/x' })).toBeNull();
  });

  test('returns null when export output has no model.id (malformed/unexpected shape)', async () => {
    const { mod } = await loadModule({
      execSyncImpl: (cmd) => {
        if (cmd.includes('export')) return 'Exporting session: ses_x\n' + JSON.stringify({ info: {} });
        return 'opencode\n';
      },
    });
    expect(mod.opencodeAdapter.resolveModelInfo('ses_x', { cwd: '/x' })).toBeNull();
  });
});
