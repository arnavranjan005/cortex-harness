import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { confirm, log } from "./ui.mjs";

export async function getAllFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await getAllFiles(full)));
    else files.push(full);
  }
  return files;
}

export function fileIcon(status) {
  if (status === "created") return chalk.green("+");
  if (status === "updated") return chalk.yellow("↑");
  return chalk.dim("–");
}

// Copy a single file, prompting keep/update if it already exists.
// `rl` is retained for signature compatibility but is no longer used — prompting
// now goes through the clack-based confirm helper.
// Returns "created" | "updated" | "kept"
export async function copyFile(src, dest, rel, rl, opts = {}) {
  const exists = await fs.pathExists(dest);
  if (exists) {
    if (opts.yes || !process.stdin.isTTY) return "kept";
    const update = await confirm({
      message: `${rel} already exists — overwrite it?`,
      initialValue: false,
    });
    if (!update) return "kept";
  }
  await fs.ensureDir(path.dirname(dest));
  await fs.copy(src, dest, { overwrite: true });
  return exists ? "updated" : "created";
}

// Copy all files in srcDir → destDir, prompting per conflict.
// Per-file results are emitted as a single compact block so they sit tightly
// under the surrounding clack step instead of being double-spaced.
export async function copyDir(srcDir, destDir, rl, rootLabel, opts = {}) {
  if (!(await fs.pathExists(srcDir))) return;
  const files = await getAllFiles(srcDir);
  const lines = [];
  for (const srcFile of files) {
    const rel = path.join(rootLabel, path.relative(srcDir, srcFile));
    const destFile = path.join(destDir, path.relative(srcDir, srcFile));
    const status = await copyFile(srcFile, destFile, rel, rl, opts);
    lines.push(`${fileIcon(status)} ${chalk.dim(rel)}`);
  }
  if (lines.length) log.message(lines.join("\n"));
}

// A directory is treated as a project root if it has src/, project.json, or an index file.
export async function isProjectRoot(absPath) {
  return (
    (await fs.pathExists(path.join(absPath, "project.json"))) ||
    (await fs.pathExists(path.join(absPath, "src"))) ||
    (await fs.pathExists(path.join(absPath, "index.ts"))) ||
    (await fs.pathExists(path.join(absPath, "index.js")))
  );
}
