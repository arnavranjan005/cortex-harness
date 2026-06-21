import { buildUrlCheckPrompt, mergeResults, buildAuthBlockMessage, profileStorageFile } from "../../src/engine/smoke-orchestrator.mjs";

describe("profileStorageFile", () => {
  test("returns correct path for name", () => {
    expect(profileStorageFile("admin")).toBe(".harness/smoke-auth-admin.json");
    expect(profileStorageFile("user")).toBe(".harness/smoke-auth-user.json");
  });
});

describe("buildUrlCheckPrompt", () => {
  test("includes the URL in the prompt", () => {
    const p = buildUrlCheckPrompt("/reports", "http://localhost:3000", []);
    expect(p).toContain("http://localhost:3000/reports");
    expect(p).toContain('"url":"/reports"');
  });

  test("lists profile MCP names when provided", () => {
    const p = buildUrlCheckPrompt("/admin", "http://localhost:3000", ["admin", "user"]);
    expect(p).toContain("mcp__playwright-admin__*");
    expect(p).toContain("mcp__playwright-user__*");
  });

  test("handles no profiles", () => {
    const p = buildUrlCheckPrompt("/login", "http://localhost:3000", []);
    expect(p).not.toContain("mcp__playwright-");
  });

  test("isDynamic adds the placeholder-ID exception to both render check and network check", () => {
    const p = buildUrlCheckPrompt("/invoices/1", "http://localhost:3000", [], null, true);
    expect(p).toContain("NOT a failure — a deliberately designed \"not found\" state");
    expect(p).toContain("own placeholder\n    record");
  });

  test("non-dynamic prompt omits the placeholder-ID exception", () => {
    const p = buildUrlCheckPrompt("/reports", "http://localhost:3000", [], null, false);
    expect(p).not.toContain("NOT a failure — a deliberately designed \"not found\" state");
    expect(p).not.toContain("own placeholder\n    record");
  });
});

describe("mergeResults", () => {
  const passing = { url: "/reports", profile: "user", status: "pass",
    pageRenderOk: true, pageError: null,
    apiCalls: [{ url: "/api/reports", method: "GET", status: 200 }],
    consoleErrors: [], issues: [], staleProfiles: [] };

  const failing = { url: "/invoices", profile: "user", status: "fail",
    pageRenderOk: false, pageError: "500 Internal Server Error",
    apiCalls: [{ url: "/api/invoices", method: "GET", status: 500 }],
    consoleErrors: ["TypeError: Cannot read properties of undefined"],
    issues: ["API GET /api/invoices returned 500", "TypeError: Cannot read properties of undefined"],
    staleProfiles: [] };

  test("passed: true when all pages pass", () => {
    const r = mergeResults([passing]);
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
    expect(r.pagesChecked).toHaveLength(1);
  });

  test("passed: false with rich failure data when page fails", () => {
    const r = mergeResults([passing, failing]);
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].url).toBe("/invoices");
    expect(r.failures[0].apiFailures).toHaveLength(1);
    expect(r.failures[0].apiFailures[0].status).toBe(500);
    expect(r.failures[0].consoleErrors).toHaveLength(1);
    expect(r.failures[0].issues.some(i => i.includes("500"))).toBe(true);
  });

  test("merges apiCallsChecked across all pages", () => {
    const r = mergeResults([passing, failing]);
    expect(r.apiCallsChecked).toHaveLength(2);
  });

  test("merges consoleErrors across all pages", () => {
    const r = mergeResults([passing, failing]);
    expect(r.consoleErrors).toHaveLength(1);
    expect(r.consoleErrors[0]).toContain("TypeError");
  });

  test("uses LLM-provided failedSurfaces when present, even if it disagrees with the heuristic", () => {
    const r = mergeResults([passing, { ...failing, failedSurfaces: ["infra"] }]);
    expect(r.failures[0].failedSurfaces).toEqual(["infra"]);
    expect(r.failedSurfaces).toEqual(["infra"]);
  });

  test("falls back to inferring frontend+backend when LLM omits failedSurfaces", () => {
    const r = mergeResults([passing, failing]); // `failing` has no failedSurfaces field
    expect(r.failures[0].failedSurfaces.sort()).toEqual(["backend", "frontend"]);
    expect(r.failedSurfaces.sort()).toEqual(["backend", "frontend"]);
  });

  test("falls back to inferring backend only when render passed but an API 4xx/5xx occurred", () => {
    const backendOnly = { url: "/clients", profile: "user", status: "fail",
      pageRenderOk: true, pageError: null,
      apiCalls: [{ url: "/api/clients", method: "GET", status: 404 }],
      consoleErrors: [], issues: ["API GET /api/clients returned 404"], staleProfiles: [] };
    const r = mergeResults([backendOnly]);
    expect(r.failures[0].failedSurfaces).toEqual(["backend"]);
  });

  test("falls back to inferring frontend for a console/render issue even when pageRenderOk is true", () => {
    // Broken image / stuck spinner / console TypeError can fail a page (status: "fail")
    // without pageRenderOk ever being set false — must not be missed as unclassified.
    const consoleOnlyFail = { url: "/dashboard", profile: "user", status: "fail",
      pageRenderOk: true, pageError: null, apiCalls: [],
      consoleErrors: ["TypeError: Cannot read properties of undefined"],
      issues: ["TypeError: Cannot read properties of undefined"], staleProfiles: [] };
    const r = mergeResults([consoleOnlyFail]);
    expect(r.failures[0].failedSurfaces).toEqual(["frontend"]);
  });

  test("falls back to inferring infra from a CORS issue when failedSurfaces is omitted", () => {
    const corsFail = { url: "/reports", profile: "user", status: "fail",
      pageRenderOk: true, pageError: null, apiCalls: [],
      consoleErrors: [], issues: ["CORS error on GET /api/reports"], staleProfiles: [] };
    const r = mergeResults([corsFail]);
    expect(r.failures[0].failedSurfaces).toEqual(["infra"]);
  });

  test("auth_needed result produces authIssue: missing", () => {
    const authNeeded = { url: "/reports", status: "auth_needed", profile: null,
      pageRenderOk: false, pageError: null, apiCalls: [], consoleErrors: [],
      issues: [], staleProfiles: [], missingProfiles: [] };
    const r = mergeResults([authNeeded]);
    expect(r.passed).toBe(false);
    expect(r.authIssue).toBe("missing");
    expect(r.affectedPages).toContain("/reports");
    expect(r.pagesChecked).toHaveLength(0);
  });

  test("auth_stale result produces authIssue: stale", () => {
    const authStale = { url: "/admin", status: "auth_stale", profile: null,
      pageRenderOk: false, pageError: null, apiCalls: [], consoleErrors: [],
      issues: [], staleProfiles: ["admin"] };
    const r = mergeResults([authStale]);
    expect(r.authIssue).toBe("stale");
    expect(r.staleProfiles).toContain("admin");
  });

  test("stops at auth block — pages after auth block not in pagesChecked", () => {
    const r = mergeResults([{ url: "/reports", status: "auth_needed", profile: null,
      pageRenderOk: false, pageError: null, apiCalls: [], consoleErrors: [],
      issues: [], staleProfiles: [] }]);
    expect(r.pagesChecked).toHaveLength(0);
  });
});

describe("buildAuthBlockMessage", () => {
  test("auth_needed with no profiles", () => {
    const msg = buildAuthBlockMessage({ status: "auth_needed", missingProfiles: [] });
    expect(msg).toContain("cortex-harness auth");
    expect(msg).toContain("cortex-harness resume");
    expect(msg).not.toContain("--profile");
  });

  test("auth_needed with named profiles", () => {
    const msg = buildAuthBlockMessage({ status: "auth_needed", missingProfiles: ["admin", "user"] });
    expect(msg).toContain("--profile admin");
    expect(msg).toContain("--profile user");
  });

  test("auth_stale", () => {
    const msg = buildAuthBlockMessage({ status: "auth_stale", staleProfiles: ["admin"] });
    expect(msg).toContain("Re-run");
    expect(msg).toContain("--profile admin");
  });
});
