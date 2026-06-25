import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import chalk from "chalk";
import { startDevServer, killProc } from "./process-utils.mjs";
import { isWindows } from "./constants.mjs";
import { claudeAdapter } from "./cli-adapters/claude-adapter.mjs";
import { normalizeAdapterOutput, diagnoseProviderFailure } from "./cli-adapters/output-normalize.mjs";
import { parseLenientJson } from "./cli-adapters/lenient-json.mjs";
import { logger } from "../logger.mjs";
import { CYCLE_SIGNAL } from "./cycle-signal.mjs";

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function profileStorageFile(name) {
  return `.harness/smoke-auth-${name}.json`;
}

export function buildUrlCheckPrompt(url, devServerUrl, profileMcpNames, priorContext = null, isDynamic = false, adapter = claudeAdapter) {
  const hasProfiles = profileMcpNames.length > 0;
  const profileSessionLines = hasProfiles
    ? profileMcpNames.map(n => `  ${adapter.mcpServerWildcard(`playwright-${n}`)} → ${n} profile`).join("\n")
    : "";

  const authStaleJson = `{"url":"${url}","profile":null,"status":"auth_stale","staleProfiles":[<names tried>],"pageRenderOk":false,"pageError":null,"renderSummary":null,"apiCalls":[],"apiCallCount":0,"consoleErrors":[],"consoleWarnings":[],"runtimeChecks":null,"issues":[],"screenshotPath":null}`;
  const authNeededJson = `{"url":"${url}","profile":null,"status":"auth_needed","pageRenderOk":false,"pageError":null,"renderSummary":null,"apiCalls":[],"apiCallCount":0,"consoleErrors":[],"consoleWarnings":[],"runtimeChecks":null,"issues":[],"screenshotPath":null}`;

  const profileTryBlock = hasProfiles
    ? profileMcpNames.map((n, i) =>
        `    ${i + 1}. ${adapter.mcpToolName(`playwright-${n}`, "browser_navigate")} → ${devServerUrl}${url}`
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
  ${adapter.mcpServerWildcard("playwright")}  → UNAUTHENTICATED probe — no stored credentials, always starts logged out
${profileSessionLines || "  (no auth profiles — protected pages will return auth_needed)"}

━━━ STEP 1 — Classify page & select session ━━━━━━━━━━━━━━━━━━━━━━

${adapter.mcpServerWildcard("playwright")} has NO stored credentials. Always use it first to determine
whether this page requires authentication before doing any other checks.

  1a) Navigate with the unauthenticated probe:
      ${adapter.mcpToolName("playwright", "browser_navigate")} → ${devServerUrl}${url}

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
    → Use ${adapter.mcpServerWildcard("playwright")} for ALL remaining steps (STEPS 2–8)
    → Set profile: "public"

${protectedBlock}

━━━ STEP 2 — Wait for stable state (browser_wait_for) ━━━━━━━━━━━━
Wait up to 8 seconds for the page to finish loading before any checks:
  - Wait for selector "body" to be visible
  - If a loading spinner or skeleton is present (aria-label containing "loading", or role="progressbar"), wait for it to disappear (timeout 5s — do not fail if it persists)
  - Run browser_evaluate: document.readyState — if not "complete", wait 2 more seconds then continue regardless

━━━ STEP 3 — Render check (browser_snapshot) ━━━━━━━━━━━━━━━━━━━━━
Take a full accessibility tree snapshot. Analyze its content:
${isDynamic ? `
  THIS URL HAS A DYNAMIC SEGMENT (e.g. "[id]") FILLED WITH A PLACEHOLDER VALUE —
  it may not correspond to a real record in this environment's data. A "not found"
  state here can be EITHER (a) the app correctly handling a missing record, which
  is a PASS, or (b) a real crash, which is still a FAIL. Distinguish them:

  Still a hard failure — set pageRenderOk: false, record text in pageError, add to issues[]:
  - Visible text contains: "500", "Internal Server Error", "Something went wrong",
    "ChunkLoadError", "Unexpected token", "Application error", a raw stack trace,
    or any framework crash/error overlay (Next.js error overlay, unhandled exception)
  - An error boundary is rendered (role=alert with error/exception content)
  - Body content is completely blank (no meaningful nodes beyond html/body/head)

  NOT a failure — a deliberately designed "not found" state for this record:
  - Visible text contains "404" / "Not Found" / "No results" / "doesn't exist" etc.,
    BUT the page still renders normal app chrome (nav/header/layout present, no
    stack trace, no error overlay) — i.e. the app's own not-found UI rendered cleanly.
  - Record this in renderSummary.notFoundState: true and set pageRenderOk: true.
    Do NOT add it to issues[]. This confirms the route's not-found handling works.
` : `
  Hard failures — set pageRenderOk: false, record text in pageError, add to issues[]:
  - Visible text contains any of: "404", "Not Found", "500", "Internal Server Error",
    "Something went wrong", "ChunkLoadError", "Unexpected token", "Application error"
  - An error boundary is rendered (role=alert with error content, or Next.js error overlay)
  - Body content is completely blank (no meaningful nodes beyond html/body/head)
`}
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
${isDynamic ? `  - A 4xx (typically 404) on the request that fetches THIS page's own placeholder
    record (e.g. GET /invoices/1 when the URL is /invoices/1) — same reasoning as
    STEP 3: the ID is a placeholder, not guaranteed to exist. Still record it in
    apiCalls[] with its real status, just don't add it to issues[].
    This exception applies ONLY to the page's own primary record fetch — a 4xx/5xx
    on any OTHER endpoint (e.g. a sibling list, a different resource, an unrelated
    API) is still a real issue and must be added to issues[] as usual.
    Apply consistently: this exact rule applies to every dynamic-route page, not
    just some of them — do not flag one placeholder-ID 404 while waving off another.` : ""}

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

━━━ STEP 7 — Classify failing surface(s) (failedSurfaces) ━━━━━━━━
Only if issues[] is non-empty. For EACH issue, decide which agent owns the fix —
you have full context (status codes, console text, CORS detection) that a later
heuristic over this JSON would not have, so classify now, not after the fact:

  "frontend" — render/hydration errors, console JS errors (TypeError, ReferenceError,
    hydration mismatch), broken images, missing/empty headings, stuck spinner,
    service worker registration errors, Next.js/Nuxt error overlays.

  "backend" — API 4xx/5xx from your own app's routes (not third-party), DB/auth
    logic errors surfaced through an API response.

  "infra" — CORS errors ("CORS error on <METHOD> <path>"), status 0 with no CORS
    message but also no normal explanation, connection-refused that persists across
    retries (not just a dev server that hasn't started yet), env/config-looking
    failures (missing API base URL, wrong port).

  One issue can map to more than one surface only if it genuinely spans both —
  default to the single most accurate owner. Put every surface that owns at least
  one issue on this page into failedSurfaces (dedup, lowercase, e.g. ["frontend"]
  or ["backend","infra"]). Leave failedSurfaces: [] if issues[] is empty.

━━━ STEP 8 — Screenshot on failure (browser_take_screenshot) ━━━━━
Only if issues[] is non-empty after all steps above:
  Take a screenshot. Record the file path returned by the tool in screenshotPath.
  If no issues, set screenshotPath: null.

━━━ STEP 9 — Close browser (browser_close) ━━━━━━━━━━━━━━━━━━━━━━━
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
    "stuckSpinner": false,
    "notFoundState": false
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
  "failedSurfaces": [],
  "screenshotPath": null,
  "staleProfiles": []
}

status = "fail" if pageRenderOk is false OR issues[] is non-empty.
status = "pass" if all checks passed with no issues.`;

  // Prepend prior-run context block for retry smoke cycles.
  // Full chronological history is sent raw (smoke attempt N → fix N → smoke attempt N+1 …).
  // No programmatic filtering — the agent extracts what applies to THIS url.
  if (priorContext) {
    const { smokeAttempts = [], fixReports = [] } = priorContext;

    // Build interleaved history: for each smoke attempt, follow with the fix reports
    // that share the same attempt number, then move to the next smoke attempt.
    const maxAttempt = smokeAttempts.length;
    const historyLines = [];
    for (let n = 1; n <= maxAttempt; n++) {
      const sa = smokeAttempts.find(s => s._attempt === n);
      if (sa) {
        const { _attempt, _file, ...saData } = sa;
        historyLines.push(`### Smoke Attempt ${n} (${_file}):\n\`\`\`json\n${JSON.stringify(saData, null, 2)}\n\`\`\``);
      }
      // Fix reports whose filename contains -smoke-attempt-N
      const fixes = fixReports.filter(f => {
        const m = (f._file ?? "").match(/-smoke-attempt-(\d+)/);
        return m && parseInt(m[1]) === n;
      });
      for (const fix of fixes) {
        const { _file, ...fixData } = fix;
        historyLines.push(`### Fix After Smoke Attempt ${n} (${_file}):\n\`\`\`json\n${JSON.stringify(fixData, null, 2)}\n\`\`\``);
      }
    }

    const priorBlock = `
━━━ FULL PRIOR HISTORY (THIS IS A RETRY SMOKE CHECK) ━━━━━━━━━━━━

YOU ARE RETRYING A SMOKE CHECK. Below is the complete chronological history
of every smoke attempt and every fix cycle run before this retry.

YOUR TASK FOR THIS INVOCATION:
  Check URL: ${url}
  1. Read the full history below from top to bottom to understand what has
     been tried. Find all entries relevant to "${url}".
  2. For each fix cycle: check fixed[] — those issues should now be resolved.
     Verify against what you actually observe on the page now, not just the report's word.
  3. For any outOfScopeIssues in any fix report — "out of scope" means a DIFFERENT
     agent owns the fix, NOT that the issue is resolved or not real:
       a) Check every LATER fix report's fixed[] (later = higher attempt number, or
          same attempt number but a different surface's report that appears AFTER
          the outOfScopeIssues entry in the chronological history below).
       b) If a later fixed[] entry clearly addresses that exact issue → treat it as
          resolved. Verify it yourself against the live page; only then omit it from
          issues[] and do not fail the page for it.
       c) If NO later fix report's fixed[] addresses it → it is still an unresolved
          real defect, just owned by someone else. Add it to issues[] and FAIL the
          page for it like any other issue. Do not mark "pass" just because some
          fix report once called it out-of-scope.
  4. All URLs other than ${url} are shown only as context. You are
     responsible for ${url} ONLY.

## Chronological History (oldest first):

${historyLines.join("\n\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    return (priorBlock + body).trim();
  }

  return body;
}

/**
 * Code-side safety net for failedSurfaces — runs only when the LLM left it empty.
 * The LLM classifies first because it has full context (status codes, console text,
 * CORS detection) that this heuristic can't see; this just guarantees a failure is
 * never silently unclassified ("unknown") if the agent forgot or returned malformed JSON.
 *
 * Uses overall `status` rather than `pageRenderOk` — pageRenderOk only reflects the
 * STEP 3 hard-crash/blank-page check, so a page can fail (status: "fail") from
 * broken images, a stuck spinner, or a console TypeError (STEP 4/6) while
 * pageRenderOk stays true. Gating on pageRenderOk alone would miss those as frontend.
 */
function inferFallbackSurfaces({ status, apiFailures, issues }) {
  const surfaces = new Set();
  const allIssues = issues ?? [];
  const corsIssues = allIssues.filter(i => /^CORS error/.test(i));
  if (apiFailures.length) surfaces.add("backend");
  if (corsIssues.length) surfaces.add("infra");

  // Any issue not already explained by an API failure or CORS is a frontend symptom
  // (render text, broken images, stuck spinner, console errors) — and if nothing
  // explains the failure at all (e.g. a blank-page crash with no issues[] text),
  // frontend is still the right default home for a render-level failure.
  const explained = apiFailures.length + corsIssues.length;
  if (status === "fail" && (allIssues.length > explained || surfaces.size === 0)) {
    surfaces.add("frontend");
  }
  return [...surfaces];
}

export function mergeResults(urlResults) {
  const authBlock = urlResults.find(r => r.status === "auth_needed" || r.status === "auth_stale");
  if (authBlock) {
    return {
      passed: false,
      skipped: false,
      authIssue: authBlock.status === "auth_needed" ? "missing" : "stale",
      missingProfiles: authBlock.status === "auth_needed" ? (authBlock.missingProfiles ?? []) : undefined,
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
    .map(r => {
      const apiFailures = (r.apiCalls ?? []).filter(a => typeof a.status === "number" && a.status >= 400);
      const issues = r.issues ?? [];
      const llmSurfaces = r.failedSurfaces ?? [];
      const failedSurfaces = llmSurfaces.length
        ? llmSurfaces
        : inferFallbackSurfaces({ status: r.status, apiFailures, issues });
      return {
        url: r.url,
        pageError: r.pageError ?? null,
        renderSummary: r.renderSummary ?? null,
        apiFailures,
        consoleErrors: r.consoleErrors ?? [],
        screenshotPath: r.screenshotPath ?? null,
        issues,
        failedSurfaces,
      };
    });

  const runtimeChecks = {};
  for (const r of urlResults) {
    if (r.runtimeChecks) runtimeChecks[r.url] = r.runtimeChecks;
  }

  const failedSurfaces = [...new Set(failures.flatMap(f => f.failedSurfaces ?? []))];

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
    failedSurfaces,
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
  config, adapter = claudeAdapter, appendLog,
  buildFilteredMcpServers,
}) {
  // Returns only the playwright-<name> auth-profile server entries — never
  // merged with anything here, so callers can choose how to combine them:
  // Claude merges them straight into the in-memory mcpServers object passed
  // to --mcp-config; OpenCode passes them as buildScopedConfig's
  // additionalServers, since they're never written to .mcp.json on disk
  // (the args, particularly --storage-state, differ per profile/per check).
  // --storage-state is a flag on the Playwright MCP server binary itself
  // (confirmed via `npx @playwright/mcp@latest --help`), not a Claude/OpenCode
  // CLI flag — this mechanism is inherently CLI-agnostic, same servers work
  // under either adapter once correctly wired into its MCP config format.
  function buildAuthProfileServers(filteredServers) {
    const profiles = (config.authProfiles ?? []).filter(p =>
      p?.name && p?.storageFile && existsSync(join(ROOT, p.storageFile))
    );
    if (!profiles.length) return {};

    const basePw = filteredServers?.playwright ?? { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] };
    const servers = {};
    for (const p of profiles) {
      servers[`playwright-${p.name}`] = {
        ...basePw,
        args: [
          ...(basePw.args ?? []).filter(a => !String(a).startsWith("--storage-state") && a !== "--isolated"),
          // --isolated is required for --storage-state to actually apply —
          // confirmed live: without it, the server uses a persistent on-disk
          // browser profile that ignores storage-state after first launch.
          // This was a real, previously-unverified bug — auth profiles never
          // actually loaded the saved session without this flag.
          "--isolated",
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

  // Per-URL wall-clock timeout before killing the sub-process. OpenCode needs
  // more headroom than Claude by default — confirmed live: its build agent
  // (e.g. deepseek-v4-flash-free) routinely takes 12+ tool-call loop steps to
  // finish a single page check, well past 90s, with zero actual errors — it's
  // just slower per turn, not stuck. Claude's smoke checks finish comfortably
  // within 90s in the same project. Configurable via harness.config.json
  // smokeCheckTimeoutMs so this can be tuned per-project without a code change.
  const DEFAULT_SMOKE_CHECK_TIMEOUT_MS = adapter.name === "opencode" ? 180_000 : 90_000;
  const smokeCheckTimeoutMs = config.smokeCheckTimeoutMs ?? DEFAULT_SMOKE_CHECK_TIMEOUT_MS;

  // Always resolves to a single plain-text string regardless of adapter, so
  // every caller below (JSON extraction, session-limit text matching) stays
  // unchanged for both adapters. Claude's --output-format text already gives
  // plain text; OpenCode's --format json gives an event stream, so its
  // "assistant" text events are accumulated into one string here instead.
  // Resolves { text, failure } — failure is a ProviderFailure (see
  // diagnoseProviderFailure in output-normalize.mjs) when the call hard-failed
  // on billing/session-limit, null otherwise. Checked structurally first (any
  // json-stream adapter), with raw-text matching as fallback for "text"-format
  // adapters (Claude's smoke-check mode has no structured events at all).
  async function spawnMiniSession(prompt, mcpConfigPath) {
    return new Promise((resolve) => {
      let rawOutput = "";
      let rawStderr = "";
      const timeout = setTimeout(() => {
        try { killProc(proc); } catch {}
        // Keep whatever stdout/stderr had accumulated before the kill — otherwise
        // a timeout leaves zero diagnostic trail beyond "smoke check timed out",
        // making it impossible to tell a hung page load from a stuck MCP spawn.
        resolve({
          text: null,
          failure: {
            type: "timeout",
            message: (rawStderr || rawOutput || "(no output captured before timeout)").slice(-500),
          },
        });
      }, smokeCheckTimeoutMs);

      const promptFile = join(RUNS_DIR, `smoke-prompt-${Date.now()}.txt`);
      writeFileSync(promptFile, prompt, "utf8");

      const spawnPlan = adapter.buildSmokeCheckSpawnPlan({
        prompt,
        mcpConfigPath,
        isWindows,
        allowedToolPatterns: [
          adapter.mcpServerWildcard("playwright"),
          adapter.mcpServerWildcard("playwright-*"),
          "ToolSearch",
        ],
        maxTurns: 20,
        budgetUsd: perPageBudget,
        promptFile,
      });
      const spawnEnv = spawnPlan.env ? { ...process.env, ...spawnPlan.env } : undefined;

      let proc;
      let psFile = null;
      if (isWindows) {
        psFile = join(RUNS_DIR, `smoke-${Date.now()}.ps1`);
        writeFileSync(psFile, spawnPlan.psContent, "utf8");
        proc = spawn(
          spawnPlan.command,
          spawnPlan.args.map((a) => (a === "__PS_FILE__" ? psFile : a)),
          { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...(spawnEnv ? { env: spawnEnv } : {}) },
        );
      } else {
        proc = spawn(spawnPlan.command, spawnPlan.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], ...(spawnEnv ? { env: spawnEnv } : {}) });
      }

      proc.on("close", () => {
        try { unlinkSync(promptFile); if (psFile) unlinkSync(psFile); } catch {}
        clearTimeout(timeout);
        const failure = diagnoseProviderFailure(adapter, { rawStdout: rawOutput, rawStderr, outputFormat: spawnPlan.outputFormat });
        resolve({ text: normalizeAdapterOutput(adapter, rawOutput, spawnPlan.outputFormat), failure });
      });
      proc.stdout?.on("data", chunk => { rawOutput += chunk.toString("utf8"); });
      proc.stderr?.on("data", chunk => { rawStderr += chunk.toString("utf8"); });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ text: null, failure: { type: "spawn-error", message: err?.message ?? String(err) } });
      });
    });
  }

  async function checkOneUrl(url, devServerUrl, mcpServers, profileServers, profileMcpNames, missingConfiguredProfiles = [], priorContext = null, isDynamic = false) {
    let tmpMcp;
    if (adapter.capabilities.mcpScopeMechanism === "config-file" && adapter.buildScopedConfig) {
      tmpMcp = adapter.buildScopedConfig({
        ROOT,
        allowedServerNames: Object.keys(mcpServers),
        cycleId: `smoke-${Date.now()}`,
        tmpDir: HARNESS_DIR,
        additionalServers: profileServers,
      });
    } else {
      tmpMcp = join(HARNESS_DIR, `tmp-mcp-smoke-${Date.now()}.json`);
      writeFileSync(tmpMcp, JSON.stringify({ mcpServers }, null, 2), "utf8");
    }

    const prompt = buildUrlCheckPrompt(url, devServerUrl, profileMcpNames, priorContext, isDynamic, adapter);
    const { text: raw, failure } = await spawnMiniSession(prompt, tmpMcp);
    if (tmpMcp) { try { unlinkSync(tmpMcp); } catch {} }

    if (failure?.type === "billing") {
      const billingUrl = failure.message.match(/https:\/\/\S+/)?.[0] ?? null;
      return { url, profile: null, status: "billing-error", pageRenderOk: false,
               pageError: "payment method required", apiCalls: [], consoleErrors: [],
               issues: [`billing error: ${failure.message.slice(0, 200)}`],
               _billingError: true, _billingUrl: billingUrl, staleProfiles: [] };
    }

    // Detect session/weekly limit — structurally first, raw-text fallback for
    // "text"-format adapters (Claude's smoke-check mode) covers the case
    // diagnoseProviderFailure's text matching missed for any reason.
    if (failure?.type === "session-limit" || (raw && /session limit|weekly limit|usage limit/i.test(raw) && !raw.includes("{"))) {
      const resetsMatch = raw?.match(/resets\s+([^\n·•]+)/i);
      return { url, profile: null, status: "session-limit",
               pageError: "session limit hit", apiCalls: [], consoleErrors: [],
               issues: [`session limit: ${(failure?.message ?? raw ?? "").slice(0, 200)}`],
               _sessionLimit: true, _resetsAt: resetsMatch?.[1]?.trim() ?? null, staleProfiles: [] };
    }

    if (!raw) {
      const diag = failure?.type === "timeout" && failure.message
        ? `smoke check timed out — last output before kill: ${failure.message}`
        : failure?.type === "spawn-error"
        ? `smoke check failed to spawn: ${failure.message}`
        : "smoke check timed out";
      // _noSignal marks "the CLI sub-process produced nothing usable" (killed on
      // timeout, failed to spawn, or exited with empty output) — distinct from a
      // real render failure where the agent DID respond. The caller uses this to
      // detect a flaky CLI provider/model backend (several of these in a row)
      // instead of treating every page as an independent app bug to "fix".
      return { url, profile: null, status: "fail", pageRenderOk: false,
               pageError: "smoke check timed out", apiCalls: [], consoleErrors: [],
               issues: [diag], staleProfiles: [], _noSignal: true };
    }

    // Extract JSON from final message (LLM may add surrounding text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { url, profile: null, status: "fail", pageRenderOk: false,
               pageError: "smoke check returned non-JSON", apiCalls: [], consoleErrors: [],
               issues: [`smoke check returned non-JSON response: ${raw.slice(0, 200)}`], staleProfiles: [] };
    }

    try {
      const result = parseLenientJson(jsonMatch[0]);
      // auth_stale is only ever returned after every configured profile was tried
      // and all redirected to login (see protectedBlock above) — so the stale set
      // is always the full profile list, regardless of what name strings the model
      // echoed back in its JSON. Trust the known config names, not the model's text.
      if (result.status === "auth_stale") result.staleProfiles = profileMcpNames;
      // auth_needed fires when hasProfiles is false — either no profiles were ever
      // configured, or every configured profile's storage file went missing. Name
      // the latter case explicitly instead of letting it collapse into the generic
      // "no auth state found" message.
      if (result.status === "auth_needed" && missingConfiguredProfiles.length) {
        result.missingProfiles = missingConfiguredProfiles;
      }
      return result;
    } catch {
      return { url, profile: null, status: "fail", pageRenderOk: false,
               pageError: "invalid JSON from smoke check", apiCalls: [], consoleErrors: [],
               issues: ["smoke check returned invalid JSON"], staleProfiles: [] };
    }
  }

  async function runSmokeOrchestration(cycle, probeUrlsJson, devServerUrl, priorSmokeContext = null) {
    // A cycle only ever re-runs under the SAME id after blocking on auth/session-limit/
    // billing/provider-outage — real test failures are handled by injecting a NEW
    // smoke-retry-N cycle, never by re-running this one. So if the prior output for
    // this exact cycle was one of those blocks, this execution is the user re-running
    // after fixing the external issue, not a machine retry. Treat it as a fresh
    // attempt: wipe the stale output and any numbered snapshots so they don't
    // pollute future fix-retry history with an "attempt" that was never a real
    // test failure.
    try {
      const priorOutputPath = join(CYCLE_DIR, cycle.outputFile);
      const prior = JSON.parse(readFileSync(priorOutputPath, "utf8"));
      if (prior.authIssue || prior.providerOutage) {
        const sg = cycle.taskGroup;
        const smokeSuffix = sg ? `-${sg}` : "";
        const attemptPattern = new RegExp(`^smoke-attempt-\\d+${smokeSuffix}\\.json$`);
        for (const f of readdirSync(CYCLE_DIR)) {
          if (attemptPattern.test(f)) {
            try { unlinkSync(join(CYCLE_DIR, f)); } catch { /* best-effort cleanup */ }
          }
        }
        try { unlinkSync(priorOutputPath); } catch { /* already gone */ }
        appendLog({
          type: "smoke-orchestrator",
          event: "block-resume-reset",
          cycleId: cycle.id,
          reason: prior.authIssue ? "auth" : "provider-outage",
        });
      }
    } catch { /* no prior output for this cycle — nothing to clear */ }

    const { urls = [], layoutAffected = false, dynamicUrls = [] } = JSON.parse(probeUrlsJson);
    const dynamicUrlSet = new Set(dynamicUrls);

    if (!urls.length && !layoutAffected) {
      const output = { passed: true, skipped: true, reason: "no page files changed",
                       pagesChecked: [], apiCallsChecked: [], consoleErrors: [], failures: [] };
      writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");
      return { signal: CYCLE_SIGNAL.COMPLETE, finalMessage: "CYCLE_COMPLETE", turnCount: 0 };
    }

    const rawServers = buildFilteredMcpServers("smoke") ?? {};
    // --storage-state is a Playwright MCP server flag, not a Claude/OpenCode
    // CLI flag (confirmed via `npx @playwright/mcp@latest --help`) — auth
    // profiles work the same way under either adapter once the servers are
    // wired into that adapter's own MCP config format (see checkOneUrl).
    const profileServers = buildAuthProfileServers(rawServers);
    const mcpServers = { ...rawServers, ...profileServers };
    const profileMcpNames = Object.keys(profileServers)
      .filter(k => k.startsWith("playwright-"))
      .map(k => k.replace("playwright-", ""));

    // Profiles configured in harness.config.json whose storage-state file is
    // missing/deleted get silently dropped by buildAuthProfileServers (it only
    // wires up profiles whose file exists). Track them separately so an
    // auth_needed block can name the specific profile(s) to re-run `auth` for,
    // instead of collapsing "named profile lost its file" into the generic
    // "no profiles configured at all" message.
    const missingConfiguredProfiles = (config.authProfiles ?? [])
      .filter(p => p?.name && p?.storageFile)
      .map(p => p.name)
      .filter(name => !profileMcpNames.includes(name));

    appendLog({ type: "smoke-orchestrator", event: "start", urls, profileMcpNames,
      isRetry: !!priorSmokeContext });

    // Consecutive "no signal at all" results (timeout/spawn-error/empty output)
    // mean the CLI provider/model backend itself is failing, not that N
    // different pages all have real bugs — ploughing through all remaining
    // URLs at 90s each just burns time, and the normal fix-cycle injection
    // logic would wrongly try to "fix" pages that were never actually checked.
    const PROVIDER_NO_SIGNAL_THRESHOLD = 2;
    let consecutiveNoSignal = 0;
    let providerOutage = false;

    const urlResults = [];
    for (const url of urls) {
      const result = await checkOneUrl(url, devServerUrl, mcpServers, profileServers, profileMcpNames, missingConfiguredProfiles, priorSmokeContext, dynamicUrlSet.has(url));
      appendLog({ type: "smoke-orchestrator", event: "url-result", url, status: result.status });
      urlResults.push(result);
      const issueCount = result.issues?.length ?? 0;
      const statusColor = result.status === "pass" ? chalk.green : result.status === "auth_needed" || result.status === "auth_stale" ? chalk.yellow : chalk.red;
      logger.info(chalk.dim("[SMOKE]"), chalk.bold(url), "→", statusColor(result.status) + (issueCount ? chalk.dim(` (${issueCount} issue${issueCount > 1 ? "s" : ""})`) : ""));

      // Stop on first auth block, session limit, or billing error — no point checking remaining URLs
      if (result.status === "auth_needed" || result.status === "auth_stale") break;
      if (result._sessionLimit || result._billingError) break;

      consecutiveNoSignal = result._noSignal ? consecutiveNoSignal + 1 : 0;
      if (consecutiveNoSignal >= PROVIDER_NO_SIGNAL_THRESHOLD) {
        providerOutage = true;
        appendLog({ type: "smoke-orchestrator", event: "provider-outage-abort", url, consecutiveNoSignal });
        logger.info(chalk.red(`  [PROVIDER OUTAGE] ${consecutiveNoSignal} consecutive page(s) produced no output — stopping smoke check early.`));
        break;
      }
    }

    if (providerOutage) {
      // providerOutage flag lets the next run's stale-output check (see top of
      // this function) recognize a resume the same way it recognizes authIssue —
      // this wasn't a real test failure, so it shouldn't count as an "attempt".
      const output = { ...mergeResults(urlResults), providerOutage: true };
      writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");
      const msg = [
        "NEEDS_HUMAN_INPUT",
        `Smoke check got no output from the CLI provider on ${consecutiveNoSignal} consecutive page(s) — this looks like a model/provider`,
        "outage (e.g. repeated backend errors), not a real app bug. Checking each remaining page would just keep timing out.",
        "Check the CLI provider's own status/logs (e.g. OpenCode: ~/.local/share/opencode/log/opencode.log) before re-running.",
        "Then: cortex-harness resume",
      ].join("\n");
      return { signal: CYCLE_SIGNAL.NEEDS_HUMAN, finalMessage: msg, turnCount: urlResults.length };
    }

    const billingErrorResult = urlResults.find(r => r._billingError);
    if (billingErrorResult) {
      const output = mergeResults(urlResults);
      writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");
      const urlSuffix = billingErrorResult._billingUrl ? `\nAdd one here: ${billingErrorResult._billingUrl}` : "";
      return { signal: CYCLE_SIGNAL.BILLING_ERROR, finalMessage: `NEEDS_HUMAN_INPUT\nProvider rejected the call for lack of a payment method.${urlSuffix}`, turnCount: urlResults.length };
    }

    const sessionLimitResult = urlResults.find(r => r._sessionLimit);
    if (sessionLimitResult) {
      const output = mergeResults(urlResults);
      writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");
      return { signal: CYCLE_SIGNAL.SESSION_LIMIT, resetsAt: null, finalMessage: `NEEDS_HUMAN_INPUT\nSession/weekly limit hit — resets ${sessionLimitResult._resetsAt ?? "unknown"}. Re-run after limit resets.`, turnCount: urlResults.length };
    }

    const output = mergeResults(urlResults);
    writeFileSync(join(CYCLE_DIR, cycle.outputFile), JSON.stringify(output, null, 2), "utf8");

    // Save a numbered per-attempt snapshot so retry cycles have full history.
    // smoke-attempt-1.json = first run, smoke-attempt-2.json = first retry, etc.
    try {
      const sg = cycle.taskGroup;
      const smokeSuffix = sg ? `-${sg}` : "";
      const existing = readdirSync(CYCLE_DIR)
        .filter(f => new RegExp(`^smoke-attempt-\\d+${smokeSuffix}\.json$`).test(f)).length;
      const attemptN = existing + 1;
      const snapshotFile = `smoke-attempt-${attemptN}${smokeSuffix}.json`;
      writeFileSync(join(CYCLE_DIR, snapshotFile), JSON.stringify(output, null, 2), "utf8");
      appendLog({ type: "smoke-orchestrator", event: "attempt-snapshot", file: snapshotFile, attempt: attemptN });
    } catch { /* best-effort — snapshot failure must not break the run */ }

    if (output.authIssue) {
      const authResult = urlResults.find(r => r.status === "auth_needed" || r.status === "auth_stale");
      const msg = `NEEDS_HUMAN_INPUT\n${buildAuthBlockMessage(authResult)}`;
      return { signal: CYCLE_SIGNAL.NEEDS_HUMAN, finalMessage: msg, turnCount: urlResults.length };
    }

    return { signal: CYCLE_SIGNAL.COMPLETE, finalMessage: "CYCLE_COMPLETE", turnCount: urlResults.length };
  }

  return { runSmokeOrchestration };
}
