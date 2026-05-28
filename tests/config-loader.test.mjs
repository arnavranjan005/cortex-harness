import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    await assert.rejects(
      () => loadConfig(dir),
      /Config file not found/,
    );
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
    assert.equal(config.harnessDir, join(dir, '.harness'));
    assert.equal(config.promptsDir, join(dir, '.harness/prompts'));
    assert.equal(config.agentsDir, join(dir, '.harness/agents'));
    assert.equal(config.cwd, dir);
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
    assert.deepEqual(config.agents, {});
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
    assert.equal(config.harnessDir, join(dir, 'custom-harness'));
    assert.equal(config.promptsDir, join(dir, 'custom-harness/my-prompts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
