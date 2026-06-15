import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import chalk from "chalk";
import { startDevServer, killProc } from "./process-utils.mjs";
import { isWindows } from "./constants.mjs";

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function profileStorageFile(name) {
  return `.harness/smoke-auth-${name}.json`;
}

export function buildUrlCheckPrompt(url, devServerUrl, profileMcpNames) {
  const hasProfiles = profileMcpNames.length > 0;
  const profileSessionLines = hasProfiles
    ? profileMcpNames.map(n => `  mcp__playwright-${n}__* → ${n} profile`).join("\n")
    : "";

  const authStaleJson = `{"url":"${url}","profile":null,"status":"auth_stale","staleProfiles":[<names tried>],"pageRenderOk":false,"pageError":null,"renderSummary":null,"apiCalls":[],"apiCallCount":0,"consoleErrors":[],"consoleWarnings":[],"runtimeChecks":null,"issues":[],"screenshotPath":null}`;
  const authNeededJson = `{"url":"${url}","profile":null,"status":"auth_needed","pageRenderOk":false,"pageError":null,"renderSummary":null,"apiCalls":[],"apiCallCount":0,"consoleErrors":[],"consoleWarnings":[],"runtimeChecks":null,"issues":[],"screenshotPath":null}`;

  const profileTryBlock = hasProfiles
    ? profileMcpNames.map((n, i) =>
        `    ${i + 1}. mcp__playwright-${n}__browser_navigate → ${devServerUrl}${url}`
      ).join("\n")
    : "    (none configured)";

  const protectedBlock = hasProfiles
    ? `  ── PROTECTED + profiles available — try each in order: ──
${profileTryBlock}
    First that loads ${url} WITHOUT a login redirect:
      → Use that session for ALL remaining steps (STEPS 2–8)
      → Set profile: "<that profile's name>"
    All profiles redirect to login (sessions expired):
      → Return immediately: ${authStaleJson}`
    : `  ── PROTECTED + no profiles configured: ──
    → Return immediately: ${authNeededJson}`;

  return `You are running a passive smoke check on ONE page. Use browser MCP tools only. No clicks, no form submissions, no POST requests. Return JSON only — no explanation, no markdown.

Page: ${devServerUrl}${url}
Available MCP sessions:
  mcp__playwright__*  → UNAUTHENTICATED probe — no stored credentials, always starts logged out
${profileSessionLines || "  (no auth profiles — protected pages will return auth_needed)"}

━━━ STEP 1 — Classify page & select session ━━━━━━━━━━━━━━━━━━━━━━

mcp__playwright__* has NO stored credentials. Always use it first to determine
whether this page requires authentication before doing any other checks.

  1a) Navigate with the unauthenticated probe:
      mcp__playwright__browser_navigate → ${devServerUrl}${url}

  1b) After navigation, check the final URL:
      Run browser_evaluate: window.location.pathname
      Compare final pathname to the requested path "${url}".
      Strip trailing slashes before comparing (e.g. "/account/" === "/account").

  1c) Determine if the page is PROTECTED:
      Page is PROTECTED if ANY of these are true:
      - Final pathname ≠ requested path (redirected away — any redirect = protection)
      - Final URL path contains: /login, /signin, /sign-in, /auth
      - Page has a visible password input field
      - Page heading or primary button text is "Sign in", "Log in", or "Login"

  1d) Select session based on result:

  ── NOT protected → page is PUBLIC ──
    → Use mcp__playwright__* for ALL remaining steps (STEPS 2–8)
    → Set profile: "public"

${protectedBlock}

━━━ STEP 2 — Wait for stable state (browser_wait_for) ━━━━━━━━━━━━
Wait up to 8 seconds for the page to finish loading before any checks:
  - Wait for selector "body" to be visible
  - If a loading spinner or skeleton is present (aria-label containing "loading", or role="progressbar"), wait for it to disappear (timeout 5s — do not fail if it persists)
  - Run browser_evaluate: document.readyState — if not "complete", wait 2 more seconds then continue regardless

━━━ STEP 3 — Render check (browser_snapshot) ━━━━━━━━━━━━━━━━━━━━━
Take a full accessibility tree snapshot. Analyze its content:

  Hard failures — set pageRenderOk: false, record text in pageError, add to issues[]:
  - Visible text contains any of: "404", "Not Found", "500", "Internal Server Error",
    "Something went wrong", "ChunkLoadError", "Unexpected token", "Application error"
  - An error boundary is rendered (role=alert with error content, or Next.js error overlay)
  - Body content is completely blank (no meaningful nodes beyond html/body/head)

  Structural checks — record in renderSummary, do NOT add to issues[]:
  - Count headings: document.querySelectorAll('h1,h2,h3').length → renderSummary.headingCount
  - Navigation present: any element with role="navigation" → renderSummary.navPresent (bool)
  - Main content present: role="main" or id="main" or <main> exists → renderSummary.mainPresent (bool)
  - Stuck spinner: any loading indicator still visible after STEP 2 wait → renderSummary.stuckSpinner (bool)
    Add to issues[] if stuckSpinner is true: "Loading spinner still visible after 8s"

━━━ STEP 4 — Runtime state (browser_evaluate) ━━━━━━━━━━━━━━━━━━━━
Run each check separately with browser_evaluate. If any call throws, store null and continue.
Store all results in "runtimeChecks".

  a) Page completeness:
     - document.body.scrollHeight > 100 → runtimeChecks.pageHasContent (bool)
     - Array.from(document.querySelectorAll('img')).filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src).filter(s => s && !s.startsWith('data:')).slice(0, 5)
       → runtimeChecks.brokenImages (string[])
       Add to issues[] for each: "Broken image: <src>"

  b) Framework error signals:
     - document.querySelector('[data-nextjs-error]') !== null → runtimeChecks.nextjsErrorOverlay (bool)
       Add to issues[] if true: "Next.js error overlay detected"
     - document.querySelector('#__next')?.children.length ?? null → runtimeChecks.nextjsRootChildren (number|null)
       Add to issues[] if 0: "Next.js root is empty — possible hydration failure"
     - window.__nuxt_error__ !== undefined → runtimeChecks.nuxtError (bool, add to issues[] if true)

  c) Performance — failed resource loads:
     - performance.getEntriesByType('resource').filter(r => r.transferSize === 0 && r.duration > 0 && !['beacon','xmlhttprequest','fetch'].includes(r.initiatorType)).map(r => r.name).slice(0, 5)
       → runtimeChecks.failedResources (string[])
       Add to issues[] for each JS/CSS resource that failed: "Failed to load resource: <url>"

  d) Service worker & push:
     - 'serviceWorker' in navigator → runtimeChecks.swSupported (bool)
     - If swSupported: navigator.serviceWorker.getRegistration().then(r => r?.active?.state ?? 'unregistered').catch(() => 'error')
       → runtimeChecks.swState ("activated"|"activating"|"installed"|"unregistered"|"error"|null)
       Add to issues[] only if swState === "error": "Service worker threw during registration check"
     - 'Notification' in window ? Notification.permission : null → runtimeChecks.notificationPermission
     - 'PushManager' in window → runtimeChecks.pushSupported (bool)

  e) Global error accumulator (if the app exposes one):
     - window.__errors?.length ?? null → runtimeChecks.appErrorCount (number|null)
       Add to issues[] if > 0: "App reported <n> global error(s)"

━━━ STEP 5 — Network requests (browser_network_requests) ━━━━━━━━━
Capture ALL network requests made since page load. For each record:
  {"url": "<full path>", "method": "GET|POST|...", "status": <code or "connection-error">}

  Add to issues[] for:
  - Any 4xx response: "API <METHOD> <path> returned <status>"
  - Any 5xx response: "API <METHOD> <path> returned <status>"
  - Status 0 AND console has a message containing "CORS policy" or "Access-Control": "CORS error on <METHOD> <path>"

  Do NOT add to issues[]:
  - ECONNREFUSED → record status as "connection-error" (backend not running in dev)
  - ERR_CONNECTION_RESET with no CORS console message → record status as "connection-error" (browser closed while SSE/websocket open)
  - 3xx redirects (normal)

  Record total count: apiCallCount = total number of requests captured

━━━ STEP 6 — Console messages (browser_console_messages) ━━━━━━━━━
Capture ALL console output. Categorize each message:

  Add full text to consoleErrors[] AND issues[] if level is "error" AND message contains any of:
    TypeError, ReferenceError, SyntaxError, Uncaught, "Unhandled promise rejection",
    ChunkLoadError, "Module not found", hydration, "Warning: Each child in a list"

  Do NOT add to issues[] (record in consoleErrors[] only):
  - "Failed to load resource" with ERR_CONNECTION_RESET or ERR_NETWORK_CHANGED — unless the same request also has "CORS policy" or "Access-Control" in the console (browser-close false positive vs real CORS block)

  Add full text to consoleWarnings[] (do NOT add to issues[]) if:
    level is "warning" AND contains: undefined, null, deprecated

  IGNORE entirely:
    [HMR], [Fast Refresh], third-party script errors (URLs containing node_modules or CDN domains),
    "Download the React DevTools", favicon 404s

━━━ STEP 7 — Screenshot on failure (browser_take_screenshot) ━━━━━
Only if issues[] is non-empty after all steps above:
  Take a screenshot. Record the file path returned by the tool in screenshotPath.
  If no issues, set screenshotPath: null.

━━━ STEP 8 — Close browser (browser_close) ━━━━━━━━━━━━━━━━━━━━━━━
Always call browser_close now. This releases open connections (SSE, websockets)
and lets the MCP process clean up before you return. Do not skip this step.

━━━ RETURN FORMAT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Return ONLY this JSON — no markdown, no explanation, nothing else:
{
  "url": "${url}",
  "profile": "<public | profile-name>",
  "status": "<pass | fail | auth_needed | auth_stale>",
  "pageRenderOk": true,
  "pageError": null,
  "renderSummary": {
    "headingCount": 3,
    "navPresent": true,
    "mainPresent": true,
    "stuckSpinner": false
  },
  "apiCalls": [{"url": "/api/example", "method": "GET", "status": 200}],
  "apiCallCount": 3,
  "consoleErrors": [],
  "consoleWarnings": [],
  "runtimeChecks": {
    "pageHasContent": true,
    "brokenImages": [],
    "nextjsErrorOverlay": false,
    "nextjsRootChildren": 2,
    "nuxtError": false,
    "failedResources": [],
    "swSupported": true,
    "swState": "activated",
    "notificationPermission": "default",
    "pushSupported": true,
    "appErrorCount": null
  },
  "issues": [],
  "screenshotPath": null,
  "staleProfiles": []
}

status = "fail" if pageRenderOk is false OR issues[] is non-empty.
status = "pass" if all checks passed with no issues.`.trim();
}

export function mergeResults(urlResults) {
  const authBlock = urlResults.find(r => r.status === "auth_needed" || r.status === "auth_stale");
  if (authBlock) {
    return {
      passed: false,
      skipped: false,
      authIssue: authBlock.status === "auth_needed" ? "missing" : "stale",
      missingProfiles: authBlock.status === "auth_needed" ? [] : undefined,
      staleProfiles: authBlock.staleProfiles ?? [],
      affectedPages: [authBlock.url],
      pagesChecked: [],
      apiCallsChecked: [],
      consoleErrors: [],
      failures: [],
    };
  }

  const failures = urlResults
    .filter(r => r.status === "fail")
    .map(r => ({
      url: r.url,
      pageError: r.pageError ?? null,
      renderSummary: r.renderSummary ?? null,
      apiFailures: (r.apiCalls ?? []).filter(a => typeof a.status === "number" && a.status >= 400),
      consoleErrors: r.consoleErrors ?? [],
      screenshotPath: r.screenshotPath ?? null,
      issues: r.issues ?? [],
    }));

  const runtimeChecks = {};
  for (const r of urlResults) {
    if (r.runtimeChecks) runtimeChecks[r.url] = r.runtimeChecks;
  }

  return {
    passed: failures.length === 0,
    skipped: false,
    pagesChecked: urlResults.map(r => ({
      url: r.url,
      profile: r.profile,
      status: r.status,
      renderSummary: r.renderSummary ?? null,
      issues: r.issues ?? [],
    })),
    apiCallsChecked: urlResults.flatMap(r => r.apiCalls ?? []),
    apiCallCount: urlResults.reduce((n, r) => n + (r.apiCallCount ?? 0), 0),
    consoleErrors: urlResults.flatMap(r => r.consoleErrors ?? []),
    consoleWarnings: urlResults.flatMap(r => r.consoleWarnings ?? []),
    failures,
    ...(Object.keys(runtimeChecks).length ? { runtimeChecks } : {}),
  };
}

export function buildAuthBlockMessage(authResult) {
  if (authResult.status === "auth_needed") {
    const profiles = authResult.missingProfiles ?? [];
    if (profiles.length === 0) {
      return [
        "Pages require login but no auth state found.",
        "Run: cortex-harness auth",
        "Then: cortex-harness resume",
      ].join("\n");
    }
    return [
      `Auth state missing for profiles: ${profiles.join(", ")}.`,
      ...profiles.map(p => `Run: cortex-harness auth --profile ${p}`),
      "Then: cortex-harness resume",
    ].join("\n");
  }
  const stale = authResult.staleProfiles ?? [];
  return [
    `Auth session expired for: ${stale.join(", ")}.`,
    ...stale.map(p => `Re-run: cortex-harness auth --profile ${p}`),
    "Then: cortex-harness resume",
  ].join("\n");
}

// ── Orchestrator factory ──────────────────────────────────────────────────────

export function createSmokeOrchestrator({
  ROOT, HARNESS_DIR, CYCLE_DIR, RUNS_DIR,
  config, CLAUDE_EXE, appendLog,
  buildFilteredMcpServers,
}) {
  function buildProfileMcpServers(filteredServers) {
    const profiles = (config.authProfiles ?? []).filter(p =>
      p?.name && p?.storageFile && existsSync(join(ROOT, p.storageFile))
    );
    if (!profiles.length) return filteredServers ?? {};

    const servers = filteredServers ? { ...filteredServers } : {};
    const basePw = servers.playwright ?? { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] };
    for (const p of profiles) {
      servers[`playwright-${p.name}`] = {
        ...basePw,
        args: [
          ...(basePw.args ?? []).filter(a => !String(a).startsWith("--storage-state")),
          `--storage-state=${p.storageFile}`,
        ],
      };
    }
    return servers;
  }

  // Per-page budget: configurable via harness.config.json smokeCheckBudgetPerUrl.
  // Default 0.80 — Playwright MCP tool schema overhead + navigate/snapshot/evaluate
  // calls burn through 0.15 before the first page check completes.
  const perPageBudget = (config.smokeCheckBudgetPerUrl ?? 0.80).toFixed(2);

  async function spawnMiniClaude(prompt, mcpConfigPath) {
    return new Promise((resolve) => {
      let output = "";
      const timeout = setTimeout(() => {
        try { killProc(proc); } catch {}
        resolve(null);
      }, 90_000);

      let proc;
      if (isWindows) {
        const promptFile = join(RUNS_DIR, `smoke-prompt-${Date.now()}.txt`);
        const psFile = join(RUNS_DIR, `smoke-${Date.now()}.ps1`);
        writeFileSync(promptFile, prompt, "utf8");
        writeFileSync(
          psFile,
          `Get-Content -Path "${promptFile}" -Raw -Encoding UTF8 | & "${CLAUDE_EXE}" --print --mcp-config "${mcpConfigPath}" --allowedTools "mcp__playwright__*,mcp__playwright-*__*,ToolSearch" --output-format text --max-turns 20 --max-budget-usd ${perPageBudget} --dangerously-skip-permissions\n`,
          "utf8",
        );
        proc = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        proc.on("close", () => {
          try { unlinkSync(promptFile); unlinkSync(psFile); } catch {}
          clearTimeout(timeout); resolve(output.trim());
        });
      } else {
        proc = spawn(
          CLAUDE_EXE,
          ["-p", prompt, "--mcp-config", mcpConfigPath,
           "--allowedTools", "mcp__playwright__*,mcp__playwright-*__*,ToolSearch",
           "--output-format", "text", "--max-turns", "20",
           "--max-budget-usd", perPageBudget, "--dangerously-skip-permissions"],
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        proc.on("close", () => { clearTimeout(timeout); resolve(output.trim()); });
      }
      proc.stdout?.on("data", chunk => { output += chunk.toString("utf8"); });
      proc.on("error", () => { clearTimeout(timeout); resolve(null); });
    });
  }

  async function checkOneUrl(url, devServerUrl, mcpServers, profileMcpNames) {
    const tmpMcp = join(HARNESS_DIR, `tmp-mcp-smoke-${Date.now()}.json`);
    writeFileSync(tmpMcp, JSON.stringify({ mcpServers }, null, 2), "utf8");

    const prompt = buildUrlCheckPrompt(url, devServerUrl, profileMcpNames);
    const raw = await spawnMiniClaude(prompt, tmpMcp);
    try { unlinkSync(tmpMcp); } catch {}

    if (!raw) {
      return { url, profile: null, status: "fail", pageRenderOk: false,
               pageError: "smoke check timed out", apiCalls: [], consoleErrors: [],
               issues: ["smoke check timed out"], staleProfiles: [] };
    }

    // Detect Claude session/weekly limit before trying to parse JSON
    if (/session limit|weekly limit|usage limit/i.test(raw) && !raw.includes("{")) {
      const resetsMatch = raw.match(/resets\s+([^\n·•]+)/i);
      return { url, profile: null, status: "session-limit",
               pageError: "session limit hit", apiCalls: [], consoleErrors: [],
               issues: [`session limit: ${raw.slice(0, 200)}`],
               _sessionLimit: true, _resetsAt: resetsMatch?.[1]?.trim() ?? null, staleProfiles: [] };
    }

    // Extract JSON from final message (LLM may add surrounding text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { url, profile: null, status: "fail", pageRenderOk: false,
               pageError: "smoke check returned non-JSON", apiCalls: [], consoleErrors: [],
               issues: [`smoke check returned non-JSON response: ${raw.slice(0, 200)}`], staleProfiles: [] };
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return { url, profile: null, status: "fail", pageRenderOk: false,
               pageError: "invalid JSON from smoke check", apiCalls: [], consoleErrors: [],
               issues: ["smoke check returned invalid JSON"], staleProfiles: [] };
    }
  }

  async function runSmokeOrchestration(cycle, probeUrlsJson, devServerUrl) {
    const { urls = [], layoutAffected = false } = JSON.parse(probeUrlsJson);

    if (!urls.length && !layoutAffected) {
      const output = { passed: true, skipped: true, reason: "no page files changed",
                       pagesChecked: [], apiCallsChecked: [], consoleErrors: [], failures: [] };
      writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");
      return { signal: "complete", finalMessage: "CYCLE_COMPLETE", turnCount: 0 };
    }

    const rawServers = buildFilteredMcpServers("smoke");
    const mcpServers = buildProfileMcpServers(rawServers);
    const profileMcpNames = Object.keys(mcpServers)
      .filter(k => k.startsWith("playwright-"))
      .map(k => k.replace("playwright-", ""));

    appendLog({ type: "smoke-orchestrator", event: "start", urls, profileMcpNames });

    const urlResults = [];
    for (const url of urls) {
      const result = await checkOneUrl(url, devServerUrl, mcpServers, profileMcpNames);
      appendLog({ type: "smoke-orchestrator", event: "url-result", url, status: result.status });
      urlResults.push(result);
      const issueCount = result.issues?.length ?? 0;
      const statusColor = result.status === "pass" ? chalk.green : result.status === "auth_needed" || result.status === "auth_stale" ? chalk.yellow : chalk.red;
      console.log(chalk.dim("[SMOKE]"), chalk.bold(url), "→", statusColor(result.status) + (issueCount ? chalk.dim(` (${issueCount} issue${issueCount > 1 ? "s" : ""})`) : ""));

      // Stop on first auth block or session limit — no point checking remaining URLs
      if (result.status === "auth_needed" || result.status === "auth_stale") break;
      if (result._sessionLimit) break;
    }

    const sessionLimitResult = urlResults.find(r => r._sessionLimit);
    if (sessionLimitResult) {
      const output = mergeResults(urlResults);
      writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");
      return { signal: "session-limit", resetsAt: null, finalMessage: `NEEDS_HUMAN_INPUT\nSession/weekly limit hit — resets ${sessionLimitResult._resetsAt ?? "unknown"}. Re-run after limit resets.`, turnCount: urlResults.length };
    }

    const output = mergeResults(urlResults);
    writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");

    if (output.authIssue) {
      const authResult = urlResults.find(r => r.status === "auth_needed" || r.status === "auth_stale");
      const msg = `NEEDS_HUMAN_INPUT\n${buildAuthBlockMessage(authResult)}`;
      return { signal: "needs-human", finalMessage: msg, turnCount: urlResults.length };
    }

    return { signal: "complete", finalMessage: "CYCLE_COMPLETE", turnCount: urlResults.length };
  }

  return { runSmokeOrchestration };
}
