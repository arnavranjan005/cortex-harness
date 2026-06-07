/**
 * Integration tests: full multi-command harness workflow.
 * Verifies that init → config → gitignore → status form a coherent, non-destructive flow.
 */
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'bin', 'cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `oah-workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('init → config add-scope → config list → config remove-scope workflow', () => {
  const dir = makeTmpDir();
  try {
    try { execSync('git init', { cwd: dir, stdio: 'ignore' }); } catch { /* ok */ }

    // 1. init
    const initResult = spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    expect(initResult.status).toBe(0);

    // 2. config list shows defaults
    const listResult = spawnSync('node', [CLI, 'config', 'list'], { cwd: dir, encoding: 'utf8' });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain('backend-subagent');

    // 3. add-scope writes to disk
    spawnSync('node', [CLI, 'config', 'add-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });
    const config = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(config.agents['backend-subagent'].scope).toContain('api/src/');

    // 4. config list reflects the change
    const listAfter = spawnSync('node', [CLI, 'config', 'list'], { cwd: dir, encoding: 'utf8' });
    expect(listAfter.stdout).toContain('api/src/');

    // 5. remove-scope cleans it back up
    spawnSync('node', [CLI, 'config', 'remove-scope', 'backend-subagent', 'api/src/'], { cwd: dir, encoding: 'utf8' });
    const configAfter = JSON.parse(readFileSync(join(dir, 'harness.config.json'), 'utf8'));
    expect(configAfter.agents['backend-subagent'].scope).not.toContain('api/src/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init → gitignore is idempotent (init already runs gitignore internally)', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    const contentAfterInit = readFileSync(join(dir, '.gitignore'), 'utf8');

    const result = spawnSync('node', [CLI, 'gitignore'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already contains');

    const contentAfterGitignore = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(contentAfterGitignore).toBe(contentAfterInit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init → status with no queue → status with pending queue', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });

    // status before any run
    const statusBefore = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(statusBefore.status).toBe(0);
    expect(statusBefore.stdout).toContain('No active run');

    // simulate a queued run
    writeFileSync(
      join(dir, '.harness', 'task-queue.json'),
      JSON.stringify({
        task: 'Add user profile page',
        promptType: 'implement-feature',
        cycles: [
          { id: 'orchestrate-1', type: 'orchestrate', status: 'done' },
          { id: 'implement-1', type: 'implement', status: 'pending' },
        ],
      }),
    );

    const statusAfter = spawnSync('node', [CLI, 'status'], { cwd: dir, encoding: 'utf8' });
    expect(statusAfter.status).toBe(0);
    expect(statusAfter.stdout).toContain('Add user profile page');
    expect(statusAfter.stdout).toContain('1 done');
    expect(statusAfter.stdout).toContain('1 pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init → re-init preserves .mcp.json user entries and harness.config.json structure', () => {
  const dir = makeTmpDir();
  try {
    spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });

    // add a custom MCP server entry
    const mcpPath = join(dir, '.mcp.json');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    mcp.mcpServers['my-custom-tool'] = { type: 'stdio', command: 'my-tool', args: [] };
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

    // add a custom key to harness.config.json
    const configPath = join(dir, 'harness.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config._myCustomKey = 'preserved';
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // re-init
    spawnSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });

    // harness.config.json is NOT replaced (copyFile keeps it when stdin is non-TTY)
    const configAfter = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(configAfter._myCustomKey).toBe('preserved');
    expect(configAfter.harnessDir).toBeDefined();

    // .mcp.json preserves user server and keeps playwright
    const mcpAfter = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(mcpAfter.mcpServers['my-custom-tool']).toBeDefined();
    expect(mcpAfter.mcpServers.playwright).toBeDefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full --help surfaces all registered commands', () => {
  const dir = makeTmpDir();
  try {
    const result = spawnSync('node', [CLI, '--help'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);

    const commands = ['init', 'config', 'gitignore', 'run', 'continue', 'chain', 'status', 'resume', 'logs', 'notify-setup', 'notify'];
    for (const cmd of commands) {
      expect(result.stdout).toContain(cmd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
