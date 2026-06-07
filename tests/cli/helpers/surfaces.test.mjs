/**
 * Unit tests for surface-detection helpers: detectSurfaces, confirmSurfaces,
 * patchAgentScopes, applySurfaces.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectSurfaces,
  confirmSurfaces,
  patchAgentScopes,
  applySurfaces,
} from '../../../src/cli/helpers/surfaces.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeProject(rootDir, relPath) {
  const abs = join(rootDir, ...relPath.split('/'));
  mkdirSync(join(abs, 'src'), { recursive: true });
}

describe('detectSurfaces', () => {
  test('returns null when nx.json is absent', async () => {
    const dir = makeTmpDir('surfaces-nonx');
    try {
      expect(await detectSurfaces(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('classifies app projects by path keyword into surface buckets', async () => {
    const dir = makeTmpDir('surfaces-detect');
    try {
      writeFileSync(join(dir, 'nx.json'), '{}');
      makeProject(dir, 'apps/api');
      makeProject(dir, 'apps/web');
      makeProject(dir, 'apps/worker');
      makeProject(dir, 'libs/shared-types');
      makeProject(dir, 'apps/e2e-web');

      const surfaces = await detectSurfaces(dir);
      expect(surfaces.backend).toContain('apps/api/');
      expect(surfaces.frontend).toContain('apps/web/');
      expect(surfaces.distributed).toContain('apps/worker/');
      expect(surfaces.sharedTypes).toContain('libs/shared-types/');
      // e2e companion projects must be skipped
      expect(JSON.stringify(surfaces)).not.toContain('e2e');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not descend into pruned directories like node_modules', async () => {
    const dir = makeTmpDir('surfaces-prune');
    try {
      writeFileSync(join(dir, 'nx.json'), '{}');
      makeProject(dir, 'node_modules/some-pkg');
      makeProject(dir, 'apps/api');

      const surfaces = await detectSurfaces(dir);
      expect(JSON.stringify(surfaces)).not.toContain('node_modules');
      expect(surfaces.backend).toContain('apps/api/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('confirmSurfaces', () => {
  test('returns detected surfaces unchanged when stdin is not a TTY', async () => {
    const detected = {
      backend: ['apps/api/'],
      frontend: ['apps/web/'],
      distributed: [],
      sharedSchema: [],
      sharedTypes: [],
      sharedUi: [],
    };
    const result = await confirmSurfaces(detected, { question: async () => '' });
    expect(result).toEqual(detected);
  });

  test('fills in empty arrays for a null detection result on non-TTY stdin', async () => {
    const result = await confirmSurfaces(null, { question: async () => '' });
    expect(result).toEqual({
      backend: [],
      frontend: [],
      distributed: [],
      sharedSchema: [],
      sharedTypes: [],
      sharedUi: [],
    });
  });
});

describe('patchAgentScopes', () => {
  test('replaces cortex:* tagged blocks in agent markdown files with surface paths', async () => {
    const dir = makeTmpDir('surfaces-patch');
    try {
      const agentsDir = join(dir, 'agents');
      mkdirSync(agentsDir, { recursive: true });
      const mdPath = join(agentsDir, 'backend-subagent.agent.md');
      writeFileSync(
        mdPath,
        [
          '# Backend agent',
          '<!-- cortex:backend -->',
          '- *(none configured)*',
          '<!-- /cortex:backend -->',
          '<!-- cortex:frontend-checks -->',
          '- *(none configured)*',
          '<!-- /cortex:frontend-checks -->',
        ].join('\n'),
      );

      await patchAgentScopes(agentsDir, {
        backend: ['apps/api/'],
        frontend: ['apps/web/'],
        distributed: [],
        sharedSchema: [],
        sharedTypes: [],
        sharedUi: [],
      });

      const content = readFileSync(mdPath, 'utf8');
      expect(content).toContain('`apps/api/`');
      expect(content).toContain('npm exec nx run web:build');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves files untouched when they contain no cortex tags', async () => {
    const dir = makeTmpDir('surfaces-patch-notags');
    try {
      const agentsDir = join(dir, 'agents');
      mkdirSync(agentsDir, { recursive: true });
      const mdPath = join(agentsDir, 'plain.md');
      const original = '# Plain agent\nNo tags here.';
      writeFileSync(mdPath, original);

      await patchAgentScopes(agentsDir, {
        backend: ['apps/api/'],
        frontend: [],
        distributed: [],
        sharedSchema: [],
        sharedTypes: [],
        sharedUi: [],
      });

      expect(readFileSync(mdPath, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applySurfaces', () => {
  test('writes scope arrays into harness.config.json merging shared libs', async () => {
    const dir = makeTmpDir('surfaces-apply');
    try {
      const configPath = join(dir, 'harness.config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            'backend-subagent': { scope: [] },
            'frontend-subagent': { scope: [] },
            'distributed-subagent': { scope: [] },
          },
        }),
      );

      await applySurfaces(
        configPath,
        {
          backend: ['apps/api/'],
          frontend: ['apps/web/'],
          distributed: ['apps/worker/'],
          sharedSchema: ['libs/schema/'],
          sharedTypes: ['libs/types/'],
          sharedUi: ['libs/ui/'],
        },
        null,
      );

      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.agents['backend-subagent'].scope).toEqual(
        expect.arrayContaining(['apps/api/', 'libs/schema/', 'libs/types/']),
      );
      expect(config.agents['frontend-subagent'].scope).toEqual(
        expect.arrayContaining(['apps/web/', 'libs/ui/']),
      );
      expect(config.agents['distributed-subagent'].scope).toEqual(['apps/worker/']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
