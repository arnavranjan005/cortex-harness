/**
 * Unit tests for fs-utils helpers: getAllFiles, fileIcon, copyFile, copyDir, isProjectRoot.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getAllFiles,
  fileIcon,
  copyFile,
  copyDir,
  isProjectRoot,
} from '../../../src/cli/helpers/fs-utils.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A non-TTY readline stub — copyFile/copyDir should never call .question in non-TTY mode.
const rlStub = { question: async () => { throw new Error('should not prompt in non-TTY mode'); } };

describe('getAllFiles', () => {
  test('recursively lists files in nested directories', async () => {
    const dir = makeTmpDir('fsutils-getall');
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'a.txt'), 'a');
      writeFileSync(join(dir, 'sub', 'b.txt'), 'b');

      const files = await getAllFiles(dir);
      const rel = files.map((f) => f.replace(dir, '').replace(/\\/g, '/'));
      expect(rel).toEqual(expect.arrayContaining(['/a.txt', '/sub/b.txt']));
      expect(files).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fileIcon', () => {
  test('maps known statuses to distinct icons', () => {
    const created = fileIcon('created');
    const updated = fileIcon('updated');
    const kept = fileIcon('kept');
    expect(created).not.toBe(updated);
    expect(updated).not.toBe(kept);
    expect(created).not.toBe(kept);
  });
});

describe('copyFile', () => {
  test('creates destination file when it does not exist', async () => {
    const dir = makeTmpDir('fsutils-copyfile');
    try {
      const src = join(dir, 'src.txt');
      const dest = join(dir, 'nested', 'dest.txt');
      writeFileSync(src, 'hello');

      const status = await copyFile(src, dest, 'dest.txt', rlStub);
      expect(status).toBe('created');
      expect(readFileSync(dest, 'utf8')).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps existing file without prompting when stdin is not a TTY', async () => {
    const dir = makeTmpDir('fsutils-copyfile-keep');
    try {
      const src = join(dir, 'src.txt');
      const dest = join(dir, 'dest.txt');
      writeFileSync(src, 'new-content');
      writeFileSync(dest, 'old-content');

      const status = await copyFile(src, dest, 'dest.txt', rlStub);
      expect(status).toBe('kept');
      expect(readFileSync(dest, 'utf8')).toBe('old-content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('copyDir', () => {
  test('copies every file from srcDir into destDir preserving structure', async () => {
    const dir = makeTmpDir('fsutils-copydir');
    try {
      const srcDir = join(dir, 'src');
      const destDir = join(dir, 'dest');
      mkdirSync(join(srcDir, 'nested'), { recursive: true });
      writeFileSync(join(srcDir, 'top.txt'), 'top');
      writeFileSync(join(srcDir, 'nested', 'inner.txt'), 'inner');

      await copyDir(srcDir, destDir, rlStub, 'root');

      expect(readFileSync(join(destDir, 'top.txt'), 'utf8')).toBe('top');
      expect(readFileSync(join(destDir, 'nested', 'inner.txt'), 'utf8')).toBe('inner');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does nothing when srcDir does not exist', async () => {
    const dir = makeTmpDir('fsutils-copydir-missing');
    try {
      const destDir = join(dir, 'dest');
      await copyDir(join(dir, 'does-not-exist'), destDir, rlStub, 'root');
      expect(existsSync(destDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isProjectRoot', () => {
  test('returns true when directory has a project.json', async () => {
    const dir = makeTmpDir('fsutils-isroot-projectjson');
    try {
      writeFileSync(join(dir, 'project.json'), '{}');
      expect(await isProjectRoot(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns true when directory has a src/ folder', async () => {
    const dir = makeTmpDir('fsutils-isroot-src');
    try {
      mkdirSync(join(dir, 'src'));
      expect(await isProjectRoot(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns false for an empty directory', async () => {
    const dir = makeTmpDir('fsutils-isroot-empty');
    try {
      expect(await isProjectRoot(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
