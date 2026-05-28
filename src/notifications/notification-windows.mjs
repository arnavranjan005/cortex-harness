import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NOTIFY_PS1 = join(__dirname, "notify-windows.ps1");

function sanitize(value) {
  return String(value ?? "").replace(/"/g, "");
}

export async function sendWindowsNotification({ title, message, meta = {} }) {
  if (process.platform !== "win32") return;

  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", NOTIFY_PS1,
      "-Title", sanitize(title),
      "-Message", sanitize(message),
    ], { stdio: "ignore" });
  } catch (err) {
    // ignore
  }
}

