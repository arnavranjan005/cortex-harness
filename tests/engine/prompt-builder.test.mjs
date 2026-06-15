import { annotateError, annotateApiStatus, buildSmokeDiagnostic } from "../../src/engine/prompt-builder.mjs";

// ── annotateError ─────────────────────────────────────────────────────────────

describe("annotateError", () => {
  test("returns null/undefined hint for TypeError", () => {
    expect(annotateError("TypeError: Cannot read properties of undefined")).toContain("null/undefined");
  });

  test("returns imports hint for ReferenceError", () => {
    expect(annotateError("ReferenceError: foo is not defined")).toContain("imports");
  });

  test("returns chunk hint for ChunkLoadError", () => {
    expect(annotateError("ChunkLoadError: Loading chunk 3 failed")).toContain("chunk");
  });

  test("returns chunk hint for Failed to load resource", () => {
    expect(annotateError("Failed to load resource: the server responded with a status of 404")).toContain("chunk");
  });

  test("returns hydration hint for hydration error (capital H)", () => {
    expect(annotateError("Error: Hydration failed because the initial UI does not match")).toContain("hydration");
  });

  test("returns hydration hint for lowercase hydration error", () => {
    expect(annotateError("hydration mismatch detected")).toContain("hydration");
  });

  test("returns missing module hint", () => {
    expect(annotateError("Module not found: can't resolve './foo'")).toContain("import path");
  });

  test("returns async hint for unhandled promise rejection", () => {
    expect(annotateError("Unhandled promise rejection: network error")).toContain("async");
  });

  test("returns null for unknown error", () => {
    expect(annotateError("some generic error message")).toBeNull();
  });
});

// ── annotateApiStatus ─────────────────────────────────────────────────────────

describe("annotateApiStatus", () => {
  test("5xx → backend/out-of-scope hint", () => {
    expect(annotateApiStatus(500)).toContain("out of scope");
    expect(annotateApiStatus(503)).toContain("out of scope");
  });

  test("404 → route not found hint", () => {
    expect(annotateApiStatus(404)).toContain("route not found");
  });

  test("401 → auth hint", () => {
    expect(annotateApiStatus(401)).toContain("auth");
  });

  test("403 → auth hint", () => {
    expect(annotateApiStatus(403)).toContain("auth");
  });

  test("400 → bad request hint", () => {
    expect(annotateApiStatus(400)).toContain("payload");
  });

  test("connection-error → backend not reachable hint", () => {
    expect(annotateApiStatus("connection-error")).toContain("ECONNREFUSED");
  });

  test("200 → returns null (no hint needed)", () => {
    expect(annotateApiStatus(200)).toBeNull();
  });
});

// ── buildSmokeDiagnostic ──────────────────────────────────────────────────────

describe("buildSmokeDiagnostic", () => {
  test("returns empty string for invalid JSON", () => {
    expect(buildSmokeDiagnostic("not-json")).toBe("");
  });

  test("returns skipped message when skipped: true", () => {
    const out = buildSmokeDiagnostic(JSON.stringify({ skipped: true }));
    expect(out).toContain("skipped");
    expect(out).toContain("Smoke");
  });

  test("returns auth message with profiles when authIssue present", () => {
    const out = buildSmokeDiagnostic(JSON.stringify({
      authIssue: "cookie expired",
      staleProfiles: ["admin", "viewer"],
    }));
    expect(out).toContain("cookie expired");
    expect(out).toContain("admin");
    expect(out).toContain("viewer");
  });

  test("shows all-pass summary when no failures", () => {
    const report = {
      pagesChecked: [{ url: "/reports", status: "pass", issues: [] }],
      failures: [],
      apiCallCount: 2,
      runtimeChecks: {},
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("PASS: /reports");
    expect(out).toContain("all pages passed");
    expect(out).toContain("API calls total: 2");
  });

  test("shows FAIL section for failing page with render error", () => {
    const report = {
      pagesChecked: [{
        url: "/invoices",
        status: "fail",
        pageError: "500 Internal Server Error",
        renderSummary: { headingCount: 0, navPresent: false, mainPresent: false, stuckSpinner: true },
        consoleErrors: [],
        apiCalls: [],
        issues: ["render failed"],
      }],
      failures: [{ url: "/invoices", issue: "render failed" }],
      runtimeChecks: {},
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("FAIL: /invoices");
    expect(out).toContain("500 Internal Server Error");
    expect(out).toContain("headings=0");
    expect(out).toContain("spinner=true");
  });

  test("annotates console errors with hints for failed page", () => {
    const report = {
      pagesChecked: [{
        url: "/dashboard",
        status: "fail",
        consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'map')"],
        apiCalls: [],
        issues: [],
      }],
      failures: [{ url: "/dashboard" }],
      runtimeChecks: {},
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("TypeError");
    expect(out).toContain("null/undefined");
  });

  test("shows API calls with status annotations for failed page", () => {
    const report = {
      pagesChecked: [{
        url: "/reports",
        status: "fail",
        consoleErrors: [],
        apiCalls: [{ method: "GET", url: "/api/reports", status: 500 }],
        apiFailures: [{ method: "GET", url: "/api/reports", status: 500 }],
        issues: [],
      }],
      failures: [{ url: "/reports" }],
      runtimeChecks: {},
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("/api/reports");
    expect(out).toContain("500");
    expect(out).toContain("out of scope");
  });

  test("shows full per-page data for PASSING pages too — not filtered out", () => {
    const report = {
      pagesChecked: [{
        url: "/settings",
        status: "pass",
        consoleErrors: ["TypeError: foo is undefined"],
        apiCalls: [{ method: "GET", url: "/api/settings", status: 200 }],
        issues: [],
      }],
      failures: [],
      runtimeChecks: {
        "/settings": { swState: "unregistered", notificationPermission: "default", pushSupported: true, pageHasContent: true },
      },
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("PASS: /settings");
    expect(out).toContain("TypeError: foo is undefined");
    expect(out).toContain("/api/settings");
    expect(out).toContain("SW not registered");
  });

  test("emits runtime checks from runtimeChecks map for any page", () => {
    const report = {
      pagesChecked: [{ url: "/home", status: "pass", consoleErrors: [], apiCalls: [], issues: [] }],
      failures: [],
      runtimeChecks: {
        "/home": {
          pageHasContent: false,
          nextjsErrorOverlay: true,
          brokenImages: ["/img/logo.png"],
          swState: "error",
          appErrorCount: 2,
        },
      },
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("Page body empty");
    expect(out).toContain("Next.js error overlay");
    expect(out).toContain("/img/logo.png");
    expect(out).toContain("SW threw during registration");
    expect(out).toContain("2 global error");
  });

  test("shows global console warnings section", () => {
    const report = {
      pagesChecked: [{ url: "/", status: "pass", consoleErrors: [], apiCalls: [], issues: [] }],
      failures: [],
      runtimeChecks: {},
      consoleWarnings: ["Warning: Each child in a list should have a unique key"],
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("Console warnings");
    expect(out).toContain("unique key");
  });

  test("shows per-page consoleWarnings inline when present on page object", () => {
    const report = {
      pagesChecked: [{
        url: "/dashboard",
        status: "pass",
        consoleErrors: [],
        consoleWarnings: ["Warning: componentWillMount is deprecated"],
        apiCalls: [],
        issues: [],
      }],
      failures: [],
      runtimeChecks: {},
      consoleWarnings: [],
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("ConsoleWarn: Warning: componentWillMount");
  });

  test("shows connection errors separately from page failures", () => {
    const report = {
      pagesChecked: [{ url: "/", status: "pass", consoleErrors: [], apiCalls: [], issues: [] }],
      failures: [],
      runtimeChecks: {},
      apiCallsChecked: [
        { method: "GET", url: "/api/health", status: 200 },
        { method: "GET", url: "/api/push", status: "connection-error" },
      ],
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("connection error");
    expect(out).toContain("/api/push");
    expect(out).not.toContain("FAIL: /");
  });

  test("shows orphan console errors not attributed to any page", () => {
    const report = {
      pagesChecked: [{ url: "/", status: "pass", consoleErrors: ["Error A"], apiCalls: [], issues: [] }],
      failures: [],
      runtimeChecks: {},
      consoleErrors: ["Error A", "Error B — not on any page"],
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("Error B — not on any page");
    expect(out).toContain("not attributed");
  });

  test("shows screenshotPath when present on page", () => {
    const report = {
      pagesChecked: [{
        url: "/broken",
        status: "fail",
        consoleErrors: [],
        apiCalls: [],
        issues: [],
        screenshotPath: ".harness/smoke-broken-fail.png",
      }],
      failures: [{ url: "/broken" }],
      runtimeChecks: {},
    };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain(".harness/smoke-broken-fail.png");
  });

  test("includes scope guidance section", () => {
    const report = { pagesChecked: [], failures: [], runtimeChecks: {} };
    const out = buildSmokeDiagnostic(JSON.stringify(report));
    expect(out).toContain("Scope:");
    expect(out).toContain("frontend");
    expect(out).toContain("backend");
  });
});
