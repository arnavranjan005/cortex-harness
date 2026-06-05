import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../src/config-loader.mjs';

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('throws when harness.config.json is missing', async () => {
  const dir = makeTmpDir();
  try {
    await expect(loadConfig(dir)).rejects.toThrow(/Config file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns normalized paths from config', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'harness.config.json'), JSON.stringify({
      harnessDir: '.harness',
      agents: { 'backend-subagent': { scope: ['api/'] } },
    }));
    const config = await loadConfig(dir);
    expect(config.harnessDir).toBe(join(dir, '.harness'));
    expect(config.promptsDir).toBe(join(dir, '.harness/prompts'));
    expect(config.agentsDir).toBe(join(dir, '.harness/agents'));
    expect(config.cwd).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaults agents to {} when field is absent', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'harness.config.json'), JSON.stringify({
      harnessDir: '.harness',
    }));
    const config = await loadConfig(dir);
    expect(config.agents).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves custom harnessDir and promptsDir overrides', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'harness.config.json'), JSON.stringify({
      harnessDir: 'custom-harness',
      promptsDir: 'custom-harness/my-prompts',
      agents: {},
    }));
    const config = await loadConfig(dir);
    expect(config.harnessDir).toBe(join(dir, 'custom-harness'));
    expect(config.promptsDir).toBe(join(dir, 'custom-harness/my-prompts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
