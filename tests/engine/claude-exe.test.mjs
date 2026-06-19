/**
 * Tests for src/engine/claude-exe.mjs
 * Covers resolveClaudeExe()'s retry/fallback behavior. The module computes
 * CLAUDE_EXE eagerly at import time, and behavior is gated on isWindows, so
 * each scenario mocks `child_process` + `./constants.mjs` and re-imports the
 * module fresh (via a cache-busting query string) rather than importing once.
 */
import { jest } from '@jest/globals';

async function loadModule({ isWindows, execSyncImpl }) {
  jest.resetModules();
  const execSyncMock = jest.fn(execSyncImpl);

  await jest.unstable_mockModule('child_process', () => ({
    execSync: execSyncMock,
  }));
  await jest.unstable_mockModule('../../src/engine/constants.mjs', () => ({
    isWindows,
  }));

  const mod = await import(`../../src/engine/claude-exe.mjs?case=${Date.now()}-${Math.random()}`);
  return { mod, execSyncMock };
}

describe('resolveClaudeExe', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('non-Windows: returns "claude" immediately without calling where.exe', async () => {
    const execSyncImpl = jest.fn(() => {
      throw new Error('execSync should not be called on non-Windows');
    });
    const { mod, execSyncMock } = await loadModule({ isWindows: false, execSyncImpl });

    expect(mod.resolveClaudeExe()).toBe('claude');
    expect(mod.CLAUDE_EXE).toBe('claude');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  test('Windows: prefers the .cmd shim when where.exe returns multiple matches', async () => {
    const { mod } = await loadModule({
      isWindows: true,
      execSyncImpl: () =>
        'C:\\nvm4w\\nodejs\\claude\nC:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\n',
    });

    expect(mod.resolveClaudeExe()).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  });

  test('Windows: falls back to the first line when no .cmd match exists', async () => {
    const { mod } = await loadModule({
      isWindows: true,
      execSyncImpl: () => 'C:\\some\\path\\claude.exe\n',
    });

    expect(mod.resolveClaudeExe()).toBe('C:\\some\\path\\claude.exe');
  });

  test('Windows: retries after transient where.exe failures and succeeds on a later attempt', async () => {
    // CLAUDE_EXE is computed once, eagerly, at module import — so the import
    // itself is the single resolution attempt under test here. Calling
    // resolveClaudeExe() again afterward would just add more calls on top.
    let calls = 0;
    const { mod, execSyncMock } = await loadModule({
      isWindows: true,
      execSyncImpl: () => {
        calls++;
        if (calls < 3) throw new Error('where.exe transient failure');
        return 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\n';
      },
    });

    expect(mod.CLAUDE_EXE).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    expect(execSyncMock).toHaveBeenCalledTimes(3);
  });

  test('Windows: exhausts all retries, falls back to bare "claude", and warns', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { mod, execSyncMock } = await loadModule({
      isWindows: true,
      execSyncImpl: () => {
        throw new Error('where.exe not found');
      },
    });

    expect(mod.CLAUDE_EXE).toBe('claude');
    expect(execSyncMock).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('could not resolve full path to "claude"');
  });

  test('Windows: module-level CLAUDE_EXE reflects the same resolution as resolveClaudeExe()', async () => {
    const { mod } = await loadModule({
      isWindows: true,
      execSyncImpl: () => 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\n',
    });

    expect(mod.CLAUDE_EXE).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  });
});
