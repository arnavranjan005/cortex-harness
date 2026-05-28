const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

try {
  const workspaceRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  const hash = workspaceRoot.replace(/[^a-zA-Z0-9\-]/g, '-');

  const localMemoryDir = path.join(os.homedir(), '.claude', 'projects', hash, 'memory');
  const projectMemoryDir = path.join(workspaceRoot, '.harness', 'memory');

  if (!fs.existsSync(projectMemoryDir)) process.exit(0);

  fs.mkdirSync(localMemoryDir, { recursive: true });

  let synced = 0;
  for (const file of fs.readdirSync(projectMemoryDir)) {
    if (!file.endsWith('.md')) continue;
    const src = path.join(projectMemoryDir, file);
    const dst = path.join(localMemoryDir, file);
    const srcMtime = fs.statSync(src).mtimeMs;
    const dstMtime = fs.existsSync(dst) ? fs.statSync(dst).mtimeMs : 0;
    if (srcMtime > dstMtime) {
      fs.copyFileSync(src, dst);
      synced++;
    }
  }
} catch (e) {
  // silent fail
}

