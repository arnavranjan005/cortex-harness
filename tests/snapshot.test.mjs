import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSnapshotManager } from '../src/snapshot.mjs';

// Minimal chalk stub — the real chalk adds ANSI codes we don't need in tests
const chalk = { dim: (s) => s, cyan: (s) => s };

// execSync stub: returns a Buffer so .toString() works
function makeExecSync(modifiedFiles = [], untrackedFiles = []) {
  return (cmd) => {
    if (cmd.includes('diff --name-only')) return Buffer.from(modifiedFiles.join('\n'));
    if (cmd.includes('ls-files --others')) return Buffer.from(untrackedFiles.join('\n'));
    throw new Error(`Unexpected execSync call: ${cmd}`);
  };
}

function makeTmpDir() {
  const dir = join(tmpdir(), `snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSnap(root, snapshotDir, opts = {}) {
  const { modifiedFiles = [], untrackedFiles = [], configuredAgents = {}, cycleStateFiles = {} } = opts;
  return createSnapshotManager({
    snapshotDir,
    root,
    configuredAgents,
    readCycleState: (filename) => cycleStateFiles[filename] ?? null,
    chalk,
    execSync: makeExecSync(modifiedFiles, untrackedFiles),
  });
}

// ── createPreRunSnapshot ───────────────────────────────────────────────────────

test('createPreRunSnapshot: captures modified files as byte-perfect blobs', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    const content = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x0a, 0x00, 0xff]);
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api/foo.ts'), content);

    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ['api/foo.ts'] });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    expect(index['api/foo.ts']).toBeTruthy();

    const blobPath = join(snapshotDir, index['api/foo.ts'].blobFile);
    const restored = readFileSync(blobPath);
    expect(restored).toEqual(content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createPreRunSnapshot: captures untracked new files', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'web'), { recursive: true });
    writeFileSync(join(root, 'web/new.tsx'), 'export const X = 1;\n');

    const snap = makeSnap(root, snapshotDir, { untrackedFiles: ['web/new.tsx'] });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    expect(index['web/new.tsx']).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createPreRunSnapshot: does nothing when working tree is clean', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    const snap = makeSnap(root, snapshotDir, { modifiedFiles: [], untrackedFiles: [] });
    snap.createPreRunSnapshot();

    expect(existsSync(join(snapshotDir, 'snapshot.json'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createPreRunSnapshot: skips lock files (package-lock.json, yarn.lock, etc.)', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    const lockFiles = [
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'bun.lockb', 'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
    ];
    for (const f of lockFiles) writeFileSync(join(root, f), `lock content for ${f}`);
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api/real.ts'), 'real file');

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: [...lockFiles, 'api/real.ts'],
    });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    for (const f of lockFiles) {
      expect(index[f]).toBeUndefined();
    }
    expect(index['api/real.ts']).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createPreRunSnapshot: silently skips files that do not exist on disk', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ['ghost/missing.ts'] });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    expect(index['ghost/missing.ts']).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── restoreFromSnapshot ────────────────────────────────────────────────────────

test('restoreFromSnapshot: restores file to pre-run content after git wipe', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    const original = Buffer.from('original uncommitted content\n');
    writeFileSync(join(root, 'api/foo.ts'), original);

    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ['api/foo.ts'] });
    snap.createPreRunSnapshot();

    writeFileSync(join(root, 'api/foo.ts'), 'HEAD content — git restored\n');

    const result = snap.restoreFromSnapshot('api/foo.ts');
    expect(result).toBe(true);

    const afterRestore = readFileSync(join(root, 'api/foo.ts'));
    expect(afterRestore).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoreFromSnapshot: returns false for files not in snapshot', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    const snap = makeSnap(root, snapshotDir);
    expect(snap.restoreFromSnapshot('api/not-snapshotted.ts')).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoreFromSnapshot: handles Windows-style backslash paths in index lookup', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    const content = Buffer.from('windows path content\n');
    writeFileSync(join(root, 'api/bar.ts'), content);

    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ['api/bar.ts'] });
    snap.createPreRunSnapshot();

    writeFileSync(join(root, 'api/bar.ts'), 'HEAD content\n');

    const result = snap.restoreFromSnapshot('api\\bar.ts');
    expect(result).toBe(true);

    const afterRestore = readFileSync(join(root, 'api/bar.ts'));
    expect(afterRestore).toEqual(content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── refreshSnapshot ────────────────────────────────────────────────────────────

test('refreshSnapshot: updates snapshot for in-scope files after a valid cycle', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });

    const originalContent = Buffer.from('original content before cycle\n');
    writeFileSync(join(root, 'api/service.ts'), originalContent);
    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/service.ts'],
      configuredAgents: { 'backend-subagent': { scope: ['api/'] } },
      cycleStateFiles: {
        'implement-backend.json': JSON.stringify({ filesChanged: ['api/service.ts'] }),
      },
    });
    snap.createPreRunSnapshot();

    const cycleContent = Buffer.from('valid in-scope content written by cycle\n');
    writeFileSync(join(root, 'api/service.ts'), cycleContent);

    snap.refreshSnapshot({ id: 'implement-backend-g1', type: 'implement-backend', agent: 'backend-subagent', outputFile: 'implement-backend.json' });

    writeFileSync(join(root, 'api/service.ts'), 'HEAD content\n');

    const result = snap.restoreFromSnapshot('api/service.ts');
    expect(result).toBe(true);

    const afterRestore = readFileSync(join(root, 'api/service.ts'));
    expect(afterRestore).toEqual(cycleContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshSnapshot: refreshes non-implement cycle types too', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    const content = Buffer.from('original\n');
    writeFileSync(join(root, 'api/x.ts'), content);

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/x.ts'],
      configuredAgents: { 'backend-subagent': { scope: ['api/'] } },
      cycleStateFiles: {
        'reconcile.json': JSON.stringify({ filesChanged: ['api/x.ts'] }),
      },
    });
    snap.createPreRunSnapshot();

    const timeBefore = snap.readIndex()['api/x.ts']?.capturedAt;

    writeFileSync(join(root, 'api/x.ts'), Buffer.from('updated\n'));
    snap.refreshSnapshot({ id: 'reconcile-g1', type: 'reconcile', agent: 'backend-subagent', outputFile: 'reconcile.json' });
    const timeAfter = snap.readIndex()['api/x.ts']?.capturedAt;

    expect(timeAfter).not.toBe(timeBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshSnapshot: skips non-reconcile cycles without an agent', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    const content = Buffer.from('original\n');
    writeFileSync(join(root, 'api/x.ts'), content);

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/x.ts'],
      configuredAgents: {},
      cycleStateFiles: {
        'explore.json': JSON.stringify({ filesChanged: ['api/x.ts'] }),
      },
    });
    snap.createPreRunSnapshot();

    const timeBefore = snap.readIndex()['api/x.ts']?.capturedAt;
    snap.refreshSnapshot({ id: 'explore-g1', type: 'explore', agent: null, outputFile: 'explore.json' });
    const timeAfter = snap.readIndex()['api/x.ts']?.capturedAt;

    expect(timeBefore).toBe(timeAfter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshSnapshot: reconcile cycle without agent refreshes snapshot from filesChanged', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api/shared.ts'), Buffer.from('original\n'));

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/shared.ts'],
      configuredAgents: {},
      cycleStateFiles: {
        'reconcile.json': JSON.stringify({ filesChanged: ['api/shared.ts'] }),
      },
    });
    snap.createPreRunSnapshot();

    const timeBefore = snap.readIndex()['api/shared.ts']?.capturedAt;

    writeFileSync(join(root, 'api/shared.ts'), Buffer.from('reconcile updated\n'));
    snap.refreshSnapshot({ id: 'reconcile', type: 'reconcile', agent: null, outputFile: 'reconcile.json' });

    const index = snap.readIndex();
    expect(index['api/shared.ts']).toBeTruthy();
    expect(index['api/shared.ts'].capturedAt).not.toBe(timeBefore);

    const blob = readFileSync(join(snapshotDir, index['api/shared.ts'].blobFile));
    expect(blob).toEqual(Buffer.from('reconcile updated\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshSnapshot: reconcile cycle without agent does nothing when filesChanged is empty', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api/shared.ts'), Buffer.from('original\n'));

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/shared.ts'],
      configuredAgents: {},
      cycleStateFiles: {
        'reconcile.json': JSON.stringify({ filesChanged: [] }),
      },
    });
    snap.createPreRunSnapshot();

    const timeBefore = snap.readIndex()['api/shared.ts']?.capturedAt;

    writeFileSync(join(root, 'api/shared.ts'), Buffer.from('modified after snapshot\n'));
    snap.refreshSnapshot({ id: 'reconcile', type: 'reconcile', agent: null, outputFile: 'reconcile.json' });
    const timeAfter = snap.readIndex()['api/shared.ts']?.capturedAt;

    expect(timeBefore).toBe(timeAfter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshSnapshot: reconcile cycle without agent does nothing when outputFile is absent', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api/shared.ts'), Buffer.from('original\n'));

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/shared.ts'],
      configuredAgents: {},
      cycleStateFiles: {},
    });
    snap.createPreRunSnapshot();

    const timeBefore = snap.readIndex()['api/shared.ts']?.capturedAt;

    snap.refreshSnapshot({ id: 'reconcile', type: 'reconcile', agent: null, outputFile: 'reconcile.json' });
    const timeAfter = snap.readIndex()['api/shared.ts']?.capturedAt;

    expect(timeBefore).toBe(timeAfter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshSnapshot: only updates in-scope files, ignores out-of-scope ones', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });
    mkdirSync(join(root, 'web'), { recursive: true });

    writeFileSync(join(root, 'api/ctrl.ts'), Buffer.from('api original\n'));
    writeFileSync(join(root, 'web/page.tsx'), Buffer.from('web original\n'));

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ['api/ctrl.ts', 'web/page.tsx'],
      configuredAgents: { 'backend-subagent': { scope: ['api/'] } },
      cycleStateFiles: {
        'implement-backend.json': JSON.stringify({
          filesChanged: ['api/ctrl.ts', 'web/page.tsx'],
        }),
      },
    });
    snap.createPreRunSnapshot();

    writeFileSync(join(root, 'api/ctrl.ts'), Buffer.from('api cycle\n'));
    writeFileSync(join(root, 'web/page.tsx'), Buffer.from('web cycle\n'));

    const webTimeBefore = snap.readIndex()['web/page.tsx']?.capturedAt;
    snap.refreshSnapshot({ id: 'implement-backend-g1', type: 'implement-backend', agent: 'backend-subagent', outputFile: 'implement-backend.json' });
    const webTimeAfter = snap.readIndex()['web/page.tsx']?.capturedAt;

    expect(webTimeBefore).toBe(webTimeAfter);

    const apiIndex = snap.readIndex()['api/ctrl.ts'];
    const apiBlob = readFileSync(join(snapshotDir, apiIndex.blobFile));
    expect(apiBlob).toEqual(Buffer.from('api cycle\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Cross-run scenario ─────────────────────────────────────────────────────────

test('cross-run: snapshot from a previous run is overwritten at new run start', () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, '.harness', 'snapshot');
  try {
    mkdirSync(join(root, 'api'), { recursive: true });

    writeFileSync(join(root, 'api/foo.ts'), 'run-1 content\n');
    const snap1 = makeSnap(root, snapshotDir, { modifiedFiles: ['api/foo.ts'] });
    snap1.createPreRunSnapshot();

    writeFileSync(join(root, 'api/foo.ts'), 'run-1 cycle content\n');

    const snap2 = makeSnap(root, snapshotDir, { modifiedFiles: ['api/foo.ts'] });
    snap2.createPreRunSnapshot();

    writeFileSync(join(root, 'api/foo.ts'), 'HEAD content\n');

    snap2.restoreFromSnapshot('api/foo.ts');
    const afterRestore = readFileSync(join(root, 'api/foo.ts'), 'utf8');
    expect(afterRestore).toBe('run-1 cycle content\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
