/**
 * Unit tests for the patchGitignore helper and its exported constants.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  patchGitignore,
  GITIGNORE_BLOCK_START,
  GITIGNORE_BLOCK_END,
  GITIGNORE_RUNTIME_ENTRIES,
} from '../../../src/cli/helpers/gitignore.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('creates .gitignore when none exists', async () => {
  const dir = makeTmpDir('gitignore-create');
  try {
    const status = await patchGitignore(dir);
    expect(status).toBe('created');

    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain(GITIGNORE_BLOCK_START);
    expect(content).toContain(GITIGNORE_BLOCK_END);
    for (const entry of GITIGNORE_RUNTIME_ENTRIES) {
      expect(content).toContain(entry);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appends block to an existing .gitignore without clobbering it', async () => {
  const dir = makeTmpDir('gitignore-append');
  try {
    writeFileSync(join(dir, '.gitignore'), '# my project\ndist/\n');

    const status = await patchGitignore(dir);
    expect(status).toBe('appended');

    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content).toContain('# my project');
    expect(content).toContain('dist/');
    expect(content).toContain(GITIGNORE_BLOCK_START);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('is idempotent — returns "present" and does not duplicate the block', async () => {
  const dir = makeTmpDir('gitignore-idempotent');
  try {
    await patchGitignore(dir);
    const status = await patchGitignore(dir);
    expect(status).toBe('present');

    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(content.split(GITIGNORE_BLOCK_START)).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
