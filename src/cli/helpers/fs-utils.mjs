import fs from "fs-extra";
import path from "path";
import chalk from "chalk";

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
// Returns "created" | "updated" | "kept"
export async function copyFile(src, dest, rel, rl) {
  const exists = await fs.pathExists(dest);
  if (exists) {
    if (!process.stdin.isTTY) return "kept";
    const answer = await rl.question(
      `  ${chalk.yellow("?")} ${chalk.dim(rel)} already exists — update? ${chalk.dim("[y/N]")}: `,
    );
    if (!answer.toLowerCase().startsWith("y")) {
      return "kept";
    }
  }
  await fs.ensureDir(path.dirname(dest));
  await fs.copy(src, dest, { overwrite: true });
  return exists ? "updated" : "created";
}

// Copy all files in srcDir → destDir, prompting per conflict.
export async function copyDir(srcDir, destDir, rl, rootLabel) {
  if (!(await fs.pathExists(srcDir))) return;
  const files = await getAllFiles(srcDir);
  for (const srcFile of files) {
    const rel = path.join(rootLabel, path.relative(srcDir, srcFile));
    const destFile = path.join(destDir, path.relative(srcDir, srcFile));
    const status = await copyFile(srcFile, destFile, rel, rl);
    console.log(`  ${fileIcon(status)} ${chalk.dim(rel)}`);
  }
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
