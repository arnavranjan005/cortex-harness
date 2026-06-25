import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, basename, relative } from "path";
import http from "http";
import https from "https";
import chalk from "chalk";
import { isWindows } from "./constants.mjs";
import { logger } from "../logger.mjs";

// On Windows, SIGTERM only signals the top-level PowerShell process.
// taskkill /F /T kills the entire process tree including all descendants.
export function killProc(proc) {
  if (!proc || !proc.pid) return;
  if (isWindows) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ─── dev-server utilities ─────────────────────────────────────────────────────

// Normalizes old single-service shape { command, readinessUrl } to new multi-service shape.
// Each service may carry an optional `cwd` (relative to ROOT) for non-JS frameworks
// that must start from their own project directory.
export function normalizeDevServerConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return { browserUrl: "", services: [], startupTimeoutMs: 120_000 };

  if (typeof cfg.command === "string" && typeof cfg.readinessUrl === "string") {
    return {
      browserUrl: cfg.readinessUrl,
      startupTimeoutMs: cfg.startupTimeoutMs ?? 120_000,
      services: [{ command: cfg.command, readinessUrl: cfg.readinessUrl }],
    };
  }

  return {
    browserUrl: cfg.browserUrl ?? cfg.services?.[0]?.readinessUrl ?? "",
    startupTimeoutMs: cfg.startupTimeoutMs ?? 120_000,
    services: Array.isArray(cfg.services) ? cfg.services : [],
  };
}

// ─── detection helpers ────────────────────────────────────────────────────────

function hasFile(dir, name) { return existsSync(join(dir, name)); }

function readPkgJson(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return null; }
}

// Pass 2 — check package.json dependencies / devDependencies for a package name.
function hasDep(dir, pkgName) {
  const pkg = readPkgJson(dir);
  return !!(pkg?.dependencies?.[pkgName] || pkg?.devDependencies?.[pkgName]);
}

// Pass 3 — infer the JS framework from the content of npm scripts.
// Catches monorepos where deps live in root package.json, not the project's own.
function scriptFramework(dir) {
  const all = Object.values(readPkgJson(dir)?.scripts ?? {}).join(" ");
  if (/\bnext(\s+|$)/.test(all)) return "nextjs";
  if (/\bvite(\s+|$)/.test(all)) return "vite";
  if (/\bnest\s/.test(all)) return "nestjs";
  if (/\bng\s+(serve|build)/.test(all)) return "angular";
  return null;
}

// Check requirements.txt / pyproject.toml for a Python package (case-insensitive substring).
function hasPythonDep(dir, pkg) {
  for (const f of ["requirements.txt", "pyproject.toml", "requirements/base.txt"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try { if (readFileSync(p, "utf8").toLowerCase().includes(pkg.toLowerCase())) return true; } catch { /* */ }
  }
  return false;
}

// Check Gemfile for a specific gem name.
function hasRubyGem(dir, gem) {
  const p = join(dir, "Gemfile");
  if (!existsSync(p)) return false;
  try { return new RegExp(`gem ['"]${gem}['"]`).test(readFileSync(p, "utf8")); } catch { return false; }
}

// Substring check inside a file — used for pom.xml, build.gradle, Cargo.toml.
function hasFileContent(dir, name, substr) {
  const p = join(dir, name);
  if (!existsSync(p)) return false;
  try { return readFileSync(p, "utf8").includes(substr); } catch { return false; }
}

// True if dir contains any *.csproj file.
function hasCsprojFile(dir) {
  try { return readdirSync(dir).some((f) => f.endsWith(".csproj")); } catch { return false; }
}

// Read server.port from Spring Boot's application.properties or application.yml.
function readSpringPort(dir) {
  const props = join(dir, "src", "main", "resources", "application.properties");
  if (existsSync(props)) {
    try {
      const m = readFileSync(props, "utf8").match(/server\.port\s*=\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    } catch { /* */ }
  }
  const yml = join(dir, "src", "main", "resources", "application.yml");
  if (existsSync(yml)) {
    try {
      const m = readFileSync(yml, "utf8").match(/server:\s*\n\s+port:\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    } catch { /* */ }
  }
  return null;
}

// Read the HTTP port from ASP.NET's Properties/launchSettings.json.
function readDotnetPort(dir) {
  const p = join(dir, "Properties", "launchSettings.json");
  if (!existsSync(p)) return null;
  try {
    const settings = JSON.parse(readFileSync(p, "utf8"));
    for (const prof of Object.values(settings.profiles ?? {})) {
      const m = (prof.applicationUrl ?? "").split(";")
        .find((u) => u.startsWith("http:"))?.match(/:(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
  } catch { /* */ }
  return null;
}

// Reads PORT=<n> from the first .env / .env.local / .env.development found in dir.
function readEnvPort(dir) {
  for (const name of [".env", ".env.local", ".env.development"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      const match = readFileSync(p, "utf8").match(/^PORT\s*=\s*(\d+)/m);
      if (match) return parseInt(match[1], 10);
    } catch { /* */ }
  }
  return null;
}

// Returns the Nx devTargetName for the @nx/next plugin (defaults to "dev").
function getNxNextTargetName(ROOT) {
  try {
    const nxJson = JSON.parse(readFileSync(join(ROOT, "nx.json"), "utf8"));
    const plug = (nxJson.plugins ?? []).find(
      (p) => (typeof p === "string" ? p : p.plugin ?? "").includes("@nx/next"),
    );
    return (typeof plug === "object" ? plug.options?.devTargetName : null) ?? "dev";
  } catch { return "dev"; }
}

// ─── framework DETECTORS ──────────────────────────────────────────────────────
//
// Each entry describes one framework. Fields:
//   name           — identifier used in logs
//   isFrontend     — true → service URL becomes the smoke browserUrl
//   defaultPort    — fallback when no env/config file specifies a port
//   nxTarget       — Nx run target ("dev", "serve", etc.); null for non-JS
//   npmScripts     — preferred npm script names for non-Nx JS projects
//   standaloneCmd  — command for standalone / no-package-manager context
//   needsCwd       — must run from the project directory (non-JS runtimes)
//   portFile(dir)  — optional: read a framework-specific port config file
//   resolveCommand — optional: pick the right wrapper at detection time
//   detect(dir)    — 3-pass check: config file → dep in package.json → script content

const DETECTORS = [
  // ── JavaScript / TypeScript ─────────────────────────────────────────────────
  {
    name: "nextjs", isFrontend: true, defaultPort: 3000,
    nxTarget: null,  // resolved dynamically via getNxNextTargetName
    npmScripts: ["dev", "start"],
    standaloneCmd: "npx next dev",
    detect: (dir) =>
      ["next.config.ts", "next.config.js", "next.config.mjs"].some((f) => hasFile(dir, f))  // pass 1
      || hasDep(dir, "next")                                                                   // pass 2
      || scriptFramework(dir) === "nextjs",                                                    // pass 3
  },
  {
    name: "vite", isFrontend: true, defaultPort: 5173,
    nxTarget: "dev",
    npmScripts: ["dev", "start"],
    standaloneCmd: "npx vite",
    detect: (dir) =>
      ["vite.config.ts", "vite.config.js", "vite.config.mjs"].some((f) => hasFile(dir, f))
      || hasDep(dir, "vite")
      || scriptFramework(dir) === "vite",
  },
  {
    name: "angular", isFrontend: true, defaultPort: 4200,
    nxTarget: "serve",
    npmScripts: ["start", "serve"],
    standaloneCmd: "npx ng serve",
    detect: (dir) =>
      hasFile(dir, "angular.json")
      || hasDep(dir, "@angular/core")
      || scriptFramework(dir) === "angular",
  },
  {
    name: "nestjs", isFrontend: false, defaultPort: 3000,
    nxTarget: "serve",
    npmScripts: ["start:dev", "dev", "start"],
    standaloneCmd: "npx nest start --watch",
    detect: (dir) =>
      hasFile(dir, "nest-cli.json")
      || hasDep(dir, "@nestjs/core")
      || scriptFramework(dir) === "nestjs",
  },
  {
    // Express: no config file, so passes 2 and 3 are the only signals.
    // Listed after NestJS so @nestjs/core projects don't double-match.
    name: "express", isFrontend: false, defaultPort: 3001,
    nxTarget: "serve",
    npmScripts: ["dev", "start:dev", "start"],
    standaloneCmd: null,
    detect: (dir) => hasDep(dir, "express") && !hasDep(dir, "@nestjs/core"),
  },
  // ── Python ──────────────────────────────────────────────────────────────────
  {
    name: "django", isFrontend: false, defaultPort: 8000,
    needsCwd: true, standaloneCmd: "python manage.py runserver",
    detect: (dir) => hasFile(dir, "manage.py"),
  },
  {
    name: "fastapi", isFrontend: false, defaultPort: 8000,
    needsCwd: true, standaloneCmd: "uvicorn main:app --reload",
    detect: (dir) => hasPythonDep(dir, "fastapi"),
  },
  {
    name: "flask", isFrontend: false, defaultPort: 5000,
    needsCwd: true, standaloneCmd: "flask run",
    // Listed after FastAPI to avoid false-positive (FastAPI also ships Flask-compatible routing)
    detect: (dir) => hasPythonDep(dir, "flask") && !hasPythonDep(dir, "fastapi"),
  },
  // ── Ruby ────────────────────────────────────────────────────────────────────
  {
    name: "rails", isFrontend: false, defaultPort: 3000,
    needsCwd: true, standaloneCmd: "bundle exec rails server",
    detect: (dir) => hasFile(dir, "Gemfile") && hasRubyGem(dir, "rails"),
  },
  // ── Java ────────────────────────────────────────────────────────────────────
  {
    name: "spring-boot", isFrontend: false, defaultPort: 8080,
    needsCwd: true, standaloneCmd: null,
    portFile: readSpringPort,
    resolveCommand: (dir) => {
      if (hasFile(dir, "mvnw")) return "./mvnw spring-boot:run";
      if (hasFile(dir, "gradlew")) return "./gradlew bootRun";
      return hasFile(dir, "build.gradle") ? "gradle bootRun" : "mvn spring-boot:run";
    },
    detect: (dir) =>
      (hasFile(dir, "pom.xml") && hasFileContent(dir, "pom.xml", "spring-boot"))
      || (hasFile(dir, "build.gradle") && hasFileContent(dir, "build.gradle", "spring-boot")),
  },
  // ── .NET ────────────────────────────────────────────────────────────────────
  {
    name: "dotnet", isFrontend: false, defaultPort: 5000,
    needsCwd: true, standaloneCmd: "dotnet run",
    portFile: readDotnetPort,
    detect: (dir) => hasCsprojFile(dir),
  },
  // ── Go ──────────────────────────────────────────────────────────────────────
  {
    name: "go", isFrontend: false, defaultPort: 8080,
    needsCwd: true, standaloneCmd: "go run .",
    detect: (dir) => hasFile(dir, "go.mod"),
  },
  // ── PHP / Laravel ───────────────────────────────────────────────────────────
  {
    name: "laravel", isFrontend: false, defaultPort: 8000,
    needsCwd: true, standaloneCmd: "php artisan serve",
    detect: (dir) => hasFile(dir, "artisan"),
  },
  // ── Rust (actix-web / axum / rocket) ────────────────────────────────────────
  {
    name: "rust", isFrontend: false, defaultPort: 8080,
    needsCwd: true, standaloneCmd: "cargo run",
    detect: (dir) =>
      hasFile(dir, "Cargo.toml")
      && (hasFileContent(dir, "Cargo.toml", "actix-web")
        || hasFileContent(dir, "Cargo.toml", "axum")
        || hasFileContent(dir, "Cargo.toml", "rocket")),
  },
];

// ─── project scanning ─────────────────────────────────────────────────────────

function buildNxCommand(ROOT, projectName, targetName) {
  const projJsonPath = join(ROOT, projectName, "project.json");
  if (existsSync(projJsonPath)) {
    try {
      const p = JSON.parse(readFileSync(projJsonPath, "utf8"));
      const name = p.name ?? projectName;
      if (p?.targets?.[targetName]) return `npm exec nx run ${name}:${targetName}`;
    } catch { /* */ }
  }
  return `npm exec nx run ${projectName}:${targetName}`;
}

// Returns candidate project directories at depth 1 from ROOT, excluding noise.
function getCandidateDirs(ROOT) {
  let entries;
  try { entries = readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) =>
      e.isDirectory()
      && e.name !== "node_modules"
      && !e.name.startsWith(".")
      && !e.name.endsWith("-e2e")
      && !["dist", "build", "out", ".next", ".nuxt", "tmp"].includes(e.name),
    )
    .map((e) => join(ROOT, e.name));
}

// Run DETECTORS against a directory and resolve the start command + cwd.
// Returns { command, readinessUrl, cwd, isFrontend } or null.
function detectProject(dir, ROOT) {
  const isNxWorkspace = existsSync(join(ROOT, "nx.json"));
  const dirName = basename(dir);

  for (const det of DETECTORS) {
    if (!det.detect(dir)) continue;

    const port = (det.portFile ? det.portFile(dir) : null) ?? readEnvPort(dir) ?? det.defaultPort;
    const readinessUrl = `http://localhost:${port}`;
    let command, cwd;

    if (det.needsCwd) {
      // Non-JS (or framework that must run from its own directory regardless of workspace type)
      command = det.resolveCommand ? det.resolveCommand(dir) : det.standaloneCmd;
      if (!command) continue;
      const rel = relative(ROOT, dir).replace(/\\/g, "/");
      cwd = rel || null;
    } else if (isNxWorkspace) {
      const target = det.name === "nextjs" ? getNxNextTargetName(ROOT) : (det.nxTarget ?? "serve");
      command = buildNxCommand(ROOT, dirName, target);
      cwd = null;
    } else {
      // Custom JS monorepo or standalone: prefer npm scripts, fall back to standalone command.
      const scripts = readPkgJson(dir)?.scripts ?? {};
      const script = (det.npmScripts ?? []).find((s) => scripts[s]);
      if (script) {
        const rel = relative(ROOT, dir).replace(/\\/g, "/");
        command = (rel === "" || rel === ".") ? `npm run ${script}` : `npm --prefix ${rel} run ${script}`;
      } else if (det.standaloneCmd) {
        command = det.standaloneCmd;
      } else {
        continue;
      }
      cwd = null;
    }

    return { command, readinessUrl, cwd: cwd ?? null, isFrontend: !!det.isFrontend };
  }

  // Nx fallback: explicit project.json with a serve target (e.g. @nx/js:node) but no framework file.
  if (isNxWorkspace) {
    const projJsonPath = join(dir, "project.json");
    if (existsSync(projJsonPath)) {
      try {
        const p = JSON.parse(readFileSync(projJsonPath, "utf8"));
        if (p?.targets?.serve) {
          const name = p.name ?? dirName;
          const port = readEnvPort(dir) ?? 3001;
          return { command: `npm exec nx run ${name}:serve`, readinessUrl: `http://localhost:${port}`, cwd: null, isFrontend: false };
        }
      } catch { /* */ }
    }
  }

  return null;
}

// ─── public API ───────────────────────────────────────────────────────────────

// Poll url every 2 s until it responds with a non-5xx status or timeoutMs elapses.
export function pollReadiness(url, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const mod = url.startsWith("https") ? https : http;
    function attempt() {
      if (Date.now() >= deadline) { resolve(false); return; }
      const req = mod.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.setTimeout(2000, () => { req.destroy(); setTimeout(attempt, 2000); });
      req.on("error", () => setTimeout(attempt, 2000));
    }
    attempt();
  });
}

// Detect devServer config from project structure.
// Returns services[] shape with _detected:true, or null if nothing recognised.
export function detectDevServerConfig(ROOT) {
  const services = [];
  let browserUrl = null;

  for (const dir of getCandidateDirs(ROOT)) {
    const info = detectProject(dir, ROOT);
    if (!info) continue;
    if (info.isFrontend && !browserUrl) browserUrl = info.readinessUrl;
    services.push({
      command: info.command,
      readinessUrl: info.readinessUrl,
      ...(info.cwd ? { cwd: info.cwd } : {}),
    });
  }

  // No subdir matches — try ROOT itself (standalone single-project app).
  if (!services.length) {
    const info = detectProject(ROOT, ROOT);
    if (!info) return null;
    services.push({ command: info.command, readinessUrl: info.readinessUrl });
    if (info.isFrontend) browserUrl = info.readinessUrl;
  }

  if (!services.length) return null;

  return {
    browserUrl: browserUrl ?? services[0].readinessUrl,
    startupTimeoutMs: 120_000,
    services,
    _detected: true,
  };
}

// Spawn a service process. svc.cwd (relative or absolute path) overrides ROOT as the cwd.
function spawnService(svc, ROOT) {
  const spawnCwd = svc.cwd
    ? (svc.cwd.startsWith("/") || /^[A-Za-z]:/.test(svc.cwd) ? svc.cwd : join(ROOT, svc.cwd))
    : ROOT;
  let proc;
  if (isWindows) {
    proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", svc.command],
      { cwd: spawnCwd, stdio: "ignore" },
    );
  } else {
    const parts = svc.command.split(/\s+/);
    proc = spawn(parts[0], parts.slice(1), { cwd: spawnCwd, stdio: "ignore" });
  }
  proc.on("error", () => {});
  return proc;
}

// Start all configured dev server services in parallel.
// Returns { procs: ChildProcess[], browserUrl: string }.
// On timeout or partial failure, kills all spawned procs and returns { procs:[], browserUrl:"" }.
export async function startDevServer(dsConfig, { ROOT }) {
  const cfg = normalizeDevServerConfig(dsConfig);
  if (!cfg.services.length) return { procs: [], browserUrl: "" };

  const timeoutMs = cfg.startupTimeoutMs;

  const results = await Promise.all(
    cfg.services.map(async (svc) => {
      const already = await pollReadiness(svc.readinessUrl, 3_000);
      if (already) {
        logger.info(`  ${chalk.dim("[DEV SERVER]")} Already running at ${svc.readinessUrl}`);
        return { proc: null, ready: true };
      }
      logger.info(`  ${chalk.dim("[DEV SERVER]")} Starting: ${svc.command}`);
      const proc = spawnService(svc, ROOT);
      const ready = await pollReadiness(svc.readinessUrl, timeoutMs);
      return { proc, ready };
    }),
  );

  const spawnedProcs = results.map((r) => r.proc).filter(Boolean);
  const allReady = results.every((r) => r.ready);

  if (!allReady) {
    const failed = cfg.services.filter((_, i) => !results[i].ready).map((s) => s.readinessUrl);
    logger.info(`  ${chalk.yellow("[DEV SERVER]")} Not ready within ${timeoutMs / 1000}s: ${failed.join(", ")} — smoke will skip`);
    spawnedProcs.forEach((p) => killProc(p));
    return { procs: [], browserUrl: "" };
  }

  logger.info(`  ${chalk.dim("[DEV SERVER]")} All services ready — browser: ${cfg.browserUrl}`);
  return { procs: spawnedProcs, browserUrl: cfg.browserUrl };
}

// Reads mcpScope from harness.config.json and .mcp.json from ROOT, then returns
// a filtered mcpServers object scoped to the given agent — or null when no filtering
// is needed (mcpScope absent). Writes nothing; caller is responsible for temp file.
export function buildFilteredMcpServers(agentName, { config, ROOT }) {
  const mcpScope = config.mcpScope;
  if (!mcpScope || typeof mcpScope !== "object") return null;

  const mcpPath = join(ROOT, ".mcp.json");
  if (!existsSync(mcpPath)) return null;

  let mcp;
  try {
    mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch {
    return null;
  }

  const allServers = mcp.mcpServers ?? {};
  const globalAllowed = Array.isArray(mcpScope["*"]) ? mcpScope["*"] : [];
  const agentAllowed = Array.isArray(mcpScope[agentName]) ? mcpScope[agentName] : [];
  const allowed = new Set([...globalAllowed, ...agentAllowed]);

  const filtered = {};
  for (const name of allowed) {
    if (allServers[name]) filtered[name] = allServers[name];
  }
  return filtered;
}
