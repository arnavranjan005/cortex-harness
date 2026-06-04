import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createSnapshotManager } from "../src/snapshot.mjs";

// Minimal chalk stub — the real chalk adds ANSI codes we don't need in tests
const chalk = { dim: (s) => s, cyan: (s) => s };

// execSync stub: returns a Buffer so .toString() works
function makeExecSync(modifiedFiles = [], untrackedFiles = []) {
  return (cmd) => {
    if (cmd.includes("diff --name-only")) return Buffer.from(modifiedFiles.join("\n"));
    if (cmd.includes("ls-files --others")) return Buffer.from(untrackedFiles.join("\n"));
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

test("createPreRunSnapshot: captures modified files as byte-perfect blobs", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    // Create a file with binary-safe content
    const content = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x0a, 0x00, 0xff]);
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(join(root, "api/foo.ts"), content);

    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ["api/foo.ts"] });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    assert.ok(index["api/foo.ts"], "index should have entry for api/foo.ts");

    const blobPath = join(snapshotDir, index["api/foo.ts"].blobFile);
    const restored = readFileSync(blobPath);
    assert.deepEqual(restored, content, "blob should be byte-identical to original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createPreRunSnapshot: captures untracked new files", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    writeFileSync(join(root, "web/new.tsx"), "export const X = 1;\n");

    const snap = makeSnap(root, snapshotDir, { untrackedFiles: ["web/new.tsx"] });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    assert.ok(index["web/new.tsx"], "untracked file should be snapshotted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createPreRunSnapshot: does nothing when working tree is clean", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    const snap = makeSnap(root, snapshotDir, { modifiedFiles: [], untrackedFiles: [] });
    snap.createPreRunSnapshot();

    assert.ok(!existsSync(join(snapshotDir, "snapshot.json")), "no snapshot.json should be written for clean tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createPreRunSnapshot: silently skips files that do not exist on disk", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    // Report a dirty file but don't create it on disk
    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ["ghost/missing.ts"] });
    snap.createPreRunSnapshot();

    const index = snap.readIndex();
    assert.ok(!index["ghost/missing.ts"], "missing file should not appear in index");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── restoreFromSnapshot ────────────────────────────────────────────────────────

test("restoreFromSnapshot: restores file to pre-run content after git wipe", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    const original = Buffer.from("original uncommitted content\n");
    writeFileSync(join(root, "api/foo.ts"), original);

    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ["api/foo.ts"] });
    snap.createPreRunSnapshot();

    // Simulate git restore wiping the file back to HEAD content
    writeFileSync(join(root, "api/foo.ts"), "HEAD content — git restored\n");

    const result = snap.restoreFromSnapshot("api/foo.ts");
    assert.equal(result, true, "restoreFromSnapshot should return true");

    const afterRestore = readFileSync(join(root, "api/foo.ts"));
    assert.deepEqual(afterRestore, original, "file should match original uncommitted content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreFromSnapshot: returns false for files not in snapshot", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    const snap = makeSnap(root, snapshotDir);
    const result = snap.restoreFromSnapshot("api/not-snapshotted.ts");
    assert.equal(result, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreFromSnapshot: handles Windows-style backslash paths in index lookup", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    const content = Buffer.from("windows path content\n");
    writeFileSync(join(root, "api/bar.ts"), content);

    // Snapshot using forward-slash path
    const snap = makeSnap(root, snapshotDir, { modifiedFiles: ["api/bar.ts"] });
    snap.createPreRunSnapshot();

    // Simulate git restore
    writeFileSync(join(root, "api/bar.ts"), "HEAD content\n");

    // Restore using backslash path (Windows)
    const result = snap.restoreFromSnapshot("api\\bar.ts");
    assert.equal(result, true, "should find snapshot entry regardless of slash style");

    const afterRestore = readFileSync(join(root, "api/bar.ts"));
    assert.deepEqual(afterRestore, content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── refreshSnapshot ────────────────────────────────────────────────────────────

test("refreshSnapshot: updates snapshot for in-scope files after a valid cycle", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "api"), { recursive: true });

    // Step 1: initial snapshot with old content
    const originalContent = Buffer.from("original content before cycle\n");
    writeFileSync(join(root, "api/service.ts"), originalContent);
    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ["api/service.ts"],
      configuredAgents: { "backend-subagent": { scope: ["api/"] } },
      cycleStateFiles: {
        "implement-backend.json": JSON.stringify({ filesChanged: ["api/service.ts"] }),
      },
    });
    snap.createPreRunSnapshot();

    // Step 2: cycle edits the file with valid in-scope content
    const cycleContent = Buffer.from("valid in-scope content written by cycle\n");
    writeFileSync(join(root, "api/service.ts"), cycleContent);

    // Step 3: refresh snapshot so it now holds cycle's content
    snap.refreshSnapshot({ id: "implement-backend-g1", type: "implement-backend", agent: "backend-subagent", outputFile: "implement-backend.json" });

    // Step 4: simulate a later scope-revert wiping api/service.ts back to HEAD
    writeFileSync(join(root, "api/service.ts"), "HEAD content\n");

    // Step 5: restore — should get cycle content, not the original pre-run content
    const result = snap.restoreFromSnapshot("api/service.ts");
    assert.equal(result, true);

    const afterRestore = readFileSync(join(root, "api/service.ts"));
    assert.deepEqual(afterRestore, cycleContent, "snapshot should hold refreshed cycle content, not pre-run content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshSnapshot: skips non-implement cycle types", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    const content = Buffer.from("original\n");
    writeFileSync(join(root, "api/x.ts"), content);

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ["api/x.ts"],
      configuredAgents: { "backend-subagent": { scope: ["api/"] } },
      cycleStateFiles: {
        "reconcile.json": JSON.stringify({ filesChanged: ["api/x.ts"] }),
      },
    });
    snap.createPreRunSnapshot();

    // Reconcile cycle should NOT refresh snapshot
    const contentBefore = snap.readIndex()["api/x.ts"]?.capturedAt;
    snap.refreshSnapshot({ id: "reconcile-g1", type: "reconcile", agent: "backend-subagent", outputFile: "reconcile.json" });
    const contentAfter = snap.readIndex()["api/x.ts"]?.capturedAt;

    assert.equal(contentBefore, contentAfter, "reconcile cycle must not refresh snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshSnapshot: only updates in-scope files, ignores out-of-scope ones", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "api"), { recursive: true });
    mkdirSync(join(root, "web"), { recursive: true });

    const apiContent = Buffer.from("api original\n");
    const webContent = Buffer.from("web original\n");
    writeFileSync(join(root, "api/ctrl.ts"), apiContent);
    writeFileSync(join(root, "web/page.tsx"), webContent);

    const snap = makeSnap(root, snapshotDir, {
      modifiedFiles: ["api/ctrl.ts", "web/page.tsx"],
      configuredAgents: { "backend-subagent": { scope: ["api/"] } },
      cycleStateFiles: {
        "implement-backend.json": JSON.stringify({
          filesChanged: ["api/ctrl.ts", "web/page.tsx"],
        }),
      },
    });
    snap.createPreRunSnapshot();

    // Cycle edits both files
    writeFileSync(join(root, "api/ctrl.ts"), Buffer.from("api cycle\n"));
    writeFileSync(join(root, "web/page.tsx"), Buffer.from("web cycle\n"));

    const webTimeBefore = snap.readIndex()["web/page.tsx"]?.capturedAt;
    snap.refreshSnapshot({ id: "implement-backend-g1", type: "implement-backend", agent: "backend-subagent", outputFile: "implement-backend.json" });
    const webTimeAfter = snap.readIndex()["web/page.tsx"]?.capturedAt;

    // web/page.tsx is out of backend scope — snapshot must NOT be refreshed for it
    assert.equal(webTimeBefore, webTimeAfter, "out-of-scope file snapshot must not be updated by backend cycle");

    // api/ctrl.ts IS in scope — its snapshot should be updated
    const apiTimeBefore = snap.readIndex()["api/ctrl.ts"]?.capturedAt;
    // capturedAt will have changed — just confirm api entry exists and blob has cycle content
    const apiIndex = snap.readIndex()["api/ctrl.ts"];
    const apiBlob = readFileSync(join(snapshotDir, apiIndex.blobFile));
    assert.deepEqual(apiBlob, Buffer.from("api cycle\n"), "in-scope file blob should reflect cycle content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Cross-run scenario ─────────────────────────────────────────────────────────

test("cross-run: snapshot from a previous run is overwritten at new run start", () => {
  const root = makeTmpDir();
  const snapshotDir = join(root, ".harness", "snapshot");
  try {
    mkdirSync(join(root, "api"), { recursive: true });

    // Run 1: snapshot old content
    writeFileSync(join(root, "api/foo.ts"), "run-1 content\n");
    const snap1 = makeSnap(root, snapshotDir, { modifiedFiles: ["api/foo.ts"] });
    snap1.createPreRunSnapshot();

    // Between runs: file is further modified (e.g. by run-1's in-scope cycle)
    writeFileSync(join(root, "api/foo.ts"), "run-1 cycle content\n");

    // Run 2 start: snapshot captures the current state (run-1 cycle content)
    const snap2 = makeSnap(root, snapshotDir, { modifiedFiles: ["api/foo.ts"] });
    snap2.createPreRunSnapshot();

    // Simulate git restore in run 2
    writeFileSync(join(root, "api/foo.ts"), "HEAD content\n");

    snap2.restoreFromSnapshot("api/foo.ts");
    const afterRestore = readFileSync(join(root, "api/foo.ts"), "utf8");
    assert.equal(afterRestore, "run-1 cycle content\n", "run-2 snapshot should hold run-1 cycle content, not original run-1 pre-run content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
