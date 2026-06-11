/**
 * Integration tests for the dev-server lifecycle in process-utils.mjs.
 * Uses real HTTP servers (Node http.createServer) and real child processes
 * to exercise pollReadiness and startDevServer against actual network I/O.
 */
import http from 'http';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { jest } from '@jest/globals';
import { killProc, pollReadiness, startDevServer } from '../../src/engine/process-utils.mjs';

// Longer default timeout for integration tests that spin up real processes
jest.setTimeout(30_000);

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Starts a real HTTP server on a random available port.
 * Returns { server, port, url, close }.
 */
function startTestServer(statusCode = 200) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        url: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Binds a server to port 0 and immediately closes it; returns the assigned port number. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Writes a minimal Node.js HTTP server script that listens on the port given
 * as the first CLI argument (process.argv[2]).
 */
let _seq = 0;
function writeServerScript(dir) {
  const name = `server-${++_seq}.cjs`;
  const scriptPath = join(dir, name);
  writeFileSync(
    scriptPath,
    [
      "const http = require('http');",
      "const port = parseInt(process.argv[2], 10);",
      "http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })",
      "  .listen(port, '127.0.0.1');",
    ].join('\n'),
    'utf8',
  );
  return scriptPath;
}

/** Kill a process with the harness killer (taskkill on Windows) and wait for it to exit. */
function killAndWait(proc) {
  return new Promise((resolve) => {
    if (!proc) { resolve(); return; }
    proc.once('close', resolve);
    killProc(proc);
    // Extra fallback so the promise always resolves even if 'close' never fires
    setTimeout(resolve, 3_000);
  });
}

// ─── pollReadiness ────────────────────────────────────────────────────────────

describe('pollReadiness (integration)', () => {
  test('resolves true when server responds with 200 OK', async () => {
    const { url, close } = await startTestServer(200);
    try {
      expect(await pollReadiness(url, 5_000)).toBe(true);
    } finally {
      await close();
    }
  });

  test('resolves true for any status < 500 (e.g. 404 Not Found)', async () => {
    const { url, close } = await startTestServer(404);
    try {
      expect(await pollReadiness(url, 5_000)).toBe(true);
    } finally {
      await close();
    }
  });

  test('resolves true for 302 redirect', async () => {
    const { url, close } = await startTestServer(302);
    try {
      expect(await pollReadiness(url, 5_000)).toBe(true);
    } finally {
      await close();
    }
  });

  test('resolves false for 500 Internal Server Error', async () => {
    const { url, close } = await startTestServer(500);
    try {
      expect(await pollReadiness(url, 5_000)).toBe(false);
    } finally {
      await close();
    }
  });

  test('resolves false when no server is listening within timeout', async () => {
    // Use a dynamically freed port — it was just closed so nothing is on it
    const port = await findFreePort();
    const result = await pollReadiness(`http://localhost:${port}`, 2_500);
    expect(result).toBe(false);
  });

  test('does not exceed timeout by more than one retry interval', async () => {
    const port = await findFreePort();
    const start = Date.now();
    await pollReadiness(`http://localhost:${port}`, 2_000);
    const elapsed = Date.now() - start;
    // Should resolve within timeout + one 2s retry window + some buffer
    expect(elapsed).toBeLessThan(7_000);
  });
});

// ─── startDevServer ───────────────────────────────────────────────────────────

describe('startDevServer (integration)', () => {
  test('returns { procs:[], browserUrl } when service is already running', async () => {
    const { url, close } = await startTestServer(200);
    try {
      const cfg = {
        browserUrl: url,
        services: [{ command: 'node -e "process.exit(0)"', readinessUrl: url }],
        startupTimeoutMs: 5_000,
      };
      const result = await startDevServer(cfg, { ROOT: tmpdir() });
      expect(result.browserUrl).toBe(url);
      expect(result.procs).toEqual([]);
    } finally {
      await close();
    }
  });

  test('returns { procs:[], browserUrl:"" } when service times out before becoming ready', async () => {
    const port = await findFreePort();
    const cfg = {
      browserUrl: `http://localhost:${port}`,
      services: [
        {
          command: 'node -e "setTimeout(() => {}, 60000)"',
          readinessUrl: `http://localhost:${port}`,
        },
      ],
      startupTimeoutMs: 2_000,
    };
    const result = await startDevServer(cfg, { ROOT: tmpdir() });
    expect(result.browserUrl).toBe('');
    expect(result.procs).toEqual([]);
  });

  test('spawns a service process and returns the proc when server starts', async () => {
    const dir = makeTmpDir('ds-spawn');
    const port = await findFreePort();
    const scriptPath = writeServerScript(dir);

    try {
      const cfg = {
        browserUrl: `http://localhost:${port}`,
        services: [
          {
            command: `node ${scriptPath} ${port}`,
            readinessUrl: `http://localhost:${port}`,
          },
        ],
        startupTimeoutMs: 15_000,
      };
      const result = await startDevServer(cfg, { ROOT: dir });
      expect(result.browserUrl).toBe(`http://localhost:${port}`);
      expect(result.procs.length).toBe(1);
      expect(result.procs[0]).not.toBeNull();

      // Verify the server is actually reachable
      expect(await pollReadiness(`http://localhost:${port}`, 2_000)).toBe(true);

      await killAndWait(result.procs[0]);
      // Extra buffer so OS releases file locks on Windows before rmSync
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts multiple services in parallel and returns all procs', async () => {
    const dir = makeTmpDir('ds-multi');
    const portA = await findFreePort();
    const portB = await findFreePort();
    const scriptA = writeServerScript(dir);
    const scriptB = writeServerScript(dir);

    try {
      const cfg = {
        browserUrl: `http://localhost:${portA}`,
        services: [
          { command: `node ${scriptA} ${portA}`, readinessUrl: `http://localhost:${portA}` },
          { command: `node ${scriptB} ${portB}`, readinessUrl: `http://localhost:${portB}` },
        ],
        startupTimeoutMs: 15_000,
      };
      const result = await startDevServer(cfg, { ROOT: dir });
      expect(result.browserUrl).toBe(`http://localhost:${portA}`);
      expect(result.procs.length).toBe(2);

      await Promise.all(result.procs.map(killAndWait));
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kills spawned procs and returns empty when one service fails to become ready', async () => {
    const dir = makeTmpDir('ds-partial-fail');
    const portGood = await findFreePort();
    const portBad = await findFreePort();
    const scriptGood = writeServerScript(dir);

    try {
      const cfg = {
        browserUrl: `http://localhost:${portGood}`,
        services: [
          // Good service — will start a real server
          { command: `node ${scriptGood} ${portGood}`, readinessUrl: `http://localhost:${portGood}` },
          // Bad service — hangs without opening a port
          { command: 'node -e "setTimeout(() => {}, 60000)"', readinessUrl: `http://localhost:${portBad}` },
        ],
        startupTimeoutMs: 3_000,
      };
      const result = await startDevServer(cfg, { ROOT: dir });
      // All-or-nothing: one failure → empty result
      expect(result.browserUrl).toBe('');
      expect(result.procs).toEqual([]);

      await new Promise((r) => setTimeout(r, 400));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes old-format config (command + readinessUrl) transparently', async () => {
    const { url, close } = await startTestServer(200);
    try {
      // Old single-service shape — startDevServer must normalise it internally
      const cfg = { command: 'node -e "process.exit(0)"', readinessUrl: url };
      const result = await startDevServer(cfg, { ROOT: tmpdir() });
      expect(result.browserUrl).toBe(url);
      expect(result.procs).toEqual([]);
    } finally {
      await close();
    }
  });
});
