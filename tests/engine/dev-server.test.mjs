/**
 * Unit tests for dev-server utilities in process-utils.mjs.
 * Covers normalizeDevServerConfig and detectDevServerConfig using real temp directories
 * (same pattern as process-utils.test.mjs for buildFilteredMcpServers).
 * pollReadiness and startDevServer spawn/network behaviour is tested in
 * tests/integration/dev-server-lifecycle.test.mjs.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normalizeDevServerConfig,
  detectDevServerConfig,
} from '../../src/engine/process-utils.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── normalizeDevServerConfig ─────────────────────────────────────────────────

describe('normalizeDevServerConfig', () => {
  test('normalizes old format (command + readinessUrl) to services[]', () => {
    const cfg = { command: 'npm run dev', readinessUrl: 'http://localhost:3000', startupTimeoutMs: 60_000 };
    const result = normalizeDevServerConfig(cfg);
    expect(result.services).toEqual([{ command: 'npm run dev', readinessUrl: 'http://localhost:3000' }]);
    expect(result.browserUrl).toBe('http://localhost:3000');
    expect(result.startupTimeoutMs).toBe(60_000);
  });

  test('passes through new format with services[] unchanged', () => {
    const cfg = {
      browserUrl: 'http://localhost:3000',
      startupTimeoutMs: 120_000,
      services: [
        { command: 'npm run api', readinessUrl: 'http://localhost:8000/health' },
        { command: 'npm run web', readinessUrl: 'http://localhost:3000' },
      ],
    };
    const result = normalizeDevServerConfig(cfg);
    expect(result.browserUrl).toBe('http://localhost:3000');
    expect(result.services).toHaveLength(2);
    expect(result.startupTimeoutMs).toBe(120_000);
  });

  test('falls back to first service readinessUrl when browserUrl absent in new format', () => {
    const cfg = {
      services: [{ command: 'npm run api', readinessUrl: 'http://localhost:8000/health' }],
    };
    const result = normalizeDevServerConfig(cfg);
    expect(result.browserUrl).toBe('http://localhost:8000/health');
  });

  test('applies default 120s startupTimeoutMs when absent', () => {
    const cfg = { command: 'npm run dev', readinessUrl: 'http://localhost:3000' };
    const result = normalizeDevServerConfig(cfg);
    expect(result.startupTimeoutMs).toBe(120_000);
  });

  test('returns empty services array for empty config object', () => {
    const result = normalizeDevServerConfig({});
    expect(result.services).toEqual([]);
    expect(result.browserUrl).toBe('');
  });

  test('returns empty services array for null/undefined input', () => {
    expect(normalizeDevServerConfig(null).services).toEqual([]);
    expect(normalizeDevServerConfig(undefined).services).toEqual([]);
  });
});

// ─── detectDevServerConfig ────────────────────────────────────────────────────

describe('detectDevServerConfig', () => {
  test('returns null for an empty directory with no framework signals', () => {
    const dir = makeTmpDir('detect-empty');
    try {
      expect(detectDevServerConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects standalone Next.js via next.config.ts in root', () => {
    const dir = makeTmpDir('detect-nextjs-ts');
    try {
      writeFileSync(join(dir, 'next.config.ts'), 'export default {}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result._detected).toBe(true);
      expect(result.browserUrl).toBe('http://localhost:3000');
      expect(result.services).toHaveLength(1);
      expect(result.services[0].readinessUrl).toBe('http://localhost:3000');
      expect(result.services[0].command).toMatch(/next/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects standalone Next.js via next.config.js', () => {
    const dir = makeTmpDir('detect-nextjs-js');
    try {
      writeFileSync(join(dir, 'next.config.js'), 'module.exports = {}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.browserUrl).toBe('http://localhost:3000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects standalone Vite via vite.config.ts in root', () => {
    const dir = makeTmpDir('detect-vite-ts');
    try {
      writeFileSync(join(dir, 'vite.config.ts'), 'export default {}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result._detected).toBe(true);
      expect(result.browserUrl).toBe('http://localhost:5173');
      expect(result.services[0].readinessUrl).toBe('http://localhost:5173');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects standalone NestJS via nest-cli.json in root', () => {
    const dir = makeTmpDir('detect-nestjs');
    try {
      writeFileSync(join(dir, 'nest-cli.json'), JSON.stringify({ collection: '@nestjs/schematics' }));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result._detected).toBe(true);
      expect(result.services[0].command).toMatch(/nest/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads PORT from .env for standalone NestJS port', () => {
    const dir = makeTmpDir('detect-nestjs-port');
    try {
      writeFileSync(join(dir, 'nest-cli.json'), JSON.stringify({}));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      writeFileSync(join(dir, '.env'), 'PORT=8000\n');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.browserUrl).toBe('http://localhost:8000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Nx workspace with Next.js subproject', () => {
    const dir = makeTmpDir('detect-nx-nextjs');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'web' }));
      writeFileSync(join(dir, 'web', 'next.config.ts'), 'export default {}');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result._detected).toBe(true);
      expect(result.browserUrl).toBe('http://localhost:3000');
      expect(result.services.some((s) => s.command.includes('web'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses devTargetName from @nx/next plugin when present', () => {
    const dir = makeTmpDir('detect-nx-devtarget');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({
        plugins: [{ plugin: '@nx/next/plugin', options: { devTargetName: 'serve' } }],
      }));
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'web' }));
      writeFileSync(join(dir, 'web', 'next.config.mjs'), 'export default {}');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services.some((s) => s.command.includes(':serve'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Nx workspace with NestJS subproject via nest-cli.json', () => {
    const dir = makeTmpDir('detect-nx-nestjs');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(join(dir, 'api', 'package.json'), JSON.stringify({ name: 'api' }));
      writeFileSync(join(dir, 'api', 'nest-cli.json'), JSON.stringify({ collection: '@nestjs/schematics' }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services.some((s) => s.command.includes('api'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads PORT from subproject .env for backend readiness URL', () => {
    const dir = makeTmpDir('detect-nx-envport');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(join(dir, 'api', 'package.json'), JSON.stringify({ name: 'api' }));
      writeFileSync(join(dir, 'api', 'nest-cli.json'), JSON.stringify({}));
      writeFileSync(join(dir, 'api', '.env'), 'PORT=9000\n');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services.some((s) => s.readinessUrl.includes('9000'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Nx workspace with explicit project.json serve target (@nx/js:node)', () => {
    const dir = makeTmpDir('detect-nx-projjson');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(join(dir, 'api', 'package.json'), JSON.stringify({ name: 'api' }));
      writeFileSync(join(dir, 'api', 'project.json'), JSON.stringify({
        name: 'api',
        targets: { serve: { executor: '@nx/js:node', options: {} } },
      }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services.some((s) => s.command.includes('api:serve'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null for Nx workspace with no recognisable projects', () => {
    const dir = makeTmpDir('detect-nx-empty');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      // Subdir without package.json or framework signals
      mkdirSync(join(dir, 'misc'), { recursive: true });
      expect(detectDevServerConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips -e2e subdirectories in Nx workspace scan', () => {
    const dir = makeTmpDir('detect-nx-e2e-skip');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      mkdirSync(join(dir, 'web-e2e'), { recursive: true });
      writeFileSync(join(dir, 'web-e2e', 'package.json'), JSON.stringify({ name: 'web-e2e' }));
      writeFileSync(join(dir, 'web-e2e', 'next.config.ts'), 'export default {}');
      // e2e project should be skipped → null
      expect(detectDevServerConfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sets browserUrl to the first frontend service found in multi-service Nx workspace', () => {
    const dir = makeTmpDir('detect-nx-multi');
    try {
      writeFileSync(join(dir, 'nx.json'), JSON.stringify({ plugins: [] }));
      // Backend first
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(join(dir, 'api', 'package.json'), JSON.stringify({ name: 'api' }));
      writeFileSync(join(dir, 'api', 'nest-cli.json'), JSON.stringify({}));
      // Frontend second
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'web' }));
      writeFileSync(join(dir, 'web', 'next.config.ts'), 'export default {}');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.browserUrl).toBe('http://localhost:3000');
      expect(result.services.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── pass 2: dep-based detection ──────────────────────────────────────────────

  test('detects Next.js via dependency in package.json (pass 2 — no config file)', () => {
    const dir = makeTmpDir('detect-dep-nextjs');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'app',
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toMatch(/next/);
      expect(result.browserUrl).toBe('http://localhost:3000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Vite via devDependency in package.json (pass 2 — no config file)', () => {
    const dir = makeTmpDir('detect-dep-vite');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'app',
        devDependencies: { vite: '^5.0.0' },
      }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toMatch(/vite/);
      expect(result.browserUrl).toBe('http://localhost:5173');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── pass 3: script-content-based detection ───────────────────────────────────

  test('detects Next.js via script content when no config file or dep listed (pass 3)', () => {
    const dir = makeTmpDir('detect-script-nextjs');
    try {
      // Pass 3: no config file, no dep — only script content reveals the framework.
      // The command uses the existing npm script, not the standalone CLI, so it's "npm run dev".
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'app',
        scripts: { dev: 'next dev', build: 'next build' },
      }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('npm run dev');
      expect(result.browserUrl).toBe('http://localhost:3000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Vite via script content (pass 3)', () => {
    const dir = makeTmpDir('detect-script-vite');
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'app',
        scripts: { dev: 'vite', preview: 'vite preview' },
      }));
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      // Script "dev" found → npm run dev; port is 5173 (Vite default)
      expect(result.services[0].command).toBe('npm run dev');
      expect(result.browserUrl).toBe('http://localhost:5173');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── custom JS monorepo (no nx.json) ──────────────────────────────────────────

  test('uses npm --prefix for custom JS monorepo subdir with a dev script', () => {
    const dir = makeTmpDir('detect-custom-mono');
    try {
      // ROOT has no nx.json and no own framework files
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({
        name: 'web',
        scripts: { dev: 'next dev' },
      }));
      writeFileSync(join(dir, 'web', 'next.config.ts'), 'export default {}');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('npm --prefix web run dev');
      expect(result.services[0].cwd).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to standaloneCmd for custom JS monorepo subdir without npm scripts', () => {
    const dir = makeTmpDir('detect-custom-mono-nostript');
    try {
      mkdirSync(join(dir, 'web'), { recursive: true });
      writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'web' }));
      writeFileSync(join(dir, 'web', 'next.config.ts'), 'export default {}');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      // standaloneCmd used when no matching npm script found
      expect(result.services[0].command).toMatch(/next dev/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── non-JS frameworks ─────────────────────────────────────────────────────────

  test('detects Django via manage.py and sets cwd to relative project path', () => {
    const dir = makeTmpDir('detect-django');
    try {
      mkdirSync(join(dir, 'backend'), { recursive: true });
      writeFileSync(join(dir, 'backend', 'manage.py'), '#!/usr/bin/env python');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('python manage.py runserver');
      expect(result.services[0].cwd).toBe('backend');
      expect(result.services[0].readinessUrl).toBe('http://localhost:8000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects standalone Django at ROOT (no subdir)', () => {
    const dir = makeTmpDir('detect-django-standalone');
    try {
      writeFileSync(join(dir, 'manage.py'), '#!/usr/bin/env python');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('python manage.py runserver');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Go via go.mod and sets cwd', () => {
    const dir = makeTmpDir('detect-go');
    try {
      mkdirSync(join(dir, 'server'), { recursive: true });
      writeFileSync(join(dir, 'server', 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('go run .');
      expect(result.services[0].cwd).toBe('server');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects Spring Boot via pom.xml containing spring-boot and uses mvnw when present', () => {
    const dir = makeTmpDir('detect-spring');
    try {
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(join(dir, 'api', 'pom.xml'), '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>');
      writeFileSync(join(dir, 'api', 'mvnw'), '#!/bin/sh');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('./mvnw spring-boot:run');
      expect(result.services[0].cwd).toBe('api');
      expect(result.services[0].readinessUrl).toBe('http://localhost:8080');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects .NET via .csproj file and sets cwd', () => {
    const dir = makeTmpDir('detect-dotnet');
    try {
      mkdirSync(join(dir, 'App'), { recursive: true });
      writeFileSync(join(dir, 'App', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
      const result = detectDevServerConfig(dir);
      expect(result).not.toBeNull();
      expect(result.services[0].command).toBe('dotnet run');
      expect(result.services[0].cwd).toBe('App');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
